//! Context-budget utilities for the agent loop (W220).
//!
//! Token estimation operates on the model-facing messages only and is used
//! for the trim decision — it is deliberately approximate (chars/4), a common
//! heuristic that keeps the loop independent of any tokenizer. Real usage
//! numbers (celestea_core::Usage) are reported by the LLM provider and are
//! handled by the loop/runtime; the estimator only decides *when* to trim.

use celestea_core::{Content, Message, Role};

/// Per-message structural overhead (role + framing) in the estimate.
const MESSAGE_OVERHEAD_TOKENS: u64 = 4;
/// Per-tool-call structural overhead in the estimate.
const TOOL_CALL_OVERHEAD_TOKENS: u64 = 10;

/// Estimate the token count of a text fragment (UTF-8 bytes / 4).
///
/// Rough but monotone: used only to compare against a window budget, never to
/// bill or to report real usage. A Chinese character (3 UTF-8 bytes)
/// estimates to ~0.75 tokens, an ASCII char to ~0.25 — both in the same
/// ballpark as common BPE tokenizers.
pub fn estimate_tokens(text: &str) -> u64 {
    let len = text.len() as u64;
    (len + 3) / 4
}

/// Estimate the token count of one message (content + structural overhead).
pub fn estimate_message_tokens(msg: &Message) -> u64 {
    let mut n = MESSAGE_OVERHEAD_TOKENS;
    for c in &msg.content {
        match c {
            Content::Text(t) => n += estimate_tokens(t),
            Content::ToolCall(tc) => {
                n += TOOL_CALL_OVERHEAD_TOKENS
                    + estimate_tokens(&tc.name)
                    + estimate_tokens(&tc.args.to_string());
            }
        }
    }
    if let Some(id) = &msg.tool_call_id {
        n += estimate_tokens(id);
    }
    n
}

/// Estimate the total token count of a message list.
pub fn estimate_messages_tokens(messages: &[Message]) -> u64 {
    messages.iter().map(estimate_message_tokens).sum()
}

/// The outcome of a trim pass over the derived message history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrimOutcome {
    /// How many messages were removed (0 = nothing trimmed).
    pub removed_messages: usize,
    /// Estimated tokens of the removed messages.
    pub removed_tokens: u64,
}

impl TrimOutcome {
    /// True when the history was actually trimmed this pass.
    pub fn trimmed(&self) -> bool {
        self.removed_messages > 0
    }
}

/// Mark the removal of earlier messages with one short system message, so the
/// model knows older context was dropped (and can ask the user to restate it)
/// instead of silently missing it.
pub fn trimmed_marker_message(removed_messages: usize, removed_tokens: u64) -> Message {
    let text = format!(
        "[context-trimmed] Earlier conversation was trimmed to fit the context          budget: {removed_messages} message(s) ~{removed_tokens} tokens removed.          Continue from the recent messages below; ask the user to restate any          earlier detail you need."
    );
    Message::system(text)
}

/// Trim an over-budget message history to fit the context window (W220 v1).
///
/// Policy: keep the keep_recent most recent messages (plus any Role::System
/// messages, which are always retained) and mark the removal with one short
/// system message.
///
/// Protocol safety: every cut lands on a System/User message boundary, so an
/// assistant tool-call message and its Tool results are never split, and the
/// trimmed history never starts with an orphaned Tool message.
///
/// context_window_tokens == 0 disables trimming (history returned as-is).
/// system_tokens is the estimated size of the outside system prompt
/// (ModelRequest::system): it is never trimmed and counts into the budget.
pub fn trim_context(
    messages: Vec<Message>,
    system_tokens: u64,
    context_window_tokens: u64,
    threshold: f64,
    keep_recent: usize,
) -> (Vec<Message>, TrimOutcome) {
    let no_trim = TrimOutcome { removed_messages: 0, removed_tokens: 0 };
    if context_window_tokens == 0 {
        return (messages, no_trim);
    }
    let budget = ((context_window_tokens as f64) * threshold.clamp(0.0, 1.0)).max(1.0) as u64;
    if system_tokens + estimate_messages_tokens(&messages) <= budget {
        return (messages, no_trim);
    }

    // Role::System messages are always kept and stay first (system + recent N).
    let mut system_msgs: Vec<Message> = Vec::new();
    let mut rest: Vec<Message> = Vec::new();
    for m in messages {
        if m.role == Role::System {
            system_msgs.push(m);
        } else {
            rest.push(m);
        }
    }
    let n = rest.len();
    if n == 0 {
        // Only system messages: nothing to trim.
        let mut all = system_msgs;
        all.extend(rest);
        return (all, no_trim);
    }

    let keep = keep_recent.max(1);
    // Protocol-safe cut positions: a suffix must start at a System/User
    // boundary so tool-call groups stay intact and no Tool message is orphaned.
    let safe_cuts: Vec<usize> =
        (0..n).filter(|&p| matches!(rest[p].role, Role::System | Role::User)).collect();
    if safe_cuts.is_empty() {
        // No safe boundary: do not risk breaking the protocol.
        let mut all = system_msgs;
        all.extend(rest);
        return (all, no_trim);
    }

    let suffix_tokens = |cand: usize| system_tokens + estimate_messages_tokens(&rest[cand..]);
    // Preferred cut: keep exactly the keep most-recent messages (drop the
    // older ones), bumped to the next safe boundary when that index is inside
    // a tool-call group.
    let preferred = n.saturating_sub(keep);
    let within_keep = safe_cuts.iter().copied().find(|&c| c >= preferred);
    // Smallest cut whose suffix fits the budget (keeps the most that fits).
    let fits_budget = safe_cuts.iter().copied().find(|&c| suffix_tokens(c) <= budget);
    let cut = match (within_keep, fits_budget) {
        (Some(w), Some(f)) if w >= f => w, // keeping keep recent already fits
        (Some(_), Some(f)) => f,           // keep recent is over budget: trim more
        (Some(w), None) => w,              // nothing fits: still keep at most keep
        (None, Some(f)) => f,
        (None, None) => *safe_cuts.last().unwrap(),
    };

    let removed_messages = cut;
    let removed_tokens = estimate_messages_tokens(&rest[..cut]);
    let kept = rest.split_off(cut);
    let marker = trimmed_marker_message(removed_messages, removed_tokens);
    let mut out = system_msgs;
    out.push(marker);
    out.extend(kept);
    (out, TrimOutcome { removed_messages, removed_tokens })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_call(msg_id: &str) -> Message {
        Message::assistant_tool_call(celestea_core::ToolCall {
            id: msg_id.into(),
            name: "read_file".into(),
            args: json!({ "path": "/tmp/x" }),
        })
    }

    fn long_user(text: &str) -> Message {
        Message::user(text)
    }

    #[test]
    fn estimate_tokens_is_bytes_over_four() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("aaaa"), 1);
        assert_eq!(estimate_tokens("aaaaa"), 2);
        // 3-byte CJK char counts ~0.75 tokens (byte/4 rounding up).
        assert_eq!(estimate_tokens("汉"), 1);
    }

    #[test]
    fn trim_disabled_when_window_zero() {
        let msgs = vec![long_user("x"), long_user("y")];
        let (out, outcome) = trim_context(msgs.clone(), 0, 0, 0.8, 10);
        assert_eq!(out.len(), msgs.len());
        assert!(!outcome.trimmed());
    }

    #[test]
    fn trim_is_noop_under_budget() {
        let msgs = vec![long_user("hello"), long_user("hi")];
        let (out, outcome) = trim_context(msgs.clone(), 10, 65536, 0.8, 10);
        assert_eq!(out.len(), msgs.len());
        assert!(!outcome.trimmed());
    }

    #[test]
    fn trim_keeps_recent_and_marks_with_system_message() {
        let mut msgs = Vec::new();
        for i in 0..30 {
            msgs.push(long_user(&format!("message {i} ").repeat(20)));
        }
        let (out, outcome) = trim_context(msgs, 0, 1000, 0.8, 4);
        assert!(outcome.trimmed());
        assert_eq!(outcome.removed_messages, 26);
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].role, Role::System);
        assert!(matches!(&out[0].content[0], Content::Text(t) if t.contains("context-trimmed")));
        let kept: Vec<String> = out[1..].iter().map(|m| match &m.content[0] {
            Content::Text(t) => t.clone(),
            _ => String::new(),
        }).collect();
        assert_eq!(kept, vec![
            "message 26 ".repeat(20),
            "message 27 ".repeat(20),
            "message 28 ".repeat(20),
            "message 29 ".repeat(20),
        ]);
    }

    #[test]
    fn trim_keeps_all_system_messages_first() {
        let mut msgs = vec![Message::system("persist me")];
        for i in 0..20 {
            msgs.push(long_user(&format!("u{i}").repeat(30)));
        }
        let (out, outcome) = trim_context(msgs, 0, 400, 0.8, 5);
        assert!(outcome.trimmed());
        assert_eq!(out[0].role, Role::System);
        assert!(matches!(&out[0].content[0], Content::Text(t) if t == "persist me"));
    }

    #[test]
    fn trim_never_splits_tool_call_groups() {
        let long = |s: &str| s.repeat(30);
        let msgs = vec![
            long_user(&long("older question ")),
            tool_call("c1"),
            Message::tool_result("c1", &long("answer here ")),
            Message::tool_result("c2", &long("second result ")),
            long_user(&long("new question ")),
            Message::assistant_text(&long("final answer ")),
        ];
        let (out, outcome) = trim_context(msgs, 0, 200, 0.8, 4);
        assert!(outcome.trimmed());
        // Head must be the marker, then a User boundary (never Assistant/Tool);
        // the surviving group is intact (user + its assistant reply).
        assert_eq!(out[0].role, Role::System);
        assert!(matches!(&out[0].content[0], Content::Text(t) if t.contains("context-trimmed")));
        assert_eq!(out[1].role, Role::User);
        assert!(matches!(&out[1].content[0], Content::Text(t) if t.starts_with("new question")));
        assert_eq!(out[2].role, Role::Assistant);
        assert_eq!(out.len(), 3, "marker + user + assistant reply only");
    }

    #[test]
    fn trim_budget_beats_keep_recent() {
        // keep_recent is generous (10) but the budget fits ~8 messages: the cut
        // must trim further than keep_recent when the recent window is over
        // budget, yet keep as many as the budget allows.
        let mut msgs = Vec::new();
        for i in 0..10 {
            msgs.push(long_user(&format!("{i} ").repeat(50)));
        }
        let (out, outcome) = trim_context(msgs, 0, 300, 0.8, 10);
        assert!(outcome.trimmed());
        assert_eq!(outcome.removed_messages, 2);
        assert!(out.len() >= 2, "at least the marker + one message");
        assert!(out.len() < 11, "budget forces keeping fewer than all 10");
    }
}
