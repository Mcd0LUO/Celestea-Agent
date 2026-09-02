use std::fmt;
use std::pin::Pin;

use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "content", rename_all = "snake_case")]
pub enum Content {
    Text(String),
    ToolCall(ToolCall),
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Content>,
    /// Set for Role::Tool so the result can be matched to its call.
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: Role::User, content: vec![Content::Text(text.into())], tool_call_id: None }
    }
    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: vec![Content::Text(text.into())], tool_call_id: None }
    }
    pub fn assistant_tool_call(call: ToolCall) -> Self {
        Self { role: Role::Assistant, content: vec![Content::ToolCall(call)], tool_call_id: None }
    }
    pub fn tool_result(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self { role: Role::Tool, content: vec![Content::Text(text.into())], tool_call_id: Some(id.into()) }
    }
}

/// The model-facing view of a tool: name, description, and a JSON Schema for args.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Stream events from a provider. Providers emit incremental deltas for the
/// UI, then a single final Message (text + tool calls) as the last event.
///
/// - StreamEvent::Text — a final-answer text delta.
/// - StreamEvent::Thinking — a chain-of-thought / reasoning delta from a
///   reasoning model (e.g. DeepSeek reasoning_content). Carried as its own
///   event so consumers can distinguish it from the final answer (W191).
/// - StreamEvent::Done — the single authoritative final message.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    Thinking(String),
    Done(Message),
}

pub type LlmStream = Pin<Box<dyn Stream<Item = StreamEvent> + Send>>;

#[derive(Debug, Clone)]
pub struct LlmError(pub String);

impl fmt::Display for LlmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for LlmError {}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_constructors_shape_content() {
        let m = Message::user("hi");
        assert!(matches!(m.role, Role::User));
        let tc = Message::assistant_tool_call(ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: serde_json::json!({ "path": "a" }),
        });
        assert!(matches!(tc.content.as_slice(), [Content::ToolCall(_)]));
        let tr = Message::tool_result("c1", "ok");
        assert_eq!(tr.tool_call_id.as_deref(), Some("c1"));
        assert!(matches!(tr.role, Role::Tool));
    }
    #[test]
    fn stream_event_thinking_is_a_distinct_variant() {
        // Thinking carries its own payload, distinct from Text and Done.
        let thinking = StreamEvent::Thinking("reasoning...".to_string());
        assert!(matches!(&thinking, StreamEvent::Thinking(_)));
        assert!(!matches!(&thinking, StreamEvent::Text(_)));
        assert!(!matches!(&thinking, StreamEvent::Done(_)));
    }

}
