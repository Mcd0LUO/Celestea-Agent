//! Read-only Rust↔TS parity probe: replays a cli-main.jsonl exactly like the
//! engine's PersistentSessionLog and prints the canonical derive_messages JSON.
use celestea_core::{Content, Message, Role, SessionEvent, SessionLog};
use celestea_session::InMemorySessionLog;
use serde_json::{json, Value};
use std::io::BufRead;

fn role_str(r: &Role) -> &'static str {
    match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn msg_json(m: &Message) -> Value {
    let content: Vec<Value> = m
        .content
        .iter()
        .map(|c| match c {
            Content::Text(t) => json!({ "type": "text", "content": t }),
            Content::ToolCall(tc) => {
                json!({ "type": "tool_call", "content": { "id": tc.id, "name": tc.name, "args": tc.args } })
            }
        })
        .collect();
    json!({ "role": role_str(&m.role), "content": content, "tool_call_id": m.tool_call_id })
}

/// Same contract as PersistentSessionLog::replay: blank lines are padding,
/// parsing stops at the first unparsable line.
fn replay(path: &str) -> Vec<SessionEvent> {
    let f = std::fs::File::open(path).expect("open");
    let mut out = Vec::new();
    for line in std::io::BufReader::new(f).lines() {
        let line = line.expect("read line");
        let t = line.trim_end_matches(['\r', '\n']);
        if t.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionEvent>(t) {
            Ok(ev) => out.push(ev),
            Err(e) => {
                eprintln!("[parity] torn tail at line {}: {e}", out.len() + 1);
                break;
            }
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let events = replay(path);
    let log = InMemorySessionLog::new();
    for ev in &events {
        log.append(ev.clone());
    }
    let msgs: Vec<Value> = log.derive_messages().iter().map(msg_json).collect();
    let out = json!({
        "path": path,
        "events": events.len(),
        "next_turn_id": log.next_turn_id(),
        "messages": msgs,
    });
    println!("{}", serde_json::to_string(&out).expect("serialize"));
}
