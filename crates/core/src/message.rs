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
    pub fn system(text: impl Into<String>) -> Self {
        Self { role: Role::System, content: vec![Content::Text(text.into())], tool_call_id: None }
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

/// Token usage reported by a provider for one LLM response (W220).
///
/// Mirrors the OpenAI-compatible `usage` object; providers fill a subset.
/// `cache_read` is the provider-reported cache-hit prompt tokens, whatever key
/// it arrives under (deepseek `prompt_cache_hit_tokens`, openai
/// `prompt_tokens_details.cached_tokens`, ...). Consumers accumulate it with
/// [Usage::add] / AddAssign.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cache_read: u64,
    pub reasoning_tokens: u64,
}

impl Usage {
    /// True when every counter is zero — used to skip empty usage payloads.
    pub fn is_empty(&self) -> bool {
        self.prompt_tokens == 0
            && self.completion_tokens == 0
            && self.total_tokens == 0
            && self.cache_read == 0
            && self.reasoning_tokens == 0
    }

    /// Accumulate `other` into `self` (per-field sum).
    pub fn add(&mut self, other: &Usage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.total_tokens += other.total_tokens;
        self.cache_read += other.cache_read;
        self.reasoning_tokens += other.reasoning_tokens;
    }
}

impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, rhs: Self) {
        self.add(&rhs);
    }
}

/// Stream events from a provider. Providers emit incremental deltas for the
/// UI, then a single final Message (text + tool calls) as the last event.
///
/// - StreamEvent::Text — a final-answer text delta.
/// - StreamEvent::Thinking — a chain-of-thought / reasoning delta from a
///   reasoning model (e.g. DeepSeek reasoning_content). Carried as its own
///   event so consumers can distinguish it from the final answer (W191).
/// - StreamEvent::Usage — provider-reported token usage for this response,
///   emitted when the provider reports it (stream-end usage frame or final
///   chunk), just before the authoritative Done (W220).
/// - StreamEvent::Done — the single authoritative final message.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    Text(String),
    Thinking(String),
    Usage(Usage),
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

    #[test]
    fn stream_event_usage_is_a_distinct_variant() {
        // Usage carries token counters, distinct from Text / Thinking / Done.
        let u = StreamEvent::Usage(Usage {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cache_read: 4,
            reasoning_tokens: 3,
        });
        assert!(matches!(&u, StreamEvent::Usage(_)));
        assert!(!matches!(&u, StreamEvent::Text(_)));
        assert!(!matches!(&u, StreamEvent::Thinking(_)));
        assert!(!matches!(&u, StreamEvent::Done(_)));
    }

    #[test]
    fn usage_accumulates_and_reports_empty() {
        let mut a = Usage {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
            cache_read: 4,
            reasoning_tokens: 3,
        };
        let b = Usage {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            cache_read: 1,
            reasoning_tokens: 1,
        };
        a.add(&b);
        assert_eq!(a.prompt_tokens, 11);
        assert_eq!(a.completion_tokens, 22);
        assert_eq!(a.total_tokens, 33);
        assert_eq!(a.cache_read, 5);
        assert_eq!(a.reasoning_tokens, 4);
        // AddAssign is the same as add.
        a += b;
        assert_eq!(a.prompt_tokens, 12);
        assert_eq!(a.completion_tokens, 24);
        // Empty usage is detectable (usage-only frames can carry zeroes).
        assert!(Usage::default().is_empty());
        assert!(!a.is_empty());
    }

    #[test]
    fn usage_serde_roundtrip() {
        let u = Usage {
            prompt_tokens: 100,
            completion_tokens: 200,
            total_tokens: 300,
            cache_read: 50,
            reasoning_tokens: 40,
        };
        let json = serde_json::to_string(&u).unwrap();
        assert_eq!(
            serde_json::from_str::<Usage>(&json).unwrap(),
            u,
            "usage must serialize/deserialize losslessly (flat counters)"
        );
    }

    #[test]
    fn message_system_constructor() {
        let m = Message::system("be terse");
        assert_eq!(m.role, Role::System);
        assert!(matches!(m.content.as_slice(), [Content::Text(t)] if t == "be terse"));
        assert!(m.tool_call_id.is_none());
    }

}
