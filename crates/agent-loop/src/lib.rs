//! celestea-agent-loop — default turn/step driver (W104).
//!
//! Root module: re-exports the public API. Implementation is split across
//! submodules by responsibility:
//!
//! - events: LoopEvent / EventSink (turn-level event plumbing).
//! - loop (loop.rs): DefaultAgentLoop and its AgentLoop impl plus the
//!   cooperative-cancellation helpers (cancel_set / wait_cancel).
//!
//! Downstream crates keep importing `DefaultAgentLoop`, `LoopEvent` and
//! `EventSink` straight from the crate root.

mod context;
mod events;

#[path = "loop.rs"]
mod loop_module;

pub use context::{
    estimate_message_tokens, estimate_messages_tokens, estimate_tokens, trim_context,
    trimmed_marker_message, TrimOutcome,
};
pub use events::{EventSink, LoopEvent};
pub use loop_module::{DefaultAgentLoop, UsageTracker};
#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::loop_module::cancel_set;
    use tokio::sync::watch;
    use async_trait::async_trait;
    use futures_util::StreamExt;
    use celestea_core::{
        AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, ModelRequest,
        SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput, TurnOutcome, Usage,
        ToolRegistryService, Llm, LlmError, LlmStream, Message, Role, SessionLog,
        Tool, ToolGuard, ToolDecision, ToolOutput, ToolRegistry, ToolSpec,
    };
    use futures_util::stream;
    use serde_json::{json, Value};

    /// In-memory SessionLog: records every appended event so tests can assert
    /// the exact ToolCall/ToolResult ordering contract.
    #[derive(Default)]
    struct FakeSession {
        events: Mutex<Vec<SessionEvent>>,
        /// Pre-baked derive_messages projection (W220 tests). Empty by
        /// default, so existing tests keep the old "no history" behavior.
        derived: Mutex<Vec<Message>>,
        /// Monotonic turn id counter (P0-A): ids stay unique across loop
        /// instances, mirroring the real InMemory/Persistent logs.
        turn_counter: AtomicUsize,
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
            // Pre-baked projection when a test sets derived; empty by default.
            self.derived.lock().unwrap().clone()
        }
        fn clear(&self) {
            self.events.lock().unwrap().clear();
        }
        fn next_turn_id(&self) -> String {
            let n = self.turn_counter.fetch_add(1, Ordering::Relaxed);
            format!("turn-{n}")
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
            LoopEvent::TurnEnd(_) => "turnend",
            _ => "other",
        }).collect();
        assert_eq!(kinds, vec!["thinking", "text", "done", "turnend"]);
    }

    // ---- W252: thinking-delta persistence (replay keeps chain-of-thought) --

    /// The W252-relevant log projection: only thinking/assistant/tool events,
    /// in append order (structural events filtered out).
    fn persisted_kinds(session: &FakeSession) -> Vec<String> {
        session
            .all()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ThinkingDelta { text } => Some(format!("thinking:{text}")),
                SessionEvent::AssistantMessage { text } => Some(format!("assistant:{text}")),
                SessionEvent::ToolCall { id, .. } => Some(format!("toolcall:{id}")),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn thinking_segments_persist_aggregated_before_reply() {
        // Spec scenario: Thinking, Text, Thinking, Done stream input.
        // Each contiguous thinking burst becomes ONE ThinkingDelta, in stream
        // order, and both precede the assistant reply in the log.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![
            StreamEvent::Thinking("part one.".to_string()),
            StreamEvent::Thinking(" part two.".to_string()),
            StreamEvent::Text(" hi".to_string()),
            StreamEvent::Thinking("recheck.".to_string()),
            StreamEvent::Done(Message::assistant_text(" hi")),
        ];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());

        // TurnStart/UserMessage/TurnEnd aside, the log is exactly:
        // ThinkingDelta("part one. part two.") (two deltas merged into one row),
        // ThinkingDelta("recheck.") (split at the Text boundary),
        // AssistantMessage(" hi").
        let kinds = persisted_kinds(&session);
        assert_eq!(
            kinds,
            vec![
                "thinking:part one. part two.".to_string(),
                "thinking:recheck.".to_string(),
                "assistant: hi".to_string(),
            ]
        );
        // Sanity: not one row per delta (2 deltas in the first burst -> 1 row).
        let thinking_rows = session
            .all()
            .iter()
            .filter(|e| matches!(e, SessionEvent::ThinkingDelta { .. }))
            .count();
        assert_eq!(thinking_rows, 2, "three deltas -> two aggregated rows");
    }

    #[test]
    fn thinking_delta_precedes_tool_calls_in_log() {
        // A tool-call step with reasoning: the aggregated ThinkingDelta must
        // land BEFORE the step's ToolCall events, exactly like the
        // AssistantMessage case.
        struct ThinkingToolLlm {
            calls: AtomicUsize,
        }
        #[async_trait]
        impl Llm for ThinkingToolLlm {
            async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
                let n = self.calls.fetch_add(1, Ordering::Relaxed);
                if n == 0 {
                    Ok(stream::iter(vec![
                        StreamEvent::Thinking("plan tool use.".to_string()),
                        StreamEvent::Done(tool_call_message(&["c1"])),
                    ])
                    .boxed())
                } else {
                    Ok(stream::iter(vec![StreamEvent::Done(Message::assistant_text("done"))]).boxed())
                }
            }
        }
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(ThinkingToolLlm { calls: AtomicUsize::new(0) }));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let loop_ = DefaultAgentLoop::new(AgentConfig::default());
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();

        let kinds = persisted_kinds(&session);
        assert_eq!(
            kinds,
            vec![
                "thinking:plan tool use.".to_string(),
                "toolcall:c1".to_string(),
                "assistant:done".to_string(),
            ]
        );
    }

    #[test]
    fn late_thinking_after_done_emits_before_done() {
        // Providers may stream a trailing reasoning delta AFTER the
        // finish_reason frame. The loop defers the Done emission until the
        // stream ends, so the late thinking still lands BEFORE Done on the
        // wire (the UI renders thinking above the reply, never below it).
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let collected = collected.clone();
            Arc::new(move |ev| collected.lock().unwrap().push(ev))
        };
        let events = vec![
            StreamEvent::Thinking("early.".to_string()),
            StreamEvent::Text(" hi".to_string()),
            StreamEvent::Done(Message::assistant_text(" hi")),
            StreamEvent::Thinking("late.".to_string()),
        ];
        let res = run_with(&session, &registry, events, None, Some(sink));
        assert!(res.is_ok());

        let evs = collected.lock().unwrap().clone();
        let kinds: Vec<&str> = evs.iter().map(|e| match e {
            LoopEvent::Thinking(_) => "thinking",
            LoopEvent::Text(_) => "text",
            LoopEvent::Done(_) => "done",
            LoopEvent::TurnEnd(_) => "turnend",
            _ => "other",
        }).collect();
        assert_eq!(kinds, vec!["thinking", "text", "thinking", "done", "turnend"]);
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

    // ---- P0-A: 真实终态（每路径一测）+ 唯一 turn 身份 ------------------------

    /// The last TurnEnd event in a session (terminal state of the turn).
    fn last_turn_end(session: &FakeSession) -> (String, TurnOutcome) {
        let evs = session.all();
        match evs.iter().rev().find(|e| matches!(e, SessionEvent::TurnEnd { .. })) {
            Some(SessionEvent::TurnEnd { id, outcome }) => (id.clone(), outcome.clone()),
            other => panic!("expected a TurnEnd, got {other:?}"),
        }
    }

    #[test]
    fn completed_turn_marks_completed_and_emits_terminal_event() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let c = collected.clone();
            Arc::new(move |ev| c.lock().unwrap().push(ev))
        };
        let events = vec![StreamEvent::Done(Message::assistant_text("done"))];
        let res = run_with(&session, &registry, events, None, Some(sink));
        assert!(res.is_ok());
        let (id, outcome) = last_turn_end(&session);
        assert_eq!(id, "turn-0");
        assert_eq!(outcome, TurnOutcome::Completed);
        // Exactly one terminal event, as the last sink event, with Completed.
        let evs = collected.lock().unwrap().clone();
        match evs.last() {
            Some(LoopEvent::TurnEnd(o)) => assert_eq!(o, &TurnOutcome::Completed),
            other => panic!("expected terminal TurnEnd(Completed), got {other:?}"),
        }
    }

    #[test]
    fn cancelled_turn_marks_cancelled_in_log_and_sink() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        let collected = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let c = collected.clone();
            Arc::new(move |ev| c.lock().unwrap().push(ev))
        };
        let events = vec![StreamEvent::Done(Message::assistant_text("unused"))];
        let res = run_with(&session, &registry, events, Some(rx), Some(sink));
        assert!(res.is_ok());
        let (_, outcome) = last_turn_end(&session);
        assert_eq!(outcome, TurnOutcome::Cancelled);
        let evs = collected.lock().unwrap().clone();
        // No assistant reply was produced, but the terminal verdict arrives.
        assert!(!evs.iter().any(|e| matches!(e, LoopEvent::Done(_))));
        match evs.last() {
            Some(LoopEvent::TurnEnd(o)) => assert_eq!(o, &TurnOutcome::Cancelled),
            other => panic!("expected terminal TurnEnd(Cancelled), got {other:?}"),
        }
    }

    #[test]
    fn generate_failure_marks_error_outcome_with_turn_end() {
        // R1: llm.generate Err used to return without TurnEnd; now it is a
        // terminal Error state and the turn still gets its TurnEnd.
        struct FailLlm;
        #[async_trait]
        impl Llm for FailLlm {
            async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
                Err(LlmError("provider timeout".into()))
            }
        }
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(LlmService(Arc::new(FailLlm)));
        let config = AgentConfig { model: "deepseek-chat".into(), ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::new(config);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(loop_.run_turn(&ctx, "hi"));
        assert!(res.is_ok(), "terminal state rides the log, not an Err: {res:?}");
        let (_, outcome) = last_turn_end(&session);
        assert_eq!(
            outcome,
            TurnOutcome::Error { kind: "generate".into(), message: "provider timeout".into() }
        );
        assert!(!session.all().iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    #[test]
    fn stream_failure_marks_error_outcome() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![
            StreamEvent::Text("partial".to_string()),
            StreamEvent::Failed { kind: "stream".into(), message: "sse decode error: torn".into() },
        ];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());
        let (_, outcome) = last_turn_end(&session);
        assert_eq!(
            outcome,
            TurnOutcome::Error { kind: "stream".into(), message: "sse decode error: torn".into() }
        );
        // The truncated partial answer is NOT flushed as a completed reply.
        assert!(!session.all().iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    #[test]
    fn interrupted_stream_marks_interrupted_outcome() {
        // The stream ends without Done/Failed (截流): a real terminal state,
        // never a fake Completed with empty text.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![StreamEvent::Text("trunc".to_string())];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());
        let (_, outcome) = last_turn_end(&session);
        assert_eq!(outcome, TurnOutcome::Interrupted);
        assert!(!session.all().iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    #[test]
    fn step_limit_marks_step_limit_outcome_not_completed() {
        // R1: 步数耗尽仍标 Completed — the budget-exhausted turn must end as
        // StepLimit. max_steps=2 with an endless tool-call model.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(FakeLlm::new(vec![
            tool_call_message(&["c1"]),
            tool_call_message(&["c2"]),
            tool_call_message(&["c3"]),
            Message::assistant_text("never reached"),
        ])));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let config = AgentConfig { max_steps: 2, ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::new(config);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();
        let (_, outcome) = last_turn_end(&session);
        assert_eq!(outcome, TurnOutcome::StepLimit);
        // Only the first two steps ran; no final answer was logged.
        assert_eq!(registry.dispatch_order(), vec!["c1", "c2"]);
        assert!(!session.all().iter().any(|e| matches!(e, SessionEvent::AssistantMessage { .. })));
    }

    #[test]
    fn turn_ids_are_unique_across_loop_instances() {
        // R1: make_loop rebuilt the counter per turn, so the host log repeated
        // turn-0. The log now owns the counter: two loops, one session,
        // unique ids.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        run_with(&session, &registry, vec![StreamEvent::Done(Message::assistant_text("a"))], None, None).unwrap();
        run_with(&session, &registry, vec![StreamEvent::Done(Message::assistant_text("b"))], None, None).unwrap();
        let ids: Vec<String> = session
            .all()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::TurnStart { id } => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["turn-0".to_string(), "turn-1".to_string()]);
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
    // ---- W220: usage aggregation, unlimited steps, history trimming --------

    /// Fake Llm that records every request and replies with a plain text
    /// (terminating) message — lets tests assert what was actually sent.
    struct RecordingLlm {
        requests: Mutex<Vec<ModelRequest>>,
    }
    impl RecordingLlm {
        fn new() -> Self {
            Self { requests: Mutex::new(Vec::new()) }
        }
        fn requests(&self) -> Vec<ModelRequest> {
            self.requests.lock().unwrap().clone()
        }
    }
    #[async_trait]
    impl Llm for RecordingLlm {
        async fn generate(&self, req: ModelRequest) -> Result<LlmStream, LlmError> {
            self.requests.lock().unwrap().push(req.clone());
            Ok(stream::iter(vec![StreamEvent::Done(Message::assistant_text("ok"))]).boxed())
        }
    }

    /// Drive one turn with an explicit max_steps (0 = unlimited).
    fn run_turn_steps(
        session: &Arc<FakeSession>,
        registry: &Arc<FakeRegistry>,
        replies: Vec<Message>,
        max_steps: usize,
    ) {
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(FakeLlm::new(replies)));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let config = AgentConfig { max_steps, ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::new(config);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();
    }

    #[test]
    fn usage_events_accumulate_into_shared_tracker() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let tracker = Arc::new(UsageTracker::new());
        let events = vec![
            StreamEvent::Text("answer".to_string()),
            StreamEvent::Usage(Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cache_read: 3,
                reasoning_tokens: 2,
            }),
            StreamEvent::Done(Message::assistant_text("answer")),
        ];
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(Arc::new(EventLlm::new(events)));
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let config = AgentConfig { model: "deepseek-chat".into(), ..AgentConfig::default() };
        let loop_ = DefaultAgentLoop::with_bindings(config, None, None, Some(tracker.clone()));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hi")).unwrap();
        // latest() is the last stream's usage; total() accumulates it.
        assert_eq!(tracker.latest().total_tokens, 15);
        assert_eq!(tracker.latest().cache_read, 3);
        assert_eq!(tracker.latest().reasoning_tokens, 2);
        assert_eq!(tracker.total().total_tokens, 15);
        assert_eq!(tracker.total().prompt_tokens, 10);
    }

    #[test]
    fn usage_events_without_tracker_are_ignored() {
        // A plain DefaultAgentLoop (no tracker) still consumes Usage events —
        // back-compat: providers that report usage never break old consumers.
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        let events = vec![
            StreamEvent::Usage(Usage { total_tokens: 9, ..Usage::default() }),
            StreamEvent::Done(Message::assistant_text("done")),
        ];
        let res = run_with(&session, &registry, events, None, None);
        assert!(res.is_ok());
    }

    #[test]
    fn max_steps_zero_runs_unlimited_tool_steps() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        // Five tool-call steps, then a plain answer terminates the turn.
        run_turn_steps(
            &session,
            &registry,
            vec![
                tool_call_message(&["c1"]),
                tool_call_message(&["c2"]),
                tool_call_message(&["c3"]),
                tool_call_message(&["c4"]),
                tool_call_message(&["c5"]),
                Message::assistant_text("done"),
            ],
            0,
        );
        // max_steps = 0 is native unlimited: all five steps ran.
        assert_eq!(registry.dispatch_order(), vec!["c1", "c2", "c3", "c4", "c5"]);
    }

    #[test]
    fn max_steps_cap_is_preserved_for_nonzero() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        run_turn_steps(
            &session,
            &registry,
            vec![
                tool_call_message(&["c1"]),
                tool_call_message(&["c2"]),
                tool_call_message(&["c3"]),
                tool_call_message(&["c4"]),
                Message::assistant_text("done"),
            ],
            3,
        );
        // A nonzero cap still stops the loop after that many steps.
        assert_eq!(registry.dispatch_order(), vec!["c1", "c2", "c3"]);
    }

    #[test]
    fn loop_trims_history_and_marks_with_system_message() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        {
            let mut derived = Vec::new();
            for i in 0..30 {
                derived.push(Message::user(format!("message {i} ").repeat(20)));
            }
            *session.derived.lock().unwrap() = derived;
        }
        let recording = Arc::new(RecordingLlm::new());
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(recording.clone());
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let config = AgentConfig {
            context_window_tokens: 1000,
            context_trim_threshold: 0.8,
            context_keep_recent: 4,
            ..AgentConfig::default()
        };
        let loop_ = DefaultAgentLoop::new(config);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let msgs = &reqs[0].messages;
        // The request the model sees was trimmed: one leading system marker
        // plus the 4 most-recent user messages, nothing older.
        assert_eq!(msgs[0].role, Role::System);
        assert!(matches!(&msgs[0].content[0], Content::Text(t) if t.contains("context-trimmed")));
        assert_eq!(msgs.len(), 5);
        assert!(matches!(&msgs[1].content[0], Content::Text(t) if t.starts_with("message 26")));
        assert!(matches!(&msgs[4].content[0], Content::Text(t) if t.starts_with("message 29")));
    }

    #[test]
    fn loop_default_window_does_not_trim_small_histories() {
        let session = Arc::new(FakeSession::default());
        let registry = Arc::new(FakeRegistry::default());
        {
            *session.derived.lock().unwrap() = vec![
                Message::user("hello"),
                Message::assistant_text("hi"),
            ];
        }
        let recording = Arc::new(RecordingLlm::new());
        let session_dyn: Arc<dyn SessionLog> = session.clone();
        let registry_dyn: Arc<dyn ToolRegistry> = registry.clone();
        let llm = LlmService(recording.clone());
        let mut ctx = Context::new();
        ctx.provide(SessionService(session_dyn));
        ctx.provide(ToolRegistryService(registry_dyn));
        ctx.provide(llm);
        let loop_ = DefaultAgentLoop::new(AgentConfig::default());
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(loop_.run_turn(&ctx, "hello")).unwrap();
        let reqs = recording.requests();
        let msgs = &reqs[0].messages;
        assert_eq!(msgs.len(), 2, "no trim under the default window");
        assert!(!matches!(msgs[0].role, Role::System), "no marker inserted");
    }
}
