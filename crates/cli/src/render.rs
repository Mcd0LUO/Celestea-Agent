//! REPL command surface, tool/profile formatting, and the one-shot turn
//! summary used for --json output.

use celestea_core::{SessionEvent, ToolSpec};
use celestea_llm::ReasoningEffort;
use serde_json::Value;

use crate::config::Profile;

// ============================================================================
// REPL command surface
// ============================================================================

/// A leading-`/` command in the REPL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReplCommand {
    Tools,
    Model,
    Clear,
    Profile,
    Exit,
    Unknown(String),
}

/// Parse a leading `/` command. Returns None for ordinary user input (no
/// leading slash), which then flows to run_turn. `/exit` is the slashed form
/// of the legacy `exit`/`quit`.
pub(crate) fn parse_repl_command(line: &str) -> Option<ReplCommand> {
    let rest = line.trim().strip_prefix('/')?;
    Some(match rest {
        "tools" => ReplCommand::Tools,
        "model" => ReplCommand::Model,
        "clear" => ReplCommand::Clear,
        "profile" => ReplCommand::Profile,
        "exit" | "quit" => ReplCommand::Exit,
        other => ReplCommand::Unknown(other.to_string()),
    })
}

/// Every /-command word (without the leading slash), in a canonical order.
/// 'quit' is an alias for 'exit' and is offered for completion too.
pub(crate) const REPL_COMMANDS: [&str; 6] = ["tools", "model", "clear", "profile", "exit", "quit"];

/// Prefix-match completion for a leading-/ command line. Returns the full
/// /command candidates (sorted, deduped) whose name starts with the typed
/// prefix after the slash; empty when the line is not a / command or nothing
/// matches. Pure - unit tested.
pub(crate) fn complete_repl_command(line: &str) -> Vec<String> {
    let Some(prefix) = line.trim().strip_prefix('/') else {
        return Vec::new();
    };
    let mut cands: Vec<String> = REPL_COMMANDS
        .iter()
        .filter(|cmd| cmd.starts_with(prefix))
        .map(|cmd| format!("/{}", cmd))
        .collect();
    cands.sort();
    cands.dedup();
    cands
}

/// Human-readable listing of the registered tools (name + description).
pub(crate) fn format_tool_list(specs: &[ToolSpec]) -> String {
    let mut out = String::new();
    for spec in specs {
        out.push_str(&format!("{:<18} {}\n", spec.name, spec.description));
    }
    out
}

/// Human-readable rendering of the active profile.
pub(crate) fn format_profile(profile: &Profile) -> String {
    let mut out = format!(
        "model: {}\nsystem_prompt: {}\nmax_steps: {}\nmax_parallel_tool_calls: {}",
        profile.model,
        profile.system_prompt,
        profile.max_steps,
        profile.max_parallel_tool_calls
    );
    if let Some(base_url) = &profile.base_url {
        out.push_str(&format!("\nbase_url: {base_url}"));
    }
    if let Some(effort) = profile.reasoning_effort {
        let name = match effort {
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
        };
        out.push_str(&format!("\nreasoning_effort: {name}"));
    }
    if let Some(tokens) = profile.max_output_tokens {
        out.push_str(&format!("\nmax_output_tokens: {tokens}"));
    }
    out.push_str(&format!("\napi_key_env: {}", profile.api_key_env));
    if let Some(f) = &profile.api_key_file {
        out.push_str(&format!("\napi_key_file: {f}"));
    }
    out
}

// ============================================================================
// One-shot turn summary (for --json), derived from the session log
// ============================================================================

/// Structured summary of one turn, ready to serialize for `--json`.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct TurnSummary {
    pub(crate) turn: String,
    pub(crate) assistant_text: String,
    pub(crate) tool_calls: Vec<ToolCallRec>,
    pub(crate) results: Vec<ToolResultRec>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolCallRec {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) args: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolResultRec {
    pub(crate) id: String,
    pub(crate) value: Option<Value>,
    pub(crate) error: Option<String>,
}

impl TurnSummary {
    /// Render as the `--json` document: {turn, assistant_text, tool_calls,
    /// results, error?}.
    pub(crate) fn to_json(&self, error: Option<&str>) -> Value {
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
pub(crate) fn summarize_turn(events: &[SessionEvent]) -> TurnSummary {
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

    #[test]
    fn complete_repl_command_prefix_matches_single() {
        assert_eq!(complete_repl_command("/t"), vec!["/tools".to_string()]);
        assert_eq!(complete_repl_command("/m"), vec!["/model".to_string()]);
        assert_eq!(complete_repl_command("/c"), vec!["/clear".to_string()]);
        assert_eq!(complete_repl_command("/p"), vec!["/profile".to_string()]);
        assert_eq!(complete_repl_command("/e"), vec!["/exit".to_string()]);
        assert_eq!(complete_repl_command("/q"), vec!["/quit".to_string()]);
    }

    #[test]
    fn complete_repl_command_empty_prefix_lists_all_sorted() {
        assert_eq!(
            complete_repl_command("/"),
            vec![
                "/clear".to_string(),
                "/exit".to_string(),
                "/model".to_string(),
                "/profile".to_string(),
                "/quit".to_string(),
                "/tools".to_string(),
            ]
        );
    }

    #[test]
    fn complete_repl_command_no_match_or_not_slash_is_empty() {
        assert!(complete_repl_command("/x").is_empty());
        assert!(complete_repl_command("hello").is_empty());
        assert!(complete_repl_command("").is_empty());
    }

    #[test]
    fn complete_repl_command_trims_leading_whitespace_and_dedups() {
        assert_eq!(complete_repl_command("  /cl"), vec!["/clear".to_string()]);
        assert_eq!(complete_repl_command("/tools"), vec!["/tools".to_string()]);
    }
}

