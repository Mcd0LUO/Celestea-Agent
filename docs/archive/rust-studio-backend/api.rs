//! Additional HTTP API surface (W216/W237): tool surface, sanitized config,
//! statusline snapshot, and the three worker-orchestration endpoints.
//!
//! W237: the session/workspace surface moved to workspaces.rs (the new
//! workspace-registry + per-session-directory model); this file keeps the
//! engine-facing endpoints plus the shared JSONL parsing used by
//! workspaces::get_session_messages.
//!
//! Routes (mounted on the axum router in main):
//!   GET  /api/tools             -> {"tools":[{"name","description"}]}
//!   GET  /api/config            -> sanitized Profile + available models/efforts
//!   POST /api/config            -> partial hot-reload update (W225; response = new config)
//!   GET  /api/status            -> statusline snapshot + the active session id
//!   POST /api/worker/spawn      -> {"ok","sessionId","title","wid"}
//!   POST /api/worker/send       -> {"ok","delivered",...}
//!   GET  /api/worker/status     -> {"ok","total","by_status","workers":[...]}
//!
//! Worker endpoints reuse the engine worker tools (spawn_worker /
//! session_send_message) via the composed ToolRegistry, so the HTTP surface
//! can never drift from the agent tool face; worker_status is built from the
//! shared WorkerRegistry with the protocol's unified aggregate shape.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use celestea_core::ToolInput;
use celestea_runtime::{validate_model, SessionEvent};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    available_json, build_and_swap, model_reasoning, profile_to_json, DEFAULT_SYSTEM_PROMPT,
    MIN_STEPS, Shared,
};

// ---- GET /api/tools --------------------------------------------------------

/// Engine tool surface: name + description for every registered tool.
pub async fn get_tools(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let tools: Vec<Value> = gen
        .runtime
        .registry
        .schemas()
        .into_iter()
        .map(|s| json!({"name": s.name, "description": s.description}))
        .collect();
    Json(json!({"tools": tools}))
}

// ---- GET /api/config -------------------------------------------------------

/// Sanitized config JSON of the current engine generation + the deployment
/// catalog (available.models / available.efforts). Never carries an api key.
pub async fn get_config(State(st): State<Shared>) -> Json<Value> {
    let mut cfg = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.config_json.clone()
    };
    // W262: available.models is rebuilt from the LIVE providers store on every
    // read, so a provider added/edited at runtime shows up in the model picker
    // immediately (the baked generation copy can only be as fresh as its last
    // compose). The rest of the body still comes from the generation snapshot,
    // so profile fields never mix generations.
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("available".to_string(), available_json(&st.providers));
    }
    Json(cfg)
}

// ---- GET /api/status --------------------------------------------------------

/// W218 statusline snapshot — the fallback channel for the SSE status
/// payloads: {model, reasoning_effort, steps, tokens_per_sec, context_usage,
/// usage}. W263: `usage` carries the engine's latest LLM-stream counters
/// (+ cumulative `total`), `cache_hit_ratio` = cache_read / prompt_tokens, and
/// `context_usage` is the real prompt size when a usage frame exists.
/// W237: plus "session" = the active session id ("<ws>/<session>"|null) from
/// the workspace registry, so the frontend can always tell which session the
/// engine is currently bound to.
pub async fn get_status(State(st): State<Shared>) -> Json<Value> {
    let mut v = st.statusline();
    v["session"] = json!(st.workspaces.active_session());
    Json(v)
}

// ---- shared JSONL helpers (used by workspaces::get_session_messages) -------

/// Map one SessionEvent to the W228 message contract. TurnStart/TurnEnd are
/// structural markers and are skipped. Tool events become role "tool" with a
/// decision summary as content: ToolCall = `name(args)` (the agent's
/// decision), ToolResult = the JSON value or `Error: {error}` (the outcome).
/// The engine never persists thinking deltas (SessionEvent has no Thinking
/// variant), so "thinking" cannot appear here — assistant text carries the
/// reply.
pub(crate) fn session_event_to_message(ev: &SessionEvent) -> Option<Value> {
    match ev {
        SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => None,
        SessionEvent::UserMessage { text } => {
            Some(json!({"role": "user", "content": text}))
        }
        SessionEvent::AssistantMessage { text } => {
            Some(json!({"role": "assistant", "content": text}))
        }
        SessionEvent::ThinkingDelta { text } => {
            Some(json!({"role": "thinking", "content": text}))
        }
        SessionEvent::ToolCall { id, name, args, parent_id } => {
            // Structured fields for the frontend (no regex parsing needed);
            // content stays as the flattened display string for back-compat.
            let mut v = json!({
                "role": "tool",
                "kind": "call",
                "tool_call_id": id,
                "tool_name": name,
                "tool_args": args,
            });
            if let Some(p) = parent_id {
                v["tool_parent_id"] = json!(p);
            }
            Some(v)
        }
        SessionEvent::ToolResult { id, value, error, parent_id } => {
            let mut v = json!({
                "role": "tool",
                "kind": "result",
                "tool_call_id": id,
                "tool_value": value,
                "tool_error": error,
            });
            if let Some(p) = parent_id {
                v["tool_parent_id"] = json!(p);
            }
            Some(v)
        }
    }
}

/// Parse a persistent session JSONL file (engine v1 format: one
/// serde_json-tagged SessionEvent per line). Blank lines are tolerated;
/// parsing stops at the first unparsable record, mirroring the engine's
/// replay semantics (a torn tail is never surfaced).
pub(crate) fn parse_session_jsonl(text: &str) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionEvent>(line) {
            Ok(ev) => events.push(ev),
            Err(_) => break,
        }
    }
    events
}

/// W228 lenient model-name sanity check: at most 128 chars, only
/// [A-Za-z0-9._-:/@] (no whitespace / brackets / control characters). The
/// engine's validate_model only rejects empty names; this blocks frontend
/// garbage values while staying open for custom OpenAI-compatible endpoints.
pub(crate) fn validate_model_name(m: &str) -> Result<(), String> {
    if m.chars().count() > 128 {
        return Err(format!(
            "invalid model name: '{m}' exceeds 128 characters"
        ));
    }
    if let Some(bad) = m.chars().find(|c| {
        c.is_control()
            || c.is_whitespace()
            || !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '@'))
    }) {
        return Err(format!(
            "invalid model name '{m}': character {bad:?} is not allowed (only [A-Za-z0-9._-:/@]; no spaces, brackets or control characters)"
        ));
    }
    Ok(())
}

// ---- POST /api/config -----------------------------------------------------

/// Partial config update — every field is optional; present fields take
/// effect for the NEXT turn. The engine is re-composed from the merged
/// profile (host conversation preserved through PersistentSessionLog /
/// CELESTEA_SESSION_DIR replay), so changes apply without a restart.
/// W237: CELESTEA_SESSION_DIR already points at the active session directory
/// (restored at boot / switched by /api/sessions/{id}/activate), so the
/// recompose replays THAT session — "config swap preserves the session"
/// stays correct per-session, no extra work.
/// api_key is forwarded via the process env only: it never touches disk,
/// never appears in logs, and is never echoed (the response is the
/// sanitized config — the GET /api/config body).
#[derive(Deserialize)]
pub struct ConfigReq {
    pub model: Option<String>,
    /// Outer Some = field present; inner null / "off" clears the effort,
    /// low/high/max set it (max = engine high; engine-native "medium" is
    /// accepted for back-compat with celestea.toml).
    pub reasoning_effort: Option<Option<String>>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub max_output_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub max_steps: Option<u64>,
    pub system_prompt: Option<String>,
}

/// Public effort tier -> engine-level effort name. max == engine High (the
/// ceiling the engine exposes). "" / "off" clears the effort.
fn parse_effort(s: &str) -> Option<String> {
    // W260: free-form passthrough - user-defined tiers (low/high/max/custom)
    // reach the upstream verbatim; empty/off clears the override.
    let t = s.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("off") {
        None
    } else {
        Some(t.to_string())
    }
}

/// POST /api/config — partial profile update, hot-applied to the next turn:
///   1. refuse while a turn runs (409) — a swap mid-turn could lose events
///      the running runtime appends after the new session log was replayed;
///   2. merge the overrides onto the CURRENT profile (engine lenient merge);
///   3. api_key -> env[api_key_env] in-memory (the engine's only key channel;
///      never persisted, never logged);
///   4. Runtime::compose with the new Profile (same PersistentSessionLog =>
///      session replayed), then swap the generation under the write lock.
/// Response: the sanitized config — same body as GET /api/config.
pub async fn post_config(State(st): State<Shared>, Json(req): Json<ConfigReq>) -> impl IntoResponse {
    let guard = st.busy.lock().await;
    if guard.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": "turn in progress; config applies between turns"})),
        );
    }

    let (mut pj, current_model) = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        (profile_to_json(&gen.profile), gen.profile.model.clone())
    };

    // ---- validate + apply partial overrides --------------------------------
    let target_model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(m) = target_model.as_deref() {
        if let Err(e) = validate_model(m) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": e.to_string()})),
            );
        }
        // W228: lenient studio-side sanity check on top of the engine's
        // empty-only rule — blocks the garbage the UI settings page once
        // saved (e.g. the literal "[object Object]") from entering the
        // profile / config_json.
        if let Err(e) = validate_model_name(m) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": e})),
            );
        }
        pj["model"] = json!(m);
    }

    let effort: Option<Option<String>> = req.reasoning_effort.as_ref().map(|v| match v {
        None => None, // JSON null -> clear
        Some(s) => parse_effort(s),
    });
    if let Some(Some(eng)) = effort {
        // efforts are meaningful only on reasoning models: reject the pairing
        // for a KNOWN non-reasoning model (unknown ids on custom endpoints
        // are accepted and treated as reasoning-capable).
        let target = target_model.as_deref().unwrap_or(current_model.as_str());
        if model_reasoning(target) == Some(false) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "error": format!("model '{target}' is not a reasoning model; reasoning_effort is unavailable")
                })),
            );
        }
        pj["reasoning_effort"] = json!(eng);
    } else if let Some(None) = effort {
        pj.as_object_mut()
            .expect("profile json is an object")
            .remove("reasoning_effort");
    }

    if let Some(b) = req.base_url.as_deref() {
        let b = b.trim();
        if b.is_empty() {
            // clear the base_url override -> env / provider default chain
            pj.as_object_mut()
                .expect("profile json is an object")
                .remove("base_url");
        } else if b.starts_with("http://") || b.starts_with("https://") {
            pj["base_url"] = json!(b);
        } else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "base_url must be an http:// or https:// URL"})),
            );
        }
    }
    if let Some(n) = req.max_output_tokens {
        if n == 0 {
            // 0 clears the cap (no max_output_tokens sent upstream)
            pj.as_object_mut()
                .expect("profile json is an object")
                .remove("max_output_tokens");
        } else if n <= u32::MAX as u64 {
            pj["max_output_tokens"] = json!(n);
        } else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "max_output_tokens must be <= u32::MAX"})),
            );
        }
    }
    if let Some(n) = req.context_window {
        // 0 keeps the engine's ""disable trimming"" semantic (statusline then
        // falls back to the contract display window).
        pj["context_window_tokens"] = json!(n);
    }
    if let Some(n) = req.max_steps {
        if n == 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ok": false, "error": "max_steps must be >= 1"})),
            );
        }
        // W218 floor still applies: the cap may only be raised, never lowered
        // below MIN_STEPS.
        pj["max_steps"] = json!(n.max(MIN_STEPS as u64));
    }
    if let Some(s) = req.system_prompt.as_deref() {
        let s = s.trim();
        if s.is_empty() {
            // clear -> registry-managed assembly again (base sections when
            // there are no overrides)
            pj["system_prompt"] = json!(DEFAULT_SYSTEM_PROMPT());
            crate::prompts::set_user_override(None);
        } else {
            // direct override -> bypass the section registry (in-memory slot;
            // the assembled/registry value is restored by clearing)
            pj["system_prompt"] = json!(s);
            crate::prompts::set_user_override(Some(s.to_string()));
        }
    }

    // ---- apply --------------------------------------------------------------
    // W236: shared merge + env-key-injection + compose + swap tail
    // (main.rs::build_and_swap), also used by the providers default-model
    // hot-apply and W237's session activation. The api key stays in the
    // process env only — never on disk, never in a log line, never echoed
    // (the response is the sanitized config).
    let response = match build_and_swap(&st, pj, req.api_key.as_deref()) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"ok": false, "error": e})),
            )
        }
    };
    drop(guard);
    (StatusCode::OK, Json(response))
}

// ---- worker endpoints ------------------------------------------------------

#[derive(Deserialize)]
pub struct SpawnReq {
    pub wid: String,
    pub brief: String,
    pub title: Option<String>,
    pub model: Option<String>,
    /// W240: engine report_to passthrough — the target session for the
    /// worker's completion receipt ("cli-main" = this host session; the
    /// receipt then wakes the auto-wake loop into an automatic turn).
    pub report_to: Option<String>,
}

#[derive(Deserialize)]
pub struct SendReq {
    pub target: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct StatusQuery {
    pub wid: Option<String>,
}

/// Dispatch one engine worker tool and map the ToolOutput to an HTTP response.
/// The worker tools are contract tools: they return Ok(value) even for
/// contract failures ({ok:false, step, error}), so those ride a 200 with the
/// engine shape; only a hard tool failure maps to a 5xx.
async fn dispatch_worker_tool(
    st: &Shared,
    name: &str,
    args: Value,
) -> (StatusCode, Json<Value>) {
    let registry = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.runtime.registry.clone()
    };
    let out = registry
        .dispatch(ToolInput {
            call_id: format!("w216-{name}"),
            name: name.into(),
            args,
        })
        .await;
    match (out.value, out.error) {
        (Some(v), None) => (StatusCode::OK, Json(v)),
        (None, Some(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"ok": false, "error": e})),
        ),
        (Some(v), Some(e)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"ok": false, "value": v, "error": e})),
        ),
        (None, None) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": "tool returned no value"})),
        ),
    }
}

/// POST /api/worker/spawn {wid,brief,title?,model?} -> {ok,sessionId,title,wid}
pub async fn post_worker_spawn(
    State(st): State<Shared>,
    Json(req): Json<SpawnReq>,
) -> impl IntoResponse {
    let mut args = json!({"wid": req.wid, "brief": req.brief});
    if let Some(t) = req.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args["title"] = Value::String(t.to_string());
    }
    if let Some(m) = req.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args["model"] = Value::String(m.to_string());
    }
    if let Some(r) = req.report_to.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args["report_to"] = Value::String(r.to_string());
    }
    dispatch_worker_tool(&st, "spawn_worker", args).await
}

/// POST /api/worker/send {target,content} -> {ok,delivered,...}
pub async fn post_worker_send(
    State(st): State<Shared>,
    Json(req): Json<SendReq>,
) -> impl IntoResponse {
    dispatch_worker_tool(
        &st,
        "session_send_message",
        json!({"target": req.target, "content": req.content}),
    )
    .await
}

/// GET /api/worker/status?wid= -> {ok,total,by_status,workers:[...]}
///
/// Without wid the engine aggregate is returned verbatim. With wid the same
/// aggregate shape is kept (protocol) and the list is filtered to that worker;
/// a miss is {ok:false,total:0,workers:[]} with an error string, still 200.
pub async fn get_worker_status(
    State(st): State<Shared>,
    Query(q): Query<StatusQuery>,
) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    let mut summary = gen.runtime.workers.summarize(None);
    if let Some(wid) = q.wid.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let (total, running, done, failed) = {
            let workers = summary["workers"]
                .as_array_mut()
                .expect("summarize always yields a workers array");
            workers.retain(|w| w.get("wid").and_then(|v| v.as_str()) == Some(wid));
            let total = workers.len();
            let running = workers.iter().filter(|w| w["status"] == "RUNNING").count();
            let done = workers.iter().filter(|w| w["status"] == "DONE").count();
            let failed = workers.iter().filter(|w| w["status"] == "FAILED").count();
            (total, running, done, failed)
        };
        summary["total"] = json!(total);
        summary["by_status"] = json!({
            "RUNNING": running,
            "DONE": done,
            "FAILED": failed,
        });
        summary["ok"] = json!(total > 0);
        summary["wid"] = json!(wid);
        if total == 0 {
            summary["error"] = json!(format!("no worker {wid} in registry"));
        }
    }
    Json(summary)
}

#[cfg(test)]
mod w228_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_model_name_accepts_catalog_and_custom_names() {
        for ok in [
            "deepseek-v4-flash-vision-exp",
            "deepseek-v4-pro-0813",
            "glm-5.3",
            "muse-spark-1.2-contributor",
            "openai/gpt-5.6-sol",
            "custom:model@tag",
            "a.b-c_d/e@f",
        ] {
            assert!(validate_model_name(ok).is_ok(), "{ok} should pass");
        }
    }

    #[test]
    fn validate_model_name_rejects_garbage() {
        for bad in [
            "[object Object]",
            "deepseek v4 pro",
            "deepseek-v4-pro\t",
            "model\nname",
            "model[0]",
            "模型-中文",
            "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        ] {
            assert!(validate_model_name(bad).is_err(), "{bad:?} should fail");
        }
        // exactly 128 chars is still fine
        let long = "a".repeat(128);
        assert!(validate_model_name(&long).is_ok());
    }

    #[test]
    fn parse_session_jsonl_tolerates_blank_lines_and_torn_tail() {
        let text = format!(
            "{}\n\n{}\n{{bad json\n",
            serde_json::to_string(&SessionEvent::UserMessage { text: "a".into() }).unwrap(),
            serde_json::to_string(&SessionEvent::AssistantMessage { text: "b".into() }).unwrap(),
        );
        let events = parse_session_jsonl(&text);
        assert_eq!(events.len(), 2);
        // The unparsable tail is dropped, not surfaced.
        let text2 = "{\"type\":\"user_message\",\"tex\"";
        assert_eq!(parse_session_jsonl(text2).len(), 0);
    }

    #[test]
    fn session_event_to_message_maps_all_kinds() {
        let evs = vec![
            SessionEvent::TurnStart { id: "t1".into() },
            SessionEvent::UserMessage { text: "hi".into() },
            SessionEvent::AssistantMessage { text: "hello".into() },
            SessionEvent::ToolCall { id: "c1".into(), name: "read_file".into(), args: json!({"path": "/tmp/x"}), parent_id: None },
            SessionEvent::ToolResult { id: "c1".into(), value: Some(json!({"ok": true})), error: None, parent_id: None },
            SessionEvent::ToolResult { id: "c2".into(), value: None, error: Some("boom".into()), parent_id: None },
            SessionEvent::TurnEnd { id: "t1".into(), outcome: celestea_core::TurnOutcome::Completed },
        ];
        let msgs: Vec<Value> = evs.iter().filter_map(session_event_to_message).collect();
        assert_eq!(msgs.len(), 5);
        assert_eq!(msgs[0], json!({"role": "user", "content": "hi"}));
        assert_eq!(msgs[1], json!({"role": "assistant", "content": "hello"}));
        assert_eq!(
            msgs[2],
            json!({
                "role": "tool",
                "kind": "call",
                "tool_call_id": "c1",
                "tool_name": "read_file",
                "tool_args": {"path": "/tmp/x"},
            })
        );
        assert_eq!(
            msgs[3],
            json!({"role": "tool", "kind": "result", "tool_call_id": "c1", "tool_value": {"ok": true}, "tool_error": null})
        );
        assert_eq!(
            msgs[4],
            json!({"role": "tool", "kind": "result", "tool_call_id": "c2", "tool_value": null, "tool_error": "boom"})
        );
        // Thinking deltas map to role=thinking.
        let th = session_event_to_message(&SessionEvent::ThinkingDelta { text: "think".into() }).unwrap();
        assert_eq!(th, json!({"role": "thinking", "content": "think"}));
    }
}
