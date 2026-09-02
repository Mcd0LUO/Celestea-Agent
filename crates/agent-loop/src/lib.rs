//! celestea-agent-loop — default turn/step driver (W104).
//!
//! DefaultAgentLoop implements the celestea_core::AgentLoop seam: it drives
//! one user turn by appending to the session log, looping over model steps,
//! dispatching tool calls through the registry, and writing the final
//! assistant message. All dependencies (llm, session, tools) are resolved
//! from the shared celestea_core::Context at turn start.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::watch;
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, ModelRequest,
    Message, SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput, ToolOutput,
    ToolRegistryService,
};
use futures_util::StreamExt;

/// An event a running turn delivers to an injected sink. This is the
/// agent-loop view of the turn: it carries the LLM stream events
/// (Text/Thinking/Done, mirroring StreamEvent) plus the tool lifecycle
/// (ToolCall + the full ToolOutput for its ToolResult), so a rich UI can draw
/// tool cards and style thinking without scraping the session log or relying
/// on StreamEvent growing variants (core is frozen for P1).
#[derive(Debug, Clone)]
pub enum LoopEvent {
    Text(String),
    Thinking(String),
    Done(Message),
    ToolCall { id: String, name: String, args: Value },
    ToolResult(ToolOutput),
}

/// A sink receives every LoopEvent a turn produces, in log order. None on
/// the loop (the default) keeps the legacy behavior: Text/Thinking deltas are
/// printed straight to stdout.
pub type EventSink = Arc<dyn Fn(LoopEvent) + Send + Sync>;

/// The default agent loop: a stateless (modulo a turn counter) driver, with
/// an optional cooperative cancellation signal (W191) and an optional event
/// sink (P1, output decoupling).
///
/// Cancellation is injected via DefaultAgentLoop::with_cancel as a
/// tokio::sync::watch::Receiver<bool>; when the watch value becomes true the
/// loop stops at the next await checkpoint (tokio::select!) and returns
/// gracefully. DefaultAgentLoop::new (no signal) keeps the pre-cancel behavior
/// for back-compat, so the AgentLoop trait and run_turn signature are unchanged.
///
/// The event sink is injected via DefaultAgentLoop::with_sink (or
/// with_cancel_sink for both); every LoopEvent a turn produces is delivered
/// to it instead of being printed. A None sink keeps the legacy stdout print
/// behavior, so existing callers (and the CLI --json path) are unchanged.
pub struct DefaultAgentLoop {
    config: AgentConfig,
    /// Monotonic turn id counter; keeps the loop Send + Sync while producing
    /// unique turn ids without any extra dependency.
    turn_id: AtomicU64,
    /// Cooperative cancel signal. None = never cancelled (back-compat).
    cancel: Option<watch::Receiver<bool>>,
    /// Event sink. None = legacy stdout printing (back-compat).
    sink: Option<EventSink>,
}

impl DefaultAgentLoop {
    /// Build a loop from an AgentConfig (no cancellation signal, no sink).
    pub fn new(config: AgentConfig) -> Self {
        Self { config, turn_id: AtomicU64::new(0), cancel: None, sink: None }
    }

    /// Build a loop that stops cooperatively once the watch value reads true.
    /// The sender half is owned by the caller (e.g. hooked to ctrl_c at the
    /// composition / CLI layer).
    pub fn with_cancel(config: AgentConfig, cancel: watch::Receiver<bool>) -> Self {
        Self { config, turn_id: AtomicU64::new(0), cancel: Some(cancel), sink: None }
    }

    /// Build a loop that routes every LoopEvent to the given sink (stream
    /// deltas and tool events are no longer printed).
    pub fn with_sink(config: AgentConfig, sink: EventSink) -> Self {
        Self { config, turn_id: AtomicU64::new(0), cancel: None, sink: Some(sink) }
    }

    /// Build a loop with both a cooperative cancel signal and an event sink.
    pub fn with_cancel_sink(
        config: AgentConfig,
        cancel: watch::Receiver<bool>,
        sink: EventSink,
    ) -> Self {
        Self { config, turn_id: AtomicU64::new(0), cancel: Some(cancel), sink: Some(sink) }
    }

    /// Allocate the next unique turn id.
    fn next_turn_id(&self) -> String {
        let n = self.turn_id.fetch_add(1, Ordering::Relaxed);
        format!("turn-{}", n)
    }

    /// Route one LoopEvent to the injected sink, or fall back to the legacy
    /// stdout printing when no sink is installed (back-compat).
    fn emit(&self, event: LoopEvent) {
        if let Some(sink) = &self.sink {
            sink(event);
        } else {
            let _ = Self::print_legacy(&mut io::stdout(), &event);
        }
    }

    /// The legacy default printer (used when no sink is installed): Text and
    /// Thinking deltas are written straight to the writer and flushed, exactly
    /// as the loop printed before sinks existed. Written over a generic writer
    /// so tests can assert the formatting without touching real stdout.
    fn print_legacy(w: &mut dyn Write, event: &LoopEvent) -> io::Result<()> {
        match event {
            LoopEvent::Text(text) => write!(w, "{}", text)?,
            LoopEvent::Thinking(text) => write!(w, "[thinking] {}", text)?,
            _ => {}
        }
        w.flush()
    }
}

/// Whether the cancellation watch is set (value true). Synchronous, safe to
/// call on a shared receiver (watch::Receiver::borrow is &self).
fn cancel_set(rx: &watch::Receiver<bool>) -> bool {
    *rx.borrow()
}

/// Resolve as soon as cancellation is signalled (or the sender is dropped).
/// Re-checks the current value after each notification, so it can be awaited at
/// multiple checkpoints within one turn.
async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    loop {
        if rx.changed().await.is_err() {
            return; // sender dropped: treat as no further cancellation
        }
        if *rx.borrow() {
            return;
        }
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

        // Cooperative cancellation (W191). Clone the receiver for this turn;
        // None (the default) keeps the pre-cancel "never cancelled" behavior.
        // At each await checkpoint we select!() the real work against wait_cancel;
        // a cancel makes the loop stop and return gracefully (TurnEnd appended).
        let mut cancel_rx = self.cancel.clone();
        let mut cancel_requested = false;

        for _step in 0..self.config.max_steps {
            // Step-level checkpoint before issuing the next model request.
            if let Some(rx) = cancel_rx.as_ref() {
                if cancel_set(rx) {
                    // Cancelled before this step: stop (TurnEnd appended below).
                    break;
                }
            }

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

            // Generate, then consume the stream: Text deltas go to stdout, the
            // final Done(message) is the authoritative assistant reply. A slow
            // generate()/stream stays interruptible through select!.
            let mut stream = match cancel_rx.as_mut() {
                Some(rx) => {
                    tokio::select! {
                        r = llm.generate(request) => match r {
                            Ok(s) => s,
                            Err(e) => return Err(AgentError(format!("llm.generate failed: {}", e))),
                        },
                        _ = wait_cancel(rx) => {
                            // Cancelled before/during the model's first response:
                            // break out of the step loop (TurnEnd appended below).
                            break;
                        }
                    }
                }
                None => llm
                    .generate(request)
                    .await
                    .map_err(|e| AgentError(format!("llm.generate failed: {}", e)))?,
            };

            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();

            // Stream consumption loop. A cancel mid-stream drops the partial
            // turn (no incomplete AssistantMessage is flushed).
            loop {
                let next = match cancel_rx.as_mut() {
                    Some(rx) => {
                        tokio::select! {
                            ev = stream.next() => ev,
                            _ = wait_cancel(rx) => {
                                cancel_requested = true;
                                None
                            }
                        }
                    }
                    None => stream.next().await,
                };
                let Some(event) = next else { break };
                match event {
                    // Stream deltas and the final message are routed through
                    // the sink when one is installed (no direct print).
                    StreamEvent::Text(delta) => self.emit(LoopEvent::Text(delta)),
                    StreamEvent::Thinking(delta) => self.emit(LoopEvent::Thinking(delta)),
                    StreamEvent::Done(message) => {
                        self.emit(LoopEvent::Done(message.clone()));
                        for content in message.content {
                            match content {
                                Content::Text(text) => assistant_text.push_str(&text),
                                Content::ToolCall(call) => tool_calls.push(call),
                            }
                        }
                    }
                }
            }

            if cancel_requested {
                break;
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
                self.emit(LoopEvent::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    args: call.args.clone(),
                });
            }

            // Dispatch concurrently, bounded by max_parallel_tool_calls
            // (clamped to at least 1; a 0 limit means serial). join_all
            // resolves in input order, so ToolResult events are appended in
            // the model's original call order even though the calls run in
            // parallel — the log ordering stays deterministic. A cancel during
            // a pending batch stops dispatch (dropped batch, consistent log).
            let limit = self.config.max_parallel_tool_calls.max(1);
            for batch in tool_calls.chunks(limit) {
                let dispatch = futures_util::future::join_all(batch.iter().map(|call| {
                    registry.dispatch(ToolInput {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        args: call.args.clone(),
                    })
                }));
                let outputs = match cancel_rx.as_mut() {
                    Some(rx) => {
                        tokio::select! {
                            o = dispatch => o,
                            _ = wait_cancel(rx) => {
                                cancel_requested = true;
                                break;
                            }
                        }
                    }
                    None => dispatch.await,
                };
                for output in outputs {
                    self.emit(LoopEvent::ToolResult(output.clone()));
                    session.append(SessionEvent::ToolResult {
                        id: output.call_id,
                        value: output.value,
                        error: output.error,
                    });
                }
            }
            if cancel_requested {
                break;
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

    /// Fake Llm that emits a fixed sequence of StreamEvents (e.g. Thinking
    /// deltas then a final Done), to exercise stream-event consumption paths
    /// that the queue-based FakeLlm cannot produce.
    struct EventLlm {
        events: Vec<StreamEvent>,
    }
    impl EventLlm {
        fn new(events: Vec<StreamEvent>) -> Self {
            Self { events }
        }
    }
    #[async_trait]
    impl Llm for EventLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            Ok(stream::iter(self.events.clone()).boxed())
        }
    }

    /// Set up a Context with the given session/registry/event-llm and run one
    /// turn through a DefaultAgentLoop built with (or without) a cancel signal
    /// and/or an event sink.
    fn run_with(
        session: &Arc<FakeSession>,
        registry: &Arc<FakeRegistry>,
        events: Vec<StreamEvent>,
        cancel: Option<watch::Receiver<bool>>,
        sink: Option<EventSink>,
    ) -> Result<(), AgentError> {
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(EventLlm::new(events)));

        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);

        let config = AgentConfig {
            model: "deepseek-chat".into(),
            ..AgentConfig::default()
        };
        let loop_ = match (cancel, sink) {
            (Some(rx), Some(s)) => DefaultAgentLoop::with_cancel_sink(config, rx, s),
            (Some(rx), None) => DefaultAgentLoop::with_cancel(config, rx),
            (None, Some(s)) => DefaultAgentLoop::with_sink(config, s),
            (None, None) => DefaultAgentLoop::new(config),
        };
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello"))
    }

    #[test]
    fn consumes_thinking_stream_events() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![
            StreamEvent::Thinking("Let me think.".to_string()),
            StreamEvent::Text(" answer".to_string()),
            StreamEvent::Done(Message::assistant_text(" answer")),
        ];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());
        // The turn completed and produced one AssistantMessage.
        let msgs = session
            .all()
            .into_iter()
            .filter(|e| matches!(e, SessionEvent::AssistantMessage { .. }))
            .count();
        assert_eq!(msgs, 1);
    }

    #[test]
    fn cancelled_before_turn_returns_gracefully() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let (tx, rx) = watch::channel(false);
        // Signal cancellation before the loop even starts.
        tx.send(true).unwrap();

        let events = vec![StreamEvent::Done(Message::assistant_text("hi"))];
        let res = run_with(&session, &registry, events, Some(rx), None);
        assert!(res.is_ok());

        // TurnStart/UserMessage/TurnEnd are recorded; no assistant reply was
        // produced because cancellation stopped the loop before the model step.
        let evs = session.all();
        assert!(evs.iter().any(|e| matches!(e, SessionEvent::TurnStart { .. })));
        assert!(evs.iter().any(|e| matches!(e, SessionEvent::TurnEnd { .. })));
        assert!(!evs.iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    /// Fake Llm whose stream never terminates: yields one Thinking delta then
    /// parks on Pending forever (simulating an in-flight reasoning stream with
    /// no further output). Built with futures_util::stream::poll_fn so the
    /// agent-loop test module needs no extra dependency.
    struct HangLlm;
    #[async_trait]
    impl Llm for HangLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            use std::task::Poll;
            let mut emitted = false;
            let s = futures_util::stream::poll_fn(move |_cx| {
                if !emitted {
                    emitted = true;
                    Poll::Ready(Some(StreamEvent::Thinking("pondering...".to_string())))
                } else {
                    Poll::Pending
                }
            });
            Ok(Box::pin(s))
        }
    }

    #[test]
    fn cancelled_during_stream_returns_gracefully() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let (tx, rx) = watch::channel(false);

        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(HangLlm));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);

        let config = AgentConfig { model: "deepseek-chat".into(), ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::with_cancel(config, rx);

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let turn = loop_.run_turn(&ctx, "hi");
            tokio::pin!(turn);
            // Race the turn against a cancel signal that fires only after the
            // loop has had a chance to start consuming the hanging stream.
            let signal = async {
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                tx.send(true).ok();
            };
            tokio::pin!(signal);
            let res: Result<(), AgentError> = tokio::select! {
                r = &mut turn => r,
                _ = &mut signal => {
                    // Signal sent while the stream is parked; the select! inside
                    // run_turn resolves on wait_cancel and the turn returns Ok.
                    turn.await
                }
            };
            assert!(res.is_ok());
        });

        let evs = session.all();
        // TurnEnd recorded; a hanging stream means no AssistantMessage ever.
        assert!(evs.iter().any(|e| matches!(e, SessionEvent::TurnEnd { .. })));
        assert!(!evs.iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    #[test]
    fn no_cancel_signal_preserves_backward_compat() {
        // DefaultAgentLoop::new (no signal) drives a normal turn to completion.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![StreamEvent::Done(Message::assistant_text("done"))];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());
        let msgs = session
            .all()
            .into_iter()
            .filter(|e| matches!(e, SessionEvent::AssistantMessage { .. }))
            .count();
        assert_eq!(msgs, 1);
    }

    #[test]
    fn sink_receives_stream_events_in_order() {
        // With a sink installed, Text/Thinking/Done deltas are delivered to
        // the sink in emission order instead of being printed.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let collected = collected.clone();
            Arc::new(move |ev| collected.lock().unwrap().push(ev))
        };
        let events = vec![
            StreamEvent::Thinking("think.".to_string()),
            StreamEvent::Text(" hi".to_string()),
            StreamEvent::Done(Message::assistant_text(" hi")),
        ];
        let res = run_with(&session, &registry, events, None, Some(sink));
        assert!(res.is_ok());

        let evs = collected.lock().unwrap().clone();
        let kinds: Vec<&str> = evs.iter().map(|e| match e {
            LoopEvent::Thinking(_) => "thinking",
            LoopEvent::Text(_) => "text",
            LoopEvent::Done(_) => "done",
            _ => "other",
        }).collect();
        assert_eq!(kinds, vec!["thinking", "text", "done"]);
    }

    #[test]
    fn sink_receives_tool_lifecycle_in_order() {
        // A turn with one tool call: the sink sees ToolCall, then ToolResult
        // (carrying the full ToolOutput incl. decision), then the final Done.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let collected = collected.clone();
            Arc::new(move |ev| collected.lock().unwrap().push(ev))
        };

        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(FakeLlm::new(vec![
            tool_call_message(&["c1"]),
            Message::assistant_text("done"),
        ])));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);

        let config = AgentConfig { model: "deepseek-chat".into(), ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::with_sink(config, sink);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();

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
        assert!(ti < ri && ri < di, "expected ToolCall < ToolResult < Done, got {:?}", kinds);
        match &evs[ri] {
            LoopEvent::ToolResult(o) => {
                assert_eq!(o.call_id, "c1");
                assert_eq!(o.decision, Some(ToolDecision::Allow));
            }
            _ => panic!("expected ToolResult at index {}", ri),
        }
    }

    #[test]
    fn sink_none_preserves_legacy_print_formatting() {
        // The legacy printer (used when no sink is installed) writes Text and
        // Thinking deltas exactly as the pre-sink loop did, and never prints
        // tool events.
        let mut buf: Vec<u8> = Vec::new();
        DefaultAgentLoop::print_legacy(&mut buf, &LoopEvent::Text("hi".into())).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "hi");
        let mut buf: Vec<u8> = Vec::new();
        DefaultAgentLoop::print_legacy(&mut buf, &LoopEvent::Thinking("ponder".into())).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "[thinking] ponder");
        let mut buf: Vec<u8> = Vec::new();
        DefaultAgentLoop::print_legacy(&mut buf, &LoopEvent::ToolCall {
            id: "c".into(), name: "t".into(), args: json!({}),
        }).unwrap();
        assert!(buf.is_empty());
    }

    #[test]
    fn sink_combined_with_cancel_cancels_gracefully() {
        // Sink + cancel together: cancel mid-stream drops the partial turn;
        // the sink saw the Thinking delta but no Done, and the turn returns Ok.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let collected = collected.clone();
            Arc::new(move |ev| collected.lock().unwrap().push(ev))
        };
        let (tx, rx) = watch::channel(false);
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(HangLlm));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let config = AgentConfig { model: "deepseek-chat".into(), ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::with_cancel_sink(config, rx, sink);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let turn = loop_.run_turn(&ctx, "hi");
            tokio::pin!(turn);
            let signal = async {
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                tokio::task::yield_now().await;
                tx.send(true).ok();
            };
            tokio::pin!(signal);
            let res: Result<(), AgentError> = tokio::select! {
                r = &mut turn => r,
                _ = &mut signal => turn.await,
            };
            assert!(res.is_ok());
        });
        let evs = collected.lock().unwrap().clone();
        assert!(evs.iter().any(|e| matches!(e, LoopEvent::Thinking(_))));
        assert!(!evs.iter().any(|e| matches!(e, LoopEvent::Done(_))));
    }

    #[test]
    fn cancel_set_reflects_watch_value() {
        let (tx, rx) = watch::channel(false);
        assert!(!cancel_set(&rx));
        tx.send(true).unwrap();
        assert!(cancel_set(&rx));
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

