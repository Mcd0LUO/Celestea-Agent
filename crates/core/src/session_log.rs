use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::message::Message;
// ============================================================================
// 4. Session seam (append-only log = single source of truth)
// ============================================================================

/// How a turn ended — the real terminal states (P0-A / R1).
///
/// Every started turn ends with exactly one terminal state, written to the
/// session log's `TurnEnd` and surfaced to consumers (loop sink / runtime /
/// `TurnSummary`). The log is the single source of truth; a turn that hits the
/// step budget or a stream failure is never reported as `Completed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    /// Normal end: the model answered without further tool calls.
    Completed,
    /// The cooperative cancel signal fired (watch cancel) and the turn stopped
    /// gracefully (partial output / tool results stay in the log).
    Cancelled,
    /// LLM stream or generation failure. `kind` classifies the failure
    /// (`"generate"` = generate() returned an error, `"stream"` = the stream
    /// broke mid-flight), `message` carries the provider detail.
    Error { kind: String, message: String },
    /// max_steps was exhausted without a final assistant answer (budget
    /// exhaustion is NOT completion).
    StepLimit,
    /// The stream ended without a terminal frame (torn/interrupted upstream).
    Interrupted,
}

impl Default for TurnOutcome {
    fn default() -> Self {
        // Legacy rows predate the outcome field: a TurnEnd without one is
        // read as a completed turn (backward-compatible jsonl replay).
        TurnOutcome::Completed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    TurnStart { id: String },
    TurnEnd {
        id: String,
        /// Terminal state of the turn. `#[serde(default)]` keeps old jsonl
        /// rows (no outcome field) readable: they deserialize as Completed.
        #[serde(default)]
        outcome: TurnOutcome,
    },
    UserMessage { text: String },
    AssistantMessage { text: String },
    /// One aggregated "continuous thinking segment" (W252): the agent loop
    /// concatenates consecutive streamed reasoning deltas into ONE such event
    /// per burst, so replay keeps the chain-of-thought without one jsonl row
    /// per streamed delta. Purely additive — old jsonl files without these
    /// rows replay unchanged, and thinking never enters the model-visible
    /// history (derive_messages skips it).
    ThinkingDelta { text: String },
    ToolCall {
        id: String,
        name: String,
        args: Value,
        /// W255 run_code: Some(<parent call id>) marks a sub-call emitted by
        /// the run_code parent-broker (id = "<parent>:c<n>"). The row stays in
        /// the log for audit/replay, but `derive_messages` skips it so the
        /// model-visible history only carries the outer run_code round trip.
        /// `#[serde(default)]` keeps pre-W255 jsonl rows readable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
    ToolResult {
        id: String,
        value: Option<Value>,
        error: Option<String>,
        /// W255 run_code: same contract as ToolCall::parent_id — sub-call
        /// results are logged but never projected into the model history.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_id: Option<String>,
    },
}

pub trait SessionLog: Send + Sync {
    fn append(&self, event: SessionEvent);
    fn events(&self) -> Vec<SessionEvent>;
    /// The model-visible projection. The log is the source of truth; history is
    /// derived from it, never stored separately.
    fn derive_messages(&self) -> Vec<Message>;
    fn clear(&self);
    /// Allocate the next unique turn id (`"turn-<n>"`, monotonic). The log
    /// owns the counter — not the agent loop — so ids never repeat across
    /// loop instances; a persistent log restores its counter from the max
    /// turn id replayed from disk, so ids are never reused after a restart.
    fn next_turn_id(&self) -> String;
}

pub struct SessionService(pub Arc<dyn SessionLog>);
impl std::ops::Deref for SessionService {
    type Target = dyn SessionLog;
    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// W252: the tagged serde shape of the new variant (same `type`-tagged
    /// family as every other variant) round-trips exactly.
    #[test]
    fn thinking_delta_serde_roundtrip() {
        let ev = SessionEvent::ThinkingDelta { text: "let me think…".into() };
        let json = serde_json::to_string(&ev).expect("serialize");
        assert_eq!(json, r#"{"type":"thinking_delta","text":"let me think…"}"#);
        let back: SessionEvent = serde_json::from_str(&json).expect("deserialize");
        assert!(matches!(back, SessionEvent::ThinkingDelta { text } if text == "let me think…"));
    }

    /// W252: old jsonl (written before ThinkingDelta existed) still
    /// deserializes unchanged — the new variant is purely additive.
    #[test]
    fn legacy_jsonl_without_thinking_delta_parses() {
        for line in [
            r#"{"type":"turn_start","id":"turn-0"}"#,
            r#"{"type":"user_message","text":"hi"}"#,
            r#"{"type":"assistant_message","text":"hello"}"#,
            r#"{"type":"tool_call","id":"c1","name":"f","args":{}}"#,
            r#"{"type":"tool_result","id":"c1","value":true,"error":null}"#,
            r#"{"type":"turn_end","id":"turn-0"}"#, // legacy: no outcome field
        ] {
            let ev: SessionEvent = serde_json::from_str(line).expect("legacy row parses");
            assert!(
                !matches!(ev, SessionEvent::ThinkingDelta { .. }),
                "legacy row unexpectedly became a ThinkingDelta: {line}"
            );
        }
    }

    /// W255 run_code: pre-W255 tool_call/tool_result rows (no `parent_id`)
    /// deserialize with parent_id=None — the new field is purely additive.
    #[test]
    fn legacy_tool_rows_without_parent_id_deserialize_as_none() {
        let call: SessionEvent =
            serde_json::from_str(r#"{"type":"tool_call","id":"c1","name":"f","args":{}}"#)
                .expect("legacy tool_call parses");
        match &call {
            SessionEvent::ToolCall { parent_id, .. } => assert_eq!(*parent_id, None),
            other => panic!("expected tool_call, got {other:?}"),
        }
        let result: SessionEvent =
            serde_json::from_str(r#"{"type":"tool_result","id":"c1","value":true,"error":null}"#)
                .expect("legacy tool_result parses");
        match &result {
            SessionEvent::ToolResult { parent_id, .. } => assert_eq!(*parent_id, None),
            other => panic!("expected tool_result, got {other:?}"),
        }
    }

    /// W255 run_code: rows without a parent (parent_id=None) serialize
    /// WITHOUT the field — the pre-W255 jsonl byte shape is unchanged — while
    /// nested rows carry "parent_id".
    #[test]
    fn parent_id_serializes_only_when_present() {
        let outer = SessionEvent::ToolCall {
            id: "rc1".into(),
            name: "run_code".into(),
            args: serde_json::json!({ "code": "pass" }),
            parent_id: None,
        };
        assert_eq!(
            serde_json::to_string(&outer).unwrap(),
            r#"{"type":"tool_call","id":"rc1","name":"run_code","args":{"code":"pass"}}"#
        );

        let nested = SessionEvent::ToolCall {
            id: "rc1:c1".into(),
            name: "read_file".into(),
            args: serde_json::json!({ "path": "/x" }),
            parent_id: Some("rc1".into()),
        };
        assert_eq!(
            serde_json::to_string(&nested).unwrap(),
            r#"{"type":"tool_call","id":"rc1:c1","name":"read_file","args":{"path":"/x"},"parent_id":"rc1"}"#
        );

        // Round trip in both directions (new field -> old reader ignores it
        // via serde's default unknown-field tolerance; old rows -> new reader
        // via #[serde(default)]).
        let back: SessionEvent =
            serde_json::from_str(&serde_json::to_string(&nested).unwrap()).unwrap();
        assert!(matches!(
            back,
            SessionEvent::ToolCall { parent_id: Some(p), .. } if p == "rc1"
        ));
    }
}
