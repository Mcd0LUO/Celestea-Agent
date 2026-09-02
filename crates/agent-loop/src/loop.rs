//! The default agent-loop driver: [DefaultAgentLoop], its [AgentLoop] impl,
//! and the cooperative-cancellation helpers (cancel_set / wait_cancel).
//!
//! It drives one user turn by appending to the session log, looping over model
//! steps, dispatching tool calls through the registry, and writing the final
//! assistant message. All dependencies (llm, session, tools) are resolved
//! from the shared celestea_core::Context at turn start.

use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use tokio::sync::watch;
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, ModelRequest,
    SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput,
    ToolRegistryService,
};
use futures_util::StreamExt;

use crate::events::{EventSink, LoopEvent};

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
    pub(crate) fn print_legacy(w: &mut dyn Write, event: &LoopEvent) -> io::Result<()> {
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
pub(crate) fn cancel_set(rx: &watch::Receiver<bool>) -> bool {
    *rx.borrow()
}

/// Resolve as soon as cancellation is signalled (or the sender is dropped).
/// Re-checks the current value after each notification, so it can be awaited at
/// multiple checkpoints within one turn.
pub(crate) async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
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
