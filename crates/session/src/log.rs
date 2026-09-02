
//! celestea-session log — the append-only conversation log (W102).
//!
//! [InMemorySessionLog] is the single source of truth for a conversation:
//! it records SessionEvents in insertion order and derives the
//! model-visible history on demand via SessionLog::derive_messages.
//! The private helpers flush_tool_calls and project implement the
//! event -> message projection used by derive_messages.

use std::sync::RwLock;
use celestea_core::{Content, Message, Role, SessionEvent, SessionLog, ToolCall};

/// An in-memory, append-only session log.
///
/// Thread-safe via interior mutability (RwLock<Vec<SessionEvent>>):
/// append/clear take the write lock, events/derive_messages take the read
/// lock. The log is the single source of truth; model history is always
/// derived from it, never stored separately.
#[derive(Debug, Default)]
pub struct InMemorySessionLog {
    events: RwLock<Vec<SessionEvent>>,
}

impl InMemorySessionLog {
    /// Create an empty session log.
    pub fn new() -> Self {
        Self { events: RwLock::new(Vec::new()) }
    }
}

impl SessionLog for InMemorySessionLog {
    fn append(&self, event: SessionEvent) {
        // A poisoned lock only happens after a panic while holding the write
        // lock; degrade gracefully by ignoring the append rather than
        // propagating the poison to the caller.
        if let Ok(mut events) = self.events.write() {
            events.push(event);
        }
    }

    fn events(&self) -> Vec<SessionEvent> {
        self.events.read().map(|g| g.clone()).unwrap_or_default()
    }

    fn derive_messages(&self) -> Vec<Message> {
        let mut messages = Vec::new();
        let mut pending: Vec<ToolCall> = Vec::new();

        for event in self.events() {
            match event {
                SessionEvent::ToolCall { id, name, args } => {
                    pending.push(ToolCall { id, name, args });
                }
                other => {
                    flush_tool_calls(&mut messages, &mut pending);
                    if let Some(msg) = project(other) {
                        messages.push(msg);
                    }
                }
            }
        }

        // Trailing tool calls (no following event) still need flushing.
        flush_tool_calls(&mut messages, &mut pending);
        messages
    }

    fn clear(&self) {
        if let Ok(mut events) = self.events.write() {
            events.clear();
        }
    }
}

/// Flush any accumulated tool calls as a single assistant message whose
/// content holds one Content::ToolCall per call. LLM protocols require all
/// tool_calls of a turn to ride in one assistant message, followed by the
/// individual tool results.
fn flush_tool_calls(messages: &mut Vec<Message>, pending: &mut Vec<ToolCall>) {
    if pending.is_empty() {
        return;
    }
    let calls = std::mem::take(pending);
    messages.push(Message {
        role: Role::Assistant,
        content: calls.into_iter().map(Content::ToolCall).collect(),
        tool_call_id: None,
    });
}

/// Project a single non-tool-call SessionEvent into its model-visible
/// Message form.
///
/// - UserMessage -> Message::user
/// - AssistantMessage -> Message::assistant_text
/// - ToolResult -> Message::tool_result: a non-empty error becomes
///   "Error: {error}", otherwise the value is JSON-serialized.
/// - TurnStart / TurnEnd -> skipped (structural markers, not model input).
///
/// ToolCall events never reach this function; they are accumulated and merged
/// by derive_messages, so the ToolCall arm is unreachable.
fn project(event: SessionEvent) -> Option<Message> {
    match event {
        SessionEvent::UserMessage { text } => Some(Message::user(text)),
        SessionEvent::AssistantMessage { text } => Some(Message::assistant_text(text)),
        SessionEvent::ToolResult { id, value, error } => {
            let text = match error {
                Some(err) if !err.is_empty() => format!("Error: {err}"),
                _ => serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string()),
            };
            Some(Message::tool_result(id, text))
        }
        SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => None,
        SessionEvent::ToolCall { .. } => {
            unreachable!("ToolCall must be accumulated by derive_messages, not projected")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Extract the single text content of a message, panicking otherwise.
    fn text_of(msg: &Message) -> &str {
        match msg.content.as_slice() {
            [Content::Text(t)] => t,
            other => panic!("expected single text content, got {other:?}"),
        }
    }

    #[test]
    fn new_is_empty() {
        let log = InMemorySessionLog::new();
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
    }

    #[test]
    fn append_events_preserves_order() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "a".into() });
        log.append(SessionEvent::UserMessage { text: "b".into() });

        let events = log.events();
        assert_eq!(events.len(), 2);
        match &events[0] {
            SessionEvent::UserMessage { text } => assert_eq!(text, "a"),
            other => panic!("unexpected event {other:?}"),
        }
        match &events[1] {
            SessionEvent::UserMessage { text } => assert_eq!(text, "b"),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[test]
    fn derive_messages_roundtrip() {
        let log = InMemorySessionLog::new();

        log.append(SessionEvent::TurnStart { id: "t1".into() });
        log.append(SessionEvent::UserMessage { text: "hello".into() });
        log.append(SessionEvent::AssistantMessage { text: "hi there".into() });
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/tmp/x" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "write_file".into(),
            args: json!({ "path": "/tmp/y", "content": "z" }),
        });
        log.append(SessionEvent::ToolResult {
            id: "c1".into(),
            value: Some(json!({ "ok": true })),
            error: None,
        });
        log.append(SessionEvent::ToolResult {
            id: "c2".into(),
            value: None,
            error: Some("boom".into()),
        });
        log.append(SessionEvent::TurnEnd { id: "t1".into() });

        let msgs = log.derive_messages();

        // TurnStart/TurnEnd skipped; two consecutive ToolCalls merge into one
        // assistant message, so: user, assistant, merged tool-calls, 2 results.
        assert_eq!(msgs.len(), 5);

        // UserMessage -> Message::user
        assert_eq!(msgs[0].role, Role::User);
        assert_eq!(text_of(&msgs[0]), "hello");
        assert!(msgs[0].tool_call_id.is_none());

        // AssistantMessage -> Message::assistant_text
        assert_eq!(msgs[1].role, Role::Assistant);
        assert_eq!(text_of(&msgs[1]), "hi there");
        assert!(msgs[1].tool_call_id.is_none());

        // Two ToolCalls -> ONE assistant message with two Content::ToolCall.
        assert_eq!(msgs[2].role, Role::Assistant);
        assert!(msgs[2].tool_call_id.is_none());
        assert_eq!(msgs[2].content.len(), 2);
        match &msgs[2].content[0] {
            Content::ToolCall(tc) => {
                assert_eq!(tc.id, "c1");
                assert_eq!(tc.name, "read_file");
                assert_eq!(tc.args, json!({ "path": "/tmp/x" }));
            }
            other => panic!("expected tool-call content, got {other:?}"),
        }
        match &msgs[2].content[1] {
            Content::ToolCall(tc) => {
                assert_eq!(tc.id, "c2");
                assert_eq!(tc.name, "write_file");
                assert_eq!(tc.args, json!({ "path": "/tmp/y", "content": "z" }));
            }
            other => panic!("expected tool-call content, got {other:?}"),
        }

        // ToolResult (value) -> JSON-serialized value text
        assert_eq!(msgs[3].role, Role::Tool);
        assert_eq!(msgs[3].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(text_of(&msgs[3]), r#"{"ok":true}"#);

        // ToolResult (error) -> "Error: {error}"
        assert_eq!(msgs[4].role, Role::Tool);
        assert_eq!(msgs[4].tool_call_id.as_deref(), Some("c2"));
        assert_eq!(text_of(&msgs[4]), "Error: boom");
    }

    #[test]
    fn consecutive_tool_calls_merge_into_single_message() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/a" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "read_file".into(),
            args: json!({ "path": "/b" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c3".into(),
            name: "read_file".into(),
            args: json!({ "path": "/c" }),
        });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 3);
        for (i, expected_id) in ["c1", "c2", "c3"].iter().enumerate() {
            match &msgs[0].content[i] {
                Content::ToolCall(tc) => assert_eq!(tc.id, *expected_id),
                other => panic!("expected tool-call content, got {other:?}"),
            }
        }
    }

    #[test]
    fn tool_calls_flush_before_following_non_tool_event() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c9".into(),
            name: "list_dir".into(),
            args: json!({ "path": "/tmp" }),
        });
        log.append(SessionEvent::UserMessage { text: "after".into() });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 1);
        match &msgs[0].content[0] {
            Content::ToolCall(tc) => assert_eq!(tc.id, "c9"),
            other => panic!("expected tool-call content, got {other:?}"),
        }
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(text_of(&msgs[1]), "after");
    }

    #[test]
    fn tool_result_with_empty_error_falls_back_to_value() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolResult {
            id: "c3".into(),
            value: Some(json!("fallback")),
            error: Some(String::new()),
        });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(text_of(&msgs[0]), r#""fallback""#);
    }

    #[test]
    fn clear_empties_log() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "hello".into() });
        assert_eq!(log.events().len(), 1);

        log.clear();
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
    }

    #[test]
    fn log_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<InMemorySessionLog>();
    }
}
