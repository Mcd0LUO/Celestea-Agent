//! Event plumbing for the agent loop: the turn-level LoopEvent and the
//! optional EventSink injected into a DefaultAgentLoop.
//!
//! Kept separate from the loop driver so the event type and its sink can be
//! used (and unit-tested) without pulling in the whole turn loop.

use std::sync::Arc;

use serde_json::Value;
use celestea_core::{Message, ToolOutput, TurnOutcome};

/// An event a running turn delivers to an injected sink. This is the
/// agent-loop view of the turn: it carries the LLM stream events
/// (Text/Thinking/Done, mirroring StreamEvent) plus the tool lifecycle
/// (ToolCall + the full ToolOutput for its ToolResult), so a rich UI can draw
/// tool cards and style thinking without scraping the session log or relying
/// on StreamEvent growing variants (core is frozen for P1).
///
/// P0-A: every started turn emits exactly ONE terminal [LoopEvent::TurnEnd]
/// carrying the real terminal state — consumers map it onto their "done"
/// envelope (SSE done with an outcome field), so cancelled / error /
/// step-limit / interrupted turns can never be mistaken for completed ones.
#[derive(Debug, Clone)]
pub enum LoopEvent {
    Text(String),
    Thinking(String),
    /// The authoritative assistant reply of one model step (not terminal:
    /// a tool-call step is followed by more events).
    Done(Message),
    ToolCall { id: String, name: String, args: Value },
    ToolResult(ToolOutput),
    /// Terminal turn verdict, emitted exactly once per turn on every path
    /// (completed / cancelled / error / step_limit / interrupted).
    TurnEnd(TurnOutcome),
}

/// A sink receives every LoopEvent a turn produces, in log order. None on
/// the loop (the default) keeps the legacy behavior: Text/Thinking deltas are
/// printed straight to stdout.
pub type EventSink = Arc<dyn Fn(LoopEvent) + Send + Sync>;

