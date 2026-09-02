//! celestea-agent-loop — default turn/step driver (W104).
//!
//! DefaultAgentLoop implements the celestea_core::AgentLoop seam: it drives
//! one user turn by appending to the session log, looping over model steps,
//! dispatching tool calls through the registry, and writing the final
//! assistant message. All dependencies (llm, session, tools) are resolved
//! from the shared celestea_core::Context at turn start.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, ModelRequest,
    SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput, ToolRegistryService,
};
use futures_util::StreamExt;

/// The default agent loop: a stateless (modulo a turn counter) driver.
pub struct DefaultAgentLoop {
    config: AgentConfig,
    /// Monotonic turn id counter; keeps the loop Send + Sync while producing
    /// unique turn ids without any extra dependency.
    turn_id: AtomicU64,
}

impl DefaultAgentLoop {
    /// Build a loop from an AgentConfig.
    pub fn new(config: AgentConfig) -> Self {
        Self { config, turn_id: AtomicU64::new(0) }
    }

    /// Allocate the next unique turn id.
    fn next_turn_id(&self) -> String {
        let n = self.turn_id.fetch_add(1, Ordering::Relaxed);
        format!("turn-{}", n)
    }

    /// Print a streamed text delta to stdout and flush it so the UI updates
    /// incrementally. Printing must not fail the turn.
    fn print_delta(text: &str) {
        print!("{}", text);
        let _ = io::stdout().flush();
    }
}

#[async_trait]
impl AgentLoop for DefaultAgentLoop {
    async fn run_turn(&self, ctx: &Context, user_input: &str) -> Result<(), AgentError> {
        // Resolve required services from the context.
        let llm = ctx
            .get::<LlmService>()
            .ok_or_else(|| AgentError("missing LlmService in context".into()))?;
        let session = ctx
            .get::<SessionService>()
            .ok_or_else(|| AgentError("missing SessionService in context".into()))?;
        let registry = ctx
            .get::<ToolRegistryService>()
            .ok_or_else(|| AgentError("missing ToolRegistryService in context".into()))?;

        // Turn bookkeeping: the session log is the single source of truth.
        let turn_id = self.next_turn_id();
        session.append(SessionEvent::TurnStart { id: turn_id.clone() });
        session.append(SessionEvent::UserMessage { text: user_input.to_string() });

        for _step in 0..self.config.max_steps {
            // History is derived from the log, never stored separately.
            let messages = session.derive_messages();

            let request = ModelRequest {
                model: self.config.model.clone(),
                system: Some(self.config.system_prompt.clone()),
                messages,
                tools: registry.schemas(),
                max_tokens: None,
                temperature: None,
            };

            // Generate, then consume the stream: Text deltas go to stdout,
            // the final Done(message) is the authoritative assistant reply.
            let mut stream = llm
                .generate(request)
                .await
                .map_err(|e| AgentError(format!("llm.generate failed: {}", e)))?;

            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();

            while let Some(event) = stream.next().await {
                match event {
                    StreamEvent::Text(delta) => Self::print_delta(&delta),
                    StreamEvent::Done(message) => {
                        for content in message.content {
                            match content {
                                Content::Text(text) => assistant_text.push_str(&text),
                                Content::ToolCall(call) => tool_calls.push(call),
                            }
                        }
                    }
                }
            }

            if tool_calls.is_empty() {
                // Plain assistant reply ends the turn.
                session.append(SessionEvent::AssistantMessage { text: assistant_text });
                break;
            }

            // Tool-call step. Protocol ordering matters: every tool call in
            // this assistant turn belongs to a single assistant message, so
            // append ALL ToolCall events first, then dispatch and append each
            // ToolResult in turn. Interleaving ToolCall/ToolResult per call
            // would misrepresent the history to the model.
            for call in &tool_calls {
                session.append(SessionEvent::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    args: call.args.clone(),
                });
            }

            // Dispatch concurrently, bounded by max_parallel_tool_calls
            // (clamped to at least 1; a 0 limit means serial). join_all
            // resolves in input order, so ToolResult events are appended in
            // the model's original call order even though the calls run in
            // parallel — the log ordering stays deterministic.
            let limit = self.config.max_parallel_tool_calls.max(1);
            for batch in tool_calls.chunks(limit) {
                let outputs = futures_util::future::join_all(batch.iter().map(|call| {
                    registry.dispatch(ToolInput {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        args: call.args.clone(),
                    })
                }))
                .await;

                for output in outputs {
                    session.append(SessionEvent::ToolResult {
                        id: output.call_id,
                        value: output.value,
                        error: output.error,
                    });
                }
            }
        }

        session.append(SessionEvent::TurnEnd { id: turn_id });
        Ok(())
    }
}

// ============================================================================
// Unit tests: parallel tool dispatch and deterministic ToolResult ordering.
// ============================================================================

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use celestea_core::{
        Llm, LlmError, LlmStream, Message, Role, SessionLog, Tool, ToolGuard,
        ToolDecision, ToolOutput, ToolRegistry, ToolSpec,
    };
    use futures_util::stream;
    use serde_json::{json, Value};

    /// In-memory SessionLog: records every appended event so tests can assert
    /// the exact ToolCall/ToolResult ordering contract.
    #[derive(Default)]
    struct FakeSession {
        events: Mutex<Vec<SessionEvent>>,
    }

    impl FakeSession {
        fn all(&self) -> Vec<SessionEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl SessionLog for FakeSession {
        fn append(&self, event: SessionEvent) {
            self.events.lock().unwrap().push(event);
        }
        fn events(&self) -> Vec<SessionEvent> {
            self.all()
        }
        fn derive_messages(&self) -> Vec<Message> {
            // The fake Llm ignores the request, so an empty projection is fine.
            Vec::new()
        }
        fn clear(&self) {
            self.events.lock().unwrap().clear();
        }
    }

    /// Fake Llm that serves a queue of Done(Message) replies, one per
    /// generate() call. Once the queue is empty it replies with plain text so
    /// the agent loop terminates.
    struct FakeLlm {
        replies: Mutex<VecDeque<Message>>,
    }

    impl FakeLlm {
        fn new(replies: Vec<Message>) -> Self {
            Self { replies: Mutex::new(replies.into()) }
        }
    }

    #[async_trait]
    impl Llm for FakeLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Message::assistant_text("done"));
            Ok(stream::iter(vec![StreamEvent::Done(reply)]).boxed())
        }
    }

    /// Fake ToolRegistry that records the dispatch order and the maximum
    /// number of dispatches in flight simultaneously (proves concurrency and
    /// the batch bound without relying on wall-clock timing).
    #[derive(Default)]
    struct FakeRegistry {
        order: Mutex<Vec<String>>,
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    impl FakeRegistry {
        fn dispatch_order(&self) -> Vec<String> {
            self.order.lock().unwrap().clone()
        }
        fn max_active(&self) -> usize {
            self.max_active.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ToolRegistry for FakeRegistry {
        fn register(&mut self, _tool: Box<dyn Tool>) {}
        fn add_guard(&mut self, _guard: Box<dyn ToolGuard>) {}
        fn get(&self, _name: &str) -> Option<&dyn Tool> {
            None
        }
        fn schemas(&self) -> Vec<ToolSpec> {
            Vec::new()
        }
        async fn dispatch(&self, input: ToolInput) -> ToolOutput {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            self.order.lock().unwrap().push(input.call_id.clone());
            // Yield a few times so all peers in the batch get a chance to
            // start before any of them completes.
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            ToolOutput {
                call_id: input.call_id,
                value: Some(Value::Bool(true)),
                render: None,
                error: None,
                decision: Some(ToolDecision::Allow),
            }
        }
    }

    fn tool_call_message(ids: &[&str]) -> Message {
        let content = ids
            .iter()
            .map(|id| Content::ToolCall(ToolCall {
                id: id.to_string(),
                name: format!("tool_{}", id),
                args: json!({}),
            }))
            .collect();
        Message { role: Role::Assistant, content, tool_call_id: None }
    }

    fn run_turn(
        session: &Arc<FakeSession>,
        registry: &Arc<FakeRegistry>,
        replies: Vec<Message>,
        max_parallel_tool_calls: usize,
    ) {
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(FakeLlm::new(replies)));

        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);

        let config = AgentConfig {
            max_parallel_tool_calls,
            ..AgentConfig::default()
        };
        let loop_ = DefaultAgentLoop::new(config);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();
    }

    /// All ToolCall events must precede all ToolResult events in the log.
    fn assert_calls_precede_results(events: &[SessionEvent]) {
        let mut last_call = 0usize;
        let mut first_result = usize::MAX;
        for (i, e) in events.iter().enumerate() {
            match e {
                SessionEvent::ToolCall { .. } => last_call = i,
                SessionEvent::ToolResult { .. } => {
                    if first_result == usize::MAX {
                        first_result = i;
                    }
                }
                _ => {}
            }
        }
        assert!(first_result == usize::MAX || last_call < first_result);
    }

    /// Every ToolCall in the log, in order.
    fn logged_tool_calls(events: &[SessionEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolCall { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    /// Every ToolResult in the log, in order.
    fn logged_tool_results(events: &[SessionEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolResult { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn dispatches_all_tool_calls_with_deterministic_result_order() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());

        run_turn(
            &session,
            &registry,
            vec![tool_call_message(&["c1", "c2", "c3"]), Message::assistant_text("done")],
            4, // three calls fit in one batch
        );

        // Every tool call was dispatched, in model order.
        assert_eq!(registry.dispatch_order(), vec!["c1", "c2", "c3"]);

        let events = session.all();
        assert_calls_precede_results(&events);
        // ToolCall events and ToolResult events both follow the model order.
        assert_eq!(logged_tool_calls(&events), vec!["c1", "c2", "c3"]);
        assert_eq!(logged_tool_results(&events), vec!["c1", "c2", "c3"]);
    }

    #[test]
    fn batches_dispatch_concurrently_up_to_limit() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());

        // Five calls with a limit of two => batches [c1,c2] [c3,c4] [c5].
        run_turn(
            &session,
            &registry,
            vec![
                tool_call_message(&["c1", "c2", "c3", "c4", "c5"]),
                Message::assistant_text("done"),
            ],
            2,
        );

        // All dispatched; concurrency never exceeds the limit; and because
        // join_all resolves in input order, results land in model order.
        assert_eq!(registry.dispatch_order(), vec!["c1", "c2", "c3", "c4", "c5"]);
        assert_eq!(registry.max_active(), 2);

        let events = session.all();
        assert_calls_precede_results(&events);
        assert_eq!(logged_tool_results(&events), vec!["c1", "c2", "c3", "c4", "c5"]);
    }

    #[test]
    fn zero_max_parallel_clamps_to_serial() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());

        run_turn(
            &session,
            &registry,
            vec![tool_call_message(&["c1", "c2", "c3"]), Message::assistant_text("done")],
            0, // clamped to 1 => serial dispatch
        );

        assert_eq!(registry.dispatch_order(), vec!["c1", "c2", "c3"]);
        assert_eq!(registry.max_active(), 1);

        let events = session.all();
        assert_eq!(logged_tool_results(&events), vec!["c1", "c2", "c3"]);
    }
}

