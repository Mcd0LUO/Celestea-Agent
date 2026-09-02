//! Event plumbing for the agent loop: the turn-level LoopEvent and the
//! optional EventSink injected into a DefaultAgentLoop.
//!
//! Kept separate from the loop driver so the event type and its sink can be
//! used (and unit-tested) without pulling in the whole turn loop.

use std::sync::Arc;

use serde_json::Value;
use celestea_core::{Message, ToolOutput};

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

