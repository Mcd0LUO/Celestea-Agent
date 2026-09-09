
//! celestea-session log — the append-only conversation log (W102).
//!
//! [InMemorySessionLog] is the single source of truth for a conversation:
//! it records SessionEvents in insertion order and derives the
//! model-visible history on demand via SessionLog::derive_messages.
//! The private helpers flush_tool_calls and project implement the
//! event -> message projection used by derive_messages.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use celestea_core::{Content, Message, Role, SessionEvent, SessionLog, ToolCall};
#[cfg(test)]
use celestea_core::TurnOutcome;

/// An in-memory, append-only session log.
///
/// Thread-safe via interior mutability (RwLock<Vec<SessionEvent>>):
/// append/clear take the write lock, events/derive_messages take the read
/// lock. The log is the single source of truth; model history is always
/// derived from it, never stored separately.
#[derive(Debug, Default)]
pub struct InMemorySessionLog {
    events: RwLock<Vec<SessionEvent>>,
    /// Monotonic turn id counter (P0-A unique turn identity). Owned by the
    /// log — not the agent loop — so ids never repeat across loop instances
    /// (the runtime rebuilds a loop per turn). Never resets, even on clear.
    turn_counter: AtomicU64,
}

impl InMemorySessionLog {
    /// Create an empty session log.
    pub fn new() -> Self {
        Self { events: RwLock::new(Vec::new()), turn_counter: AtomicU64::new(0) }
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
        derive_messages_from(&self.events())
    }

    fn clear(&self) {
        if let Ok(mut events) = self.events.write() {
            events.clear();
        }
    }

    fn next_turn_id(&self) -> String {
        let n = self.turn_counter.fetch_add(1, Ordering::Relaxed);
        format!("turn-{n}")
    }
}

/// Shared event-to-message projection (W210).
///
/// Both [InMemorySessionLog] and [crate::PersistentSessionLog] derive the
/// model-visible history through this single function, so a log recovered
/// from disk produces exactly the same messages as before the restart.
pub(crate) fn derive_messages_from(events: &[SessionEvent]) -> Vec<Message> {
    let mut messages = Vec::new();
    let mut pending: Vec<ToolCall> = Vec::new();

    for event in events {
        match event {
            SessionEvent::ToolCall { id, name, args, parent_id } => {
                // W255 run_code: sub-call rows (parent_id.is_some()) stay in
                // the log for audit/replay but are never projected into the
                // model-visible history — the outer run_code round trip is
                // the only thing the model sees.
                if parent_id.is_none() {
                    pending.push(ToolCall { id: id.clone(), name: name.clone(), args: args.clone() });
                }
            }
            other => {
                flush_tool_calls(&mut messages, &mut pending);
                if let Some(msg) = project(other.clone()) {
                    messages.push(msg);
                }
            }
        }
    }

    // Trailing tool calls (no following event) still need flushing.
    flush_tool_calls(&mut messages, &mut pending);
    balance_tool_calls(&mut messages);
    messages
}

/// W267: protocol balance - every assistant "tool_calls" message must be
/// followed by one "tool" message per call id. A cancelled/interrupted turn
/// can stop between ToolCall and ToolResult, leaving a dangling call that makes
/// the whole history invalid for OpenAI-compatible upstreams
/// ("insufficient tool messages following tool_calls message"). Synthesize a
/// cancelled-result for each unanswered call so the projection stays
/// protocol-valid; the log itself is untouched (audit keeps the truth).
fn balance_tool_calls(messages: &mut Vec<Message>) {
    let mut i = 0;
    while i < messages.len() {
        let call_ids: Vec<String> = messages[i]
            .content
            .iter()
            .filter_map(|c| match c {
                Content::ToolCall(tc) => Some(tc.id.clone()),
                _ => None,
            })
            .collect();
        if call_ids.is_empty() {
            i += 1;
            continue;
        }
        // Results must be the contiguous tool messages right after the call.
        let mut answered: Vec<String> = Vec::new();
        let mut j = i + 1;
        while j < messages.len() && messages[j].role == Role::Tool {
            if let Some(id) = messages[j].tool_call_id.clone() {
                answered.push(id);
            }
            j += 1;
        }
        let missing: Vec<String> = call_ids
            .into_iter()
            .filter(|id| !answered.iter().any(|a| a == id))
            .collect();
        let mut inserted = 0usize;
        for id in missing {
            messages.insert(
                j + inserted,
                Message::tool_result(
                    id,
                    "Error: tool call was cancelled before execution (no result recorded)",
                ),
            );
            inserted += 1;
        }
        i = j + inserted + 1;
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
        SessionEvent::ToolResult { id, value, error, parent_id } => {
            // W255 run_code: sub-call results are logged but context-retained
            // (derive_messages skips them, mirroring the ToolCall arm above).
            if parent_id.is_some() {
                return None;
            }
            let text = match error {
                Some(err) if !err.is_empty() => format!("Error: {err}"),
                _ => serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string()),
            };
            Some(Message::tool_result(id, text))
        }
        SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => None,
        // W252: persisted thinking is replay-only decoration; it never enters
        // the model-visible context (context still rides assistant text/tools).
        SessionEvent::ThinkingDelta { .. } => None,
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
    fn dangling_tool_call_gets_synthetic_result() {
        // W267: a cancelled turn leaves ToolCall without ToolResult; the
        // projection must still be protocol-valid (assistant tool_calls
        // followed by one tool message per id).
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::TurnStart { id: "turn-0".into() });
        log.append(SessionEvent::UserMessage { text: "go".into() });
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "run_shell".into(),
            args: json!({"command": "sleep 1"}),
            parent_id: None,
        });
        log.append(SessionEvent::TurnEnd { id: "turn-0".into(), outcome: TurnOutcome::Cancelled });
        log.append(SessionEvent::TurnStart { id: "turn-1".into() });
        log.append(SessionEvent::UserMessage { text: "again".into() });

        let msgs = log.derive_messages();
        let call_idx = msgs
            .iter()
            .position(|m| m.content.iter().any(|c| matches!(c, Content::ToolCall(tc) if tc.id == "c1")))
            .expect("tool_calls message present");
        let next = &msgs[call_idx + 1];
        assert_eq!(next.role, Role::Tool, "synthetic result must follow the call");
        assert_eq!(next.tool_call_id.as_deref(), Some("c1"));
        assert!(msgs[call_idx + 2..].iter().any(|m| m.role == Role::User));
    }

    #[test]
    fn answered_tool_call_is_not_duplicated() {
        // W267 guard: a call with its real result must not get a synthetic one.
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "go".into() });
        log.append(SessionEvent::ToolCall {
            id: "c9".into(),
            name: "run_shell".into(),
            args: json!({"command": "echo hi"}),
            parent_id: None,
        });
        log.append(SessionEvent::ToolResult {
            id: "c9".into(),
            value: Some(json!({"stdout": "hi"})),
            error: None,
            parent_id: None,
        });
        let msgs = log.derive_messages();
        let tools: Vec<_> = msgs.iter().filter(|m| m.role == Role::Tool).collect();
        assert_eq!(tools.len(), 1, "exactly the real result, no synthetic duplicate");
        assert_eq!(tools[0].tool_call_id.as_deref(), Some("c9"));
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
            parent_id: None,
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "write_file".into(),
            args: json!({ "path": "/tmp/y", "content": "z" }),
            parent_id: None,
        });
        log.append(SessionEvent::ToolResult {
            id: "c1".into(),
            value: Some(json!({ "ok": true })),
            error: None,
            parent_id: None,
        });
        log.append(SessionEvent::ToolResult {
            id: "c2".into(),
            value: None,
            error: Some("boom".into()),
            parent_id: None,
        });
        log.append(SessionEvent::TurnEnd { id: "t1".into(), outcome: TurnOutcome::Completed });

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
    fn thinking_delta_is_skipped_by_derive_messages() {
        // W252: ThinkingDelta rows are replay-only — the derived model history
        // contains only the user/assistant/tool messages, in the same order.
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::TurnStart { id: "t1".into() });
        log.append(SessionEvent::UserMessage { text: "hi".into() });
        log.append(SessionEvent::ThinkingDelta { text: "private reasoning".into() });
        log.append(SessionEvent::AssistantMessage { text: "answer".into() });
        log.append(SessionEvent::TurnEnd { id: "t1".into(), outcome: TurnOutcome::Completed });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 2, "thinking row must not project into a message");
        assert_eq!(msgs[0].role, Role::User);
        assert_eq!(msgs[1].role, Role::Assistant);
        assert_eq!(text_of(&msgs[1]), "answer");
    }

    #[test]
    fn consecutive_tool_calls_merge_into_single_message() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/a" }),
            parent_id: None,
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "read_file".into(),
            args: json!({ "path": "/b" }),
            parent_id: None,
        });
        log.append(SessionEvent::ToolCall {
            id: "c3".into(),
            name: "read_file".into(),
            args: json!({ "path": "/c" }),
            parent_id: None,
        });

        let msgs = log.derive_messages();
        // W267: the three dangling calls each get a synthetic cancelled result,
        // so the projection is protocol-valid (1 assistant + 3 tool messages).
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 3);
        for (i, expected_id) in ["c1", "c2", "c3"].iter().enumerate() {
            match &msgs[0].content[i] {
                Content::ToolCall(tc) => assert_eq!(tc.id, *expected_id),
                other => panic!("expected tool-call content, got {other:?}"),
            }
            assert_eq!(msgs[i + 1].role, Role::Tool);
            assert_eq!(msgs[i + 1].tool_call_id.as_deref(), Some(*expected_id));
        }
    }

    #[test]
    fn tool_calls_flush_before_following_non_tool_event() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c9".into(),
            name: "list_dir".into(),
            args: json!({ "path": "/tmp" }),
            parent_id: None,
        });
        log.append(SessionEvent::UserMessage { text: "after".into() });

        let msgs = log.derive_messages();
        // W267: the dangling call is balanced by a synthetic result, then the
        // user message follows.
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 1);
        match &msgs[0].content[0] {
            Content::ToolCall(tc) => assert_eq!(tc.id, "c9"),
            other => panic!("expected tool-call content, got {other:?}"),
        }
        assert_eq!(msgs[1].role, Role::Tool);
        assert_eq!(msgs[1].tool_call_id.as_deref(), Some("c9"));
        assert_eq!(msgs[2].role, Role::User);
        assert_eq!(text_of(&msgs[2]), "after");
    }

    #[test]
    fn tool_result_with_empty_error_falls_back_to_value() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolResult {
            id: "c3".into(),
            value: Some(json!("fallback")),
            error: Some(String::new()),
            parent_id: None,
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

    #[test]
    fn next_turn_id_is_monotonic_and_survives_clear() {
        let log = InMemorySessionLog::new();
        assert_eq!(log.next_turn_id(), "turn-0");
        assert_eq!(log.next_turn_id(), "turn-1");
        // The counter is log state, not event state: clear() wipes events but
        // ids already handed out are never reused (P0-A 唯一身份).
        log.append(SessionEvent::UserMessage { text: "x".into() });
        log.clear();
        assert_eq!(log.next_turn_id(), "turn-2");
    }

    /// W255 run_code: nested (parent_id.is_some()) ToolCall/ToolResult rows
    /// stay in the log (events() sees the full subtree) but never reach the
    /// model-visible history — derive_messages projects only the outer
    /// run_code ToolCall + ToolResult.
    #[test]
    fn nested_run_code_sub_call_rows_are_context_retained() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "fold this".into() });
        // outer run_code call (parent_id None -> visible)
        log.append(SessionEvent::ToolCall {
            id: "rc1".into(),
            name: "run_code".into(),
            args: json!({ "code": "pass" }),
            parent_id: None,
        });
        // sub-call emitted by the parent-broker (parent_id Some -> logged only)
        log.append(SessionEvent::ToolCall {
            id: "rc1:c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/tmp/x" }),
            parent_id: Some("rc1".into()),
        });
        log.append(SessionEvent::ToolResult {
            id: "rc1:c1".into(),
            value: Some(json!("first line")),
            error: None,
            parent_id: Some("rc1".into()),
        });
        // outer result (visible)
        log.append(SessionEvent::ToolResult {
            id: "rc1".into(),
            value: Some(json!("first line")),
            error: None,
            parent_id: None,
        });

        let events = log.events();
        assert_eq!(events.len(), 5, "log keeps the full subtree for audit/replay");

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 3, "user + outer tool_call + outer tool_result only");
        assert_eq!(msgs[0].role, Role::User);
        assert!(matches!(msgs[1].role, Role::Assistant));
        match &msgs[1].content[0] {
            Content::ToolCall(tc) => {
                assert_eq!(tc.id, "rc1");
                assert_eq!(tc.name, "run_code");
            }
            other => panic!("expected outer tool call, got {other:?}"),
        }
        assert_eq!(msgs[2].role, Role::Tool);
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("rc1"));
        assert_eq!(text_of(&msgs[2]), r#""first line""#);
    }
}
