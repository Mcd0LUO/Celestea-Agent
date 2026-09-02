//! Structured one-turn summary (extracted from the CLI render.rs, W214):
//! the machine-readable turn document a frontend (web client / server) may
//! emit after a run, derived from the session log.

use celestea_core::SessionEvent;
use serde_json::Value;

/// Structured summary of one turn, ready to serialize (the CLI --json shape):
/// {turn, assistant_text, tool_calls, results, error?}.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TurnSummary {
    pub turn: String,
    pub assistant_text: String,
    pub tool_calls: Vec<ToolCallRec>,
    pub results: Vec<ToolResultRec>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallRec {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultRec {
    pub id: String,
    pub value: Option<Value>,
    pub error: Option<String>,
}

impl TurnSummary {
    /// Render as the JSON document: {turn, assistant_text, tool_calls,
    /// results, error?}.
    pub fn to_json(&self, error: Option<&str>) -> Value {
        let mut out = serde_json::Map::new();
        out.insert("turn".to_string(), Value::String(self.turn.clone()));
        out.insert("assistant_text".to_string(), Value::String(self.assistant_text.clone()));
        out.insert(
            "tool_calls".to_string(),
            Value::Array(
                self.tool_calls
                    .iter()
                    .map(|c| serde_json::json!({ "id": c.id, "name": c.name, "args": c.args }))
                    .collect(),
            ),
        );
        out.insert(
            "results".to_string(),
            Value::Array(
                self.results
                    .iter()
                    .map(|r| {
                        let mut m = serde_json::Map::new();
                        m.insert("id".to_string(), Value::String(r.id.clone()));
                        m.insert("value".to_string(), r.value.clone().unwrap_or(Value::Null));
                        m.insert(
                            "error".to_string(),
                            match &r.error {
                                Some(e) => Value::String(e.clone()),
                                None => Value::Null,
                            },
                        );
                        Value::Object(m)
                    })
                    .collect(),
            ),
        );
        if let Some(e) = error {
            out.insert("error".to_string(), Value::String(e.to_string()));
        }
        Value::Object(out)
    }
}

/// Summarize the most recent complete turn from the session log (the single
/// source of truth), extracting assistant text, tool calls, and results in log
/// order. Pure — unit-tested without an LLM.
pub fn summarize_turn(events: &[SessionEvent]) -> TurnSummary {
    let mut start = None;
    for (i, e) in events.iter().enumerate() {
        if matches!(e, SessionEvent::TurnStart { .. }) {
            start = Some(i);
        }
    }
    let Some(start) = start else {
        // No turn has run yet (empty session log).
        return TurnSummary::default();
    };
    let turn = match &events[start] {
        SessionEvent::TurnStart { id } => id.clone(),
        _ => String::new(),
    };

    let mut summary = TurnSummary { turn, ..TurnSummary::default() };
    for e in &events[start..] {
        match e {
            SessionEvent::AssistantMessage { text } => {
                if !summary.assistant_text.is_empty() {
                    summary.assistant_text.push('\n');
                }
                summary.assistant_text.push_str(text);
            }
            SessionEvent::ToolCall { id, name, args } => {
                summary.tool_calls.push(ToolCallRec {
                    id: id.clone(),
                    name: name.clone(),
                    args: args.clone(),
                });
            }
            SessionEvent::ToolResult { id, value, error } => {
                summary.results.push(ToolResultRec {
                    id: id.clone(),
                    value: value.clone(),
                    error: error.clone(),
                });
            }
            _ => {}
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn events() -> Vec<SessionEvent> {
        vec![
            SessionEvent::TurnStart { id: "turn-7".into() },
            SessionEvent::UserMessage { text: "hi".into() },
            SessionEvent::ToolCall {
                id: "c1".into(),
                name: "list_dir".into(),
                args: json!({ "path": "/tmp" }),
            },
            SessionEvent::ToolResult {
                id: "c1".into(),
                value: Some(json!(["a"])),
                error: None,
            },
            SessionEvent::AssistantMessage { text: "done".into() },
            SessionEvent::TurnEnd { id: "turn-7".into() },
        ]
    }

    #[test]
    fn summarize_turn_extracts_text_calls_results() {
        let s = summarize_turn(&events());
        assert_eq!(s.turn, "turn-7");
        assert_eq!(s.assistant_text, "done");
        assert_eq!(s.tool_calls.len(), 1);
        assert_eq!(s.tool_calls[0].name, "list_dir");
        assert_eq!(s.tool_calls[0].args, json!({ "path": "/tmp" }));
        assert_eq!(s.results.len(), 1);
        assert_eq!(s.results[0].value, Some(json!(["a"])));
        assert_eq!(s.results[0].error, None);
    }

    #[test]
    fn summarize_turn_concatenates_multiple_assistant_texts() {
        let events = vec![
            SessionEvent::TurnStart { id: "t".into() },
            SessionEvent::AssistantMessage { text: "a".into() },
            SessionEvent::AssistantMessage { text: "b".into() },
        ];
        let s = summarize_turn(&events);
        assert_eq!(s.assistant_text, "a\nb");
    }

    #[test]
    fn summarize_turn_empty_events_is_empty() {
        let s = summarize_turn(&[]);
        assert_eq!(s.turn, "");
        assert_eq!(s.assistant_text, "");
        assert!(s.tool_calls.is_empty());
        assert!(s.results.is_empty());
    }

    #[test]
    fn turn_summary_json_shape() {
        let s = TurnSummary {
            turn: "turn-1".into(),
            assistant_text: "hi".into(),
            tool_calls: vec![ToolCallRec { id: "c1".into(), name: "t".into(), args: json!({"x": 1}) }],
            results: vec![ToolResultRec {
                id: "c1".into(),
                value: Some(json!("ok")),
                error: None,
            }],
        };
        let v = s.to_json(None);
        assert_eq!(v["turn"], "turn-1");
        assert_eq!(v["assistant_text"], "hi");
        assert_eq!(v["tool_calls"][0]["name"], "t");
        assert_eq!(v["tool_calls"][0]["args"], json!({"x": 1}));
        assert_eq!(v["results"][0]["value"], "ok");
        assert_eq!(v["results"][0]["error"], Value::Null);
        assert!(v.get("error").is_none());

        let v2 = s.to_json(Some("boom"));
        assert_eq!(v2["error"], "boom");
    }
}

