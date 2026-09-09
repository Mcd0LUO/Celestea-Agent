//! The default agent-loop driver: [DefaultAgentLoop], its [AgentLoop] impl,
//! and the cooperative-cancellation helpers (cancel_set / wait_cancel).
//!
//! It drives one user turn by appending to the session log, looping over model
//! steps, dispatching tool calls through the registry, and writing the final
//! assistant message. All dependencies (llm, session, tools) are resolved
//! from the shared celestea_core::Context at turn start.

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::watch;
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Content, Context, LlmService, Message, ModelRequest,
    SessionEvent, SessionService, StreamEvent, ToolCall, ToolInput, TurnOutcome, Usage,
    ToolRegistryService,
};
use futures_util::StreamExt;

use crate::context::{estimate_tokens, trim_context};
use crate::events::{EventSink, LoopEvent};

/// The default agent loop: a stateless driver (the session log owns the
/// monotonic turn id counter — P0-A), with an optional cooperative
/// cancellation signal (W191) and an optional event sink (P1, output
/// decoupling).
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
    /// Cooperative cancel signal. None = never cancelled (back-compat).
    cancel: Option<watch::Receiver<bool>>,
    /// Event sink. None = legacy stdout printing (back-compat).
    sink: Option<EventSink>,
    /// Shared usage tracker (W220). None = usage not recorded (back-compat).
    usage: Option<Arc<UsageTracker>>,
}

/// Thread-safe cumulative usage accounting (W220).
///
/// The agent loop records every LLM stream's StreamEvent::Usage into an
/// optional tracker; the runtime reads latest()/total() to expose usage via
/// /api/status and to drive future trimming decisions. Cheap interior
/// mutability (std::sync::Mutex) keeps record() callable from the &self loop.
#[derive(Debug, Default)]
pub struct UsageTracker {
    inner: Mutex<UsageState>,
}

#[derive(Debug, Default)]
struct UsageState {
    total: Usage,
    latest: Usage,
}

impl UsageTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one LLM stream's usage: adds to the cumulative total and
    /// makes it the latest observed stream.
    pub fn record(&self, u: Usage) {
        if let Ok(mut st) = self.inner.lock() {
            st.total += u;
            st.latest = u;
        }
    }

    /// The usage of the most recent LLM stream (zeroed when none yet).
    pub fn latest(&self) -> Usage {
        self.inner.lock().map(|st| st.latest).unwrap_or_default()
    }

    /// Cumulative usage across all recorded streams.
    pub fn total(&self) -> Usage {
        self.inner.lock().map(|st| st.total).unwrap_or_default()
    }
}


impl DefaultAgentLoop {
    /// Build a loop from an AgentConfig (no cancellation signal, no sink).
    pub fn new(config: AgentConfig) -> Self {
        Self::with_bindings(config, None, None, None)
    }

    /// Build a loop that stops cooperatively once the watch value reads true.
    /// The sender half is owned by the caller (e.g. hooked to ctrl_c at the
    /// composition / CLI layer).
    pub fn with_cancel(config: AgentConfig, cancel: watch::Receiver<bool>) -> Self {
        Self::with_bindings(config, Some(cancel), None, None)
    }

    /// Build a loop that routes every LoopEvent to the given sink (stream
    /// deltas and tool events are no longer printed).
    pub fn with_sink(config: AgentConfig, sink: EventSink) -> Self {
        Self::with_bindings(config, None, Some(sink), None)
    }

    /// Build a loop with both a cooperative cancel signal and an event sink.
    pub fn with_cancel_sink(
        config: AgentConfig,
        cancel: watch::Receiver<bool>,
        sink: EventSink,
    ) -> Self {
        Self::with_bindings(config, Some(cancel), Some(sink), None)
    }

    /// Build a loop with every optional binding (W220): cooperative
    /// cancellation, an event sink, and a shared usage tracker. The
    /// convenience constructors above pass None for the unbound slots, so all
    /// existing call sites keep working unchanged.
    pub fn with_bindings(
        config: AgentConfig,
        cancel: Option<watch::Receiver<bool>>,
        sink: Option<EventSink>,
        usage: Option<Arc<UsageTracker>>,
    ) -> Self {
        Self { config, cancel, sink, usage }
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

/// W252: persist one accumulated "continuous thinking segment" as a single
/// [SessionEvent::ThinkingDelta] (no-op when the buffer is empty).
///
/// The session log is the source of truth for replay, but thinking deltas
/// stream token-by-token: writing one jsonl row per delta would explode the
/// log. Instead the loop concatenates consecutive deltas into a buffer and
/// flushes it only at visible boundaries (Text / Done / stream end), so one
/// contiguous reasoning burst becomes exactly ONE persisted row.
fn flush_thinking(session: &SessionService, buf: &mut String) {
    if buf.is_empty() {
        return;
    }
    let text = std::mem::take(buf);
    session.append(SessionEvent::ThinkingDelta { text });
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

        // Turn bookkeeping: the session log is the single source of truth, and
        // it owns the monotonic turn id counter, so ids stay unique across
        // loop instances (the runtime rebuilds a loop per turn) and restarts.
        let turn_id = session.next_turn_id();
        session.append(SessionEvent::TurnStart { id: turn_id.clone() });
        session.append(SessionEvent::UserMessage { text: user_input.to_string() });

        // Cooperative cancellation (W191). Clone the receiver for this turn;
        // None (the default) keeps the pre-cancel "never cancelled" behavior.
        // At each await checkpoint we select!() the real work against wait_cancel;
        // a cancel makes the loop stop and return gracefully (TurnEnd appended).
        let mut cancel_rx = self.cancel.clone();
        let mut cancel_requested = false;

        // max_steps == 0 means unlimited steps (W220); otherwise the hard cap
        // is enforced exactly as before. The loop still ends on cancellation
        // or when the model answers without tool calls.
        let mut steps_done: usize = 0;
        // P0-A real terminal states: the outcome is decided here, written to
        // TurnEnd below, and never defaults to a fake success.
        let mut outcome = TurnOutcome::Completed;
        loop {
            if self.config.max_steps > 0 && steps_done >= self.config.max_steps {
                // Budget exhausted without a final answer: NOT completed (R1).
                outcome = TurnOutcome::StepLimit;
                break;
            }
            steps_done += 1;

            // Step-level checkpoint before issuing the next model request.
            if let Some(rx) = cancel_rx.as_ref() {
                if cancel_set(rx) {
                    // Cancelled before this step: stop (TurnEnd appended below).
                    outcome = TurnOutcome::Cancelled;
                    break;
                }
            }

            // History is derived from the log, never stored separately.
            let messages = session.derive_messages();
            // Context-budget trimming (W220): when the estimated history nears
            // the configured window threshold, drop old messages and mark the
            // removal with a short system message. No-op when
            // context_window_tokens == 0 (back-compat).
            let system_tokens = estimate_tokens(&self.config.system_prompt);
            let (messages, _trim) = trim_context(
                messages,
                system_tokens,
                self.config.context_window_tokens,
                self.config.context_trim_threshold,
                self.config.context_keep_recent,
            );

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
            // generate()/stream stays interruptible through select!. A
            // generation failure is a terminal ERROR state with TurnEnd, not
            // a silent return (R1: 生成失败缺 TurnEnd).
            let mut stream = match cancel_rx.as_mut() {
                Some(rx) => {
                    tokio::select! {
                        r = llm.generate(request) => match r {
                            Ok(s) => s,
                            Err(e) => {
                                outcome = TurnOutcome::Error {
                                    kind: "generate".into(),
                                    message: e.0,
                                };
                                break;
                            }
                        },
                        _ = wait_cancel(rx) => {
                            // Cancelled before/during the model's first response:
                            // break out of the step loop (TurnEnd appended below).
                            outcome = TurnOutcome::Cancelled;
                            break;
                        }
                    }
                }
                None => match llm.generate(request).await {
                    Ok(s) => s,
                    Err(e) => {
                        outcome = TurnOutcome::Error {
                            kind: "generate".into(),
                            message: e.0,
                        };
                        break;
                    }
                },
            };

            let mut assistant_text = String::new();
            let mut tool_calls: Vec<ToolCall> = Vec::new();
            let mut saw_done = false;
            // W252: consecutive Thinking deltas aggregate here and are
            // flushed as ONE ThinkingDelta per contiguous burst (see
            // flush_thinking) so replay keeps the reasoning without one
            // persisted row per streamed delta.
            let mut thinking_buf = String::new();

            // Stream consumption loop. A cancel mid-stream drops the partial
            // turn (no incomplete AssistantMessage is flushed); a stream that
            // fails or ends without a terminal frame sets the matching
            // terminal state instead of pretending success.
            // Providers may stream trailing reasoning deltas AFTER the
            // finish_reason frame. Emitting Done the moment it arrives would
            // put such Thinking blocks after the final text/…/Done sequence
            // on the wire — the UI then renders "thinking below the reply".
            // Defer the Done emission until the stream truly ends, so any
            // late Thinking/Text still lands BEFORE Done.
            let mut pending_done: Option<Message> = None;
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
                    // A Text delta ends the current thinking segment: flush the
                    // aggregated burst BEFORE anything that follows it.
                    StreamEvent::Text(delta) => {
                        flush_thinking(&session, &mut thinking_buf);
                        self.emit(LoopEvent::Text(delta));
                    }
                    // Accumulate (concatenate) consecutive thinking deltas;
                    // they persist as one row at the next boundary.
                    StreamEvent::Thinking(delta) => {
                        thinking_buf.push_str(&delta);
                        self.emit(LoopEvent::Thinking(delta));
                    }
                    StreamEvent::Usage(u) => {
                        // Record provider-reported usage into the optional
                        // shared tracker (runtime /api/status surface).
                        if let Some(tracker) = &self.usage {
                            tracker.record(u);
                        }
                    }
                    StreamEvent::Done(message) => {
                        // Boundary flush: the thinking segment precedes the
                        // assistant text/tool calls it belongs to in the log.
                        flush_thinking(&session, &mut thinking_buf);
                        saw_done = true;
                        for content in &message.content {
                            match content {
                                Content::Text(text) => assistant_text.push_str(text),
                                Content::ToolCall(call) => tool_calls.push(call.clone()),
                            }
                        }
                        pending_done = Some(message);
                    }
                    StreamEvent::Failed { kind, message } => {
                        // Stream-level failure (truncated turn): terminal
                        // error. Flush the partial segment first so the
                        // reasoning that did stream survives in the log.
                        flush_thinking(&session, &mut thinking_buf);
                        outcome = TurnOutcome::Error { kind, message };
                        break;
                    }
                    StreamEvent::Interrupted => {
                        // The stream was torn without a terminal frame.
                        flush_thinking(&session, &mut thinking_buf);
                        outcome = TurnOutcome::Interrupted;
                        break;
                    }
                }
            }

            // Stream-end flush: covers trailing reasoning streamed AFTER the
            // terminal frame (providers do that), a thinking-only stream that
            // ended without Done, and a cancel mid-stream. It runs before any
            // AssistantMessage/ToolCall append below, so every thinking
            // segment lands in the log ahead of the step it belongs to.
            flush_thinking(&session, &mut thinking_buf);

            // Flush the deferred Done (if any) before terminal handling, so
            // late Thinking/Text emitted above precede it on the wire.
            if let Some(m) = pending_done.take() {
                self.emit(LoopEvent::Done(m));
            }

            if cancel_requested {
                outcome = TurnOutcome::Cancelled;
                break;
            }

            if !saw_done {
                // The stream ended before a terminal frame: interrupted
                // upstream / EOF without Done — a real terminal state, never
                // a fake Completed (and no empty AssistantMessage is
                // flushed). A Failed / Interrupted stream event has already
                // decided the outcome.
                if outcome == TurnOutcome::Completed {
                    outcome = TurnOutcome::Interrupted;
                }
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
                    parent_id: None,
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
                        parent_id: None,
                    });
                }
            }
            if cancel_requested {
                outcome = TurnOutcome::Cancelled;
                break;
            }
        }

        // P0-A: every started turn ends with exactly one TurnEnd carrying the
        // real terminal state (completed / cancelled / error / step_limit /
        // interrupted) — and the sink receives exactly one terminal TurnEnd
        // event, which consumers map onto their "done" envelope.
        session.append(SessionEvent::TurnEnd { id: turn_id, outcome: outcome.clone() });
        self.emit(LoopEvent::TurnEnd(outcome));
        Ok(())
    }
}
