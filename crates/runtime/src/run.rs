//! Cancellable, streaming turn execution (W214).
//!
//! The core of the deleted CLI's run_turn_interruptible / run_one_shot paths,
//! minus any signal/terminal behavior: [Runtime::run_turn] drives one user
//! turn through a per-turn [DefaultAgentLoop] with an optional cooperative
//! cancel signal (tokio::sync::watch) and an optional [EventSink] that
//! forwards Text/Thinking/ToolCall/ToolResult/Done events for streaming
//! consumption (web client: event-stream per turn).

use std::sync::Arc;

use celestea_agent_loop::{DefaultAgentLoop, EventSink};
use celestea_core::{AgentError, AgentLoop};
use tokio::sync::watch;

use crate::compose::Runtime;
use crate::summary::{summarize_turn, TurnSummary};

/// What happened to a streamed turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOutcome {
    /// The turn completed on its own.
    Completed,
    /// The cooperative cancel signal fired and the turn stopped gracefully
    /// (partial output/tool results are kept in the session log).
    Cancelled,
}

impl Runtime {
    /// Build a per-turn DefaultAgentLoop from the runtime config, an optional
    /// cooperative cancel signal and the optional sink.
    fn make_loop(
        &self,
        cancel: Option<watch::Receiver<bool>>,
        sink: Option<EventSink>,
    ) -> Arc<dyn AgentLoop> {
        let cfg = self.config.clone();
        Arc::new(DefaultAgentLoop::with_bindings(
            cfg,
            cancel,
            sink,
            Some(self.usage.clone()),
        ))
    }

    /// Run one turn with cooperative cancellation and streaming events.
    ///
    /// - cancel: when Some, sending true on the channel cancels the turn
    ///   gracefully (the loop stops at the next await checkpoint and the
    ///   session log gets a TurnEnd; partial output stays).
    /// - sink: when Some, every LoopEvent the turn produces is delivered to
    ///   it instead of being printed (Text/Thinking/ToolCall/ToolResult/Done).
    ///
    /// Returns the turn outcome; AgentError only for hard failures (e.g. a
    /// missing service in the context). A cancelled turn is Ok(Cancelled),
    /// never an error — the CLI's Ctrl-C path maps here.
    pub async fn run_turn(
        &self,
        input: &str,
        cancel: Option<watch::Receiver<bool>>,
        sink: Option<EventSink>,
    ) -> Result<TurnOutcome, AgentError> {
        let agent = self.make_loop(cancel.clone(), sink.clone());
        agent.run_turn(&self.ctx, input).await?;
        let cancelled = cancel.as_ref().map(|rx| *rx.borrow()).unwrap_or(false);
        Ok(if cancelled {
            TurnOutcome::Cancelled
        } else {
            TurnOutcome::Completed
        })
    }

    /// Structured summary of the most recent completed turn in the session
    /// log (see [summarize_turn]); frontends use it for a stateless
    /// one-turn result document.
    pub fn summarize_turn(&self) -> TurnSummary {
        summarize_turn(&self.session.events())
    }

    /// The token usage of the most recent LLM stream driven by this Runtime
    /// (zeroed when no turn has run yet). Additive surface for /api/status
    /// and future context-trimming telemetry (W220).
    pub fn latest_usage(&self) -> celestea_core::Usage {
        self.usage.latest()
    }

    /// Cumulative token usage across all turns driven by this Runtime.
    pub fn total_usage(&self) -> celestea_core::Usage {
        self.usage.total()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use celestea_core::{
        Content, Context, Llm, LlmError, LlmService, LlmStream, Message, ModelRequest,
        SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput,
        ToolOutput, ToolRegistry, ToolRegistryService, ToolSpec, ToolDecision,
        ToolGuard,
    };
    use crate::LoopEvent;
    use celestea_agent_loop::UsageTracker;
    use celestea_session::InMemorySessionLog;
    use celestea_workers::WorkerRegistry;
    use futures_util::stream;
    use futures_util::StreamExt;
    use serde_json::json;

    /// Fake LLM: pops the next pre-baked reply per generate() call.
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

    /// Fake registry: records dispatch order, always allows.
    #[derive(Default)]
    struct FakeRegistry {
        dispatched: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl ToolRegistry for FakeRegistry {
        fn register(&mut self, _tool: Box<dyn celestea_core::Tool>) {}
        fn add_guard(&mut self, _guard: Box<dyn ToolGuard>) {}
        fn get(&self, _name: &str) -> Option<&dyn celestea_core::Tool> {
            None
        }
        fn schemas(&self) -> Vec<ToolSpec> {
            Vec::new()
        }
        async fn dispatch(&self, input: ToolInput) -> ToolOutput {
            self.dispatched.lock().unwrap().push(input.call_id.clone());
            ToolOutput {
                call_id: input.call_id,
                value: Some(json!("ok")),
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
        Message { role: celestea_core::Role::Assistant, content, tool_call_id: None }
    }

    fn test_runtime(replies: Vec<Message>) -> (Runtime, Arc<FakeRegistry>) {
        let session = Arc::new(InMemorySessionLog::new());
        let registry = Arc::new(FakeRegistry::default());
        let mut ctx = Context::new();
        ctx.provide(LlmService(Arc::new(FakeLlm::new(replies))));
        ctx.provide(SessionService(session.clone()));
        ctx.provide(ToolRegistryService(registry.clone()));
        let config = celestea_core::AgentConfig::default();
        let workers = Arc::new(WorkerRegistry::new(
            std::env::temp_dir().join(format!(
                "celestea-rt-run-{}-{}.tsv",
                std::process::id(),
                rand_tag()
            )),
        ));
        (
            Runtime {
                ctx,
                session,
                registry: registry.clone(),
                config,
                workers,
                usage: Arc::new(UsageTracker::new()),
            },
            registry,
        )
    }

    fn rand_tag() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as u64
    }

    #[tokio::test]
    async fn run_turn_completes_and_summarizes() {
        let (rt, _reg) = test_runtime(vec![Message::assistant_text("hello there")]);
        let collected = Arc::new(Mutex::new(Vec::<LoopEvent>::new()));
        let sink: EventSink = {
            let c = collected.clone();
            Arc::new(move |ev| c.lock().unwrap().push(ev))
        };
        let outcome = rt.run_turn("hi", None, Some(sink)).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);
        // Done delivered to the sink.
        let evs = collected.lock().unwrap().clone();
        assert!(evs.iter().any(|e| matches!(e, LoopEvent::Done(_))));
        // Summary from the session log: the single source of truth.
        let summary = rt.summarize_turn();
        assert!(!summary.turn.is_empty());
        assert_eq!(summary.assistant_text, "hello there");
    }

    #[tokio::test]
    async fn run_turn_streams_tool_events_in_order() {
        let (rt, reg) = test_runtime(vec![
            tool_call_message(&["c1"]),
            Message::assistant_text("done"),
        ]);
        let collected = Arc::new(Mutex::new(Vec::<LoopEvent>::new()));
        let sink: EventSink = {
            let c = collected.clone();
            Arc::new(move |ev| c.lock().unwrap().push(ev))
        };
        let outcome = rt.run_turn("do it", None, Some(sink)).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);
        let evs = collected.lock().unwrap().clone();
        let kinds: Vec<&str> = evs.iter().map(|e| match e {
            LoopEvent::ToolCall { .. } => "toolcall",
            LoopEvent::ToolResult(_) => "toolresult",
            LoopEvent::Done(_) => "done",
            _ => "other",
        }).collect();
        let ti = kinds.iter().position(|k| *k == "toolcall").unwrap();
        let ri = kinds.iter().position(|k| *k == "toolresult").unwrap();
        let di = kinds.iter().rposition(|k| *k == "done").unwrap();
        assert!(ti < ri && ri < di, "expected ToolCall < ToolResult < Done, got {kinds:?}");
        assert_eq!(reg.dispatched.lock().unwrap().as_slice(), &["c1".to_string()]);
        // Session log carries the same lifecycle (source of truth).
        let events = rt.session.events();
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolCall { id, .. } if id == "c1")));
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolResult { id, .. } if id == "c1")));
    }

    #[tokio::test]
    async fn run_turn_cancel_returns_cancelled() {
        let (rt, _reg) = test_runtime(vec![Message::assistant_text("unused")]);
        let collected = Arc::new(Mutex::new(Vec::<LoopEvent>::new()));
        let sink: EventSink = {
            let c = collected.clone();
            Arc::new(move |ev| c.lock().unwrap().push(ev))
        };
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap(); // cancelled before the turn starts
        let outcome = rt.run_turn("hi", Some(rx), Some(sink)).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Cancelled);
        // The loop stopped before any reply: no Done event, no AssistantMessage.
        let evs = collected.lock().unwrap().clone();
        assert!(!evs.iter().any(|e| matches!(e, LoopEvent::Done(_))));
        let events = rt.session.events();
        assert!(events.iter().any(|e| matches!(e, SessionEvent::TurnStart { .. })));
        assert!(events.iter().any(|e| matches!(e, SessionEvent::TurnEnd { .. })));
        assert!(!events.iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }
    #[tokio::test]
    async fn run_turn_reports_latest_and_total_usage() {
        // Fake LLM streams a Usage event; the Runtime exposes latest + total.
        struct UsageLlm;
        #[async_trait]
        impl Llm for UsageLlm {
            async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
                Ok(stream::iter(vec![
                    StreamEvent::Usage(celestea_core::Usage {
                        prompt_tokens: 10,
                        completion_tokens: 5,
                        total_tokens: 15,
                        cache_read: 3,
                        reasoning_tokens: 2,
                    }),
                    StreamEvent::Done(Message::assistant_text("done")),
                ]).boxed())
            }
        }

        let session = Arc::new(InMemorySessionLog::new());
        let registry = Arc::new(FakeRegistry::default());
        let mut ctx = Context::new();
        ctx.provide(LlmService(Arc::new(UsageLlm)));
        ctx.provide(SessionService(session.clone()));
        ctx.provide(ToolRegistryService(registry.clone()));
        let config = celestea_core::AgentConfig::default();
        let workers = Arc::new(WorkerRegistry::new(std::env::temp_dir().join(format!(
            "celestea-rt-usage-{}-{}.tsv",
            std::process::id(),
            rand_tag()
        ))));
        let rt = Runtime {
            ctx,
            session,
            registry: registry.clone(),
            config,
            workers,
            usage: Arc::new(UsageTracker::new()),
        };

        let outcome = rt.run_turn("hi", None, None).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);
        assert_eq!(rt.latest_usage().total_tokens, 15);
        assert_eq!(rt.latest_usage().cache_read, 3);
        assert_eq!(rt.latest_usage().reasoning_tokens, 2);
        assert_eq!(rt.total_usage().total_tokens, 15);
        assert_eq!(rt.total_usage().prompt_tokens, 10);
        // A second turn accumulates: the fake LLM reports the same usage again.
        rt.run_turn("again", None, None).await.unwrap();
        assert_eq!(rt.total_usage().total_tokens, 30);
    }
}
