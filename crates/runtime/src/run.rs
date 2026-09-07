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
use celestea_core::{AgentError, AgentLoop, SessionEvent};
use tokio::sync::watch;

use crate::compose::Runtime;
use crate::summary::{summarize_turn, TurnSummary};

// P0-A: the terminal states live in core (the SessionEvent::TurnEnd payload
// and the agent-loop sink both need them); the runtime re-exports the same
// type so the engine surface stays a single import path (back-compat with the
// old runtime-local enum: Completed/Cancelled keep their names).
pub use celestea_core::TurnOutcome;

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
    /// Returns the turn outcome; AgentError only for hard failures before the
    /// turn starts (e.g. a missing service in the context). Every other exit
    /// is a structured outcome read from the turn's TurnEnd in the session log
    /// (the single source of truth — P0-A): Completed / Cancelled /
    /// Error{kind,message} / StepLimit / Interrupted.
    pub async fn run_turn(
        &self,
        input: &str,
        cancel: Option<watch::Receiver<bool>>,
        sink: Option<EventSink>,
    ) -> Result<TurnOutcome, AgentError> {
        // W232 会话通讯闭环（宿主侧消费）：每轮开始先把 cli-main mailbox 里
        // 的 pending 消息按 FIFO drain 进宿主 SessionLog，标注来源 from_label，
        // 再处理本次输入 —— worker 的回执/协作消息由此在宿主的下一轮真实可见。
        // 只做日志注入，不动 SSE（sink）/取消（cancel）/热重载路径。
        for msg in self.workers.mailbox().poll(crate::compose::HOST_SID) {
            let text = if msg.from_label.is_empty() {
                msg.content
            } else {
                format!("[from {}] {}", msg.from_label, msg.content)
            };
            self.session.append(SessionEvent::UserMessage { text });
        }
        let agent = self.make_loop(cancel.clone(), sink.clone());
        // Err here means the turn never started (no TurnStart), so the error
        // propagates; every started turn ends with exactly one TurnEnd.
        agent.run_turn(&self.ctx, input).await?;
        Ok(Self::last_turn_outcome(&self.session.events()).unwrap_or(TurnOutcome::Completed))
    }

    /// The terminal state of the most recent turn in the session log, read
    /// from its TurnEnd (P0-A). None when no turn has ended yet.
    fn last_turn_outcome(events: &[SessionEvent]) -> Option<TurnOutcome> {
        events.iter().rev().find_map(|e| match e {
            SessionEvent::TurnEnd { outcome, .. } => Some(outcome.clone()),
            _ => None,
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
    use celestea_session::{InMemorySessionLog, Session, SessionMeta};
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
    // ---- P0-A: 真实终态从日志回流 runtime（error / interrupted / 唯一 id） -----

    /// Build a Runtime around an arbitrary Llm (the queue-based test_runtime
    /// cannot fail or truncate).
    fn runtime_with_llm(llm: Arc<dyn celestea_core::Llm>) -> (Runtime, Arc<FakeRegistry>) {
        let session = Arc::new(InMemorySessionLog::new());
        let registry = Arc::new(FakeRegistry::default());
        let mut ctx = Context::new();
        ctx.provide(LlmService(llm));
        ctx.provide(SessionService(session.clone()));
        ctx.provide(ToolRegistryService(registry.clone()));
        let config = celestea_core::AgentConfig::default();
        let workers = Arc::new(WorkerRegistry::new(
            std::env::temp_dir().join(format!(
                "celestea-rt-outcome-{}-{}.tsv",
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

    #[tokio::test]
    async fn run_turn_returns_error_outcome_for_generate_failure() {
        struct FailLlm;
        #[async_trait]
        impl Llm for FailLlm {
            async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
                Err(LlmError("provider timeout".into()))
            }
        }
        let (rt, _reg) = runtime_with_llm(Arc::new(FailLlm));
        let outcome = rt.run_turn("hi", None, None).await.unwrap();
        assert_eq!(
            outcome,
            TurnOutcome::Error { kind: "generate".into(), message: "provider timeout".into() }
        );
        // The log carries the same terminal state (source of truth).
        match rt.session.events().iter().rev().find(|e| matches!(e, SessionEvent::TurnEnd { .. })) {
            Some(SessionEvent::TurnEnd { outcome: o, .. }) => {
                assert_eq!(*o, TurnOutcome::Error { kind: "generate".into(), message: "provider timeout".into() });
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_turn_returns_interrupted_outcome_for_torn_stream() {
        struct TornLlm;
        #[async_trait]
        impl Llm for TornLlm {
            async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
                Ok(stream::iter(vec![StreamEvent::Text("trunc".to_string())]).boxed())
            }
        }
        let (rt, _reg) = runtime_with_llm(Arc::new(TornLlm));
        let outcome = rt.run_turn("hi", None, None).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Interrupted);
    }

    #[tokio::test]
    async fn run_turn_turn_ids_are_unique_across_turns() {
        // The runtime rebuilds a DefaultAgentLoop per turn (make_loop); the
        // session log owns the counter, so the host log never repeats turn-0.
        let (rt, _reg) = test_runtime(vec![
            Message::assistant_text("first"),
            Message::assistant_text("second"),
        ]);
        assert_eq!(rt.run_turn("one", None, None).await.unwrap(), TurnOutcome::Completed);
        assert_eq!(rt.run_turn("two", None, None).await.unwrap(), TurnOutcome::Completed);
        let ids: Vec<String> = rt
            .session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::TurnStart { id } => Some(id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec!["turn-0".to_string(), "turn-1".to_string()]);
        // The summary exposes the last turn's id + terminal state.
        let s = rt.summarize_turn();
        assert_eq!(s.turn, "turn-1");
        assert_eq!(s.outcome, TurnOutcome::Completed);
    }

    // ---- W232: 宿主消费 mailbox（worker 回执在宿主下一轮真实可见） -------------

    #[tokio::test]
    async fn run_turn_drains_host_mailbox_before_input() {
        let (rt, _reg) = test_runtime(vec![Message::assistant_text("replied")]);
        // compose() 的 W232 行为：宿主会话登记进共享 SessionRegistry，回执投进
        // mailbox["cli-main"]（worker 侧 session_send_message 的投递路径）。
        let host = Arc::new(Session::new(SessionMeta {
            id: "cli-main".into(),
            title: "cli-main".into(),
            workspace: None,
            model: None,
        }));
        rt.workers.sessions().register(host).unwrap();
        rt.workers.mailbox().send("cli-main", "receipt one", "W1");
        rt.workers.mailbox().send("cli-main", "receipt two", "W2");
        assert_eq!(rt.workers.mailbox().pending("cli-main"), 2);

        let outcome = rt.run_turn("now go", None, None).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);

        // 回执按 FIFO 注入宿主日志、标注来源 from_label，且排在本次输入之前。
        let texts: Vec<String> = rt
            .session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                "[from W1] receipt one".to_string(),
                "[from W2] receipt two".to_string(),
                "now go".to_string(),
            ]
        );
        assert_eq!(rt.workers.mailbox().pending("cli-main"), 0, "host mailbox drained");
        // 本轮仍正常完成（drain 不影响 turn 语义）。
        assert_eq!(rt.summarize_turn().assistant_text, "replied");
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
