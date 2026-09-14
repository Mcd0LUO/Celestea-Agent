//! celestea-studio — local web UI over the celestea-runtime engine (W215).
//!
//! One Rust binary: axum HTTP server on 127.0.0.1:3777 that serves the
//! TypeScript+Vite frontend build (frontend/dist/) and exposes turn endpoints.
//! POST /api/turn drives one Runtime::run_turn with a per-turn EventSink;
//! every LoopEvent is mapped to an SSE event on GET /api/events.
//!
//! W218: static root moved from the embedded legacy frontend/*.js to
//! frontend/dist/ (Vite output; a "build the frontend first" hint page is
//! served when dist/ is absent). The engine's 16-step default cap is raised
//! to 4096 at compose time (the agent loop runs steps in `0..max_steps`, so a
//! "no limit" is only expressible as a high cap). A live statusline
//! ({model, reasoning_effort, steps, tokens_per_sec, context_usage, usage})
//! is computed by the backend and delivered both via SSE status events
//! (start / progress / completed / cancelled / error / lagged carry it) and
//! through GET /api/status as the fallback channel.
//!
//! W237: no global main session — sessions are per-workspace DIRECTORIES
//! (cli-main.jsonl inside; the engine's PersistentSessionLog replay unit),
//! listed/created/switched through workspaces.rs + a workspaces.json
//! registry. The persisted active session is restored before the first
//! compose: CELESTEA_SESSION_DIR names the active session directory and the
//! engine replays it — zero engine changes.
//!
//! SSE event names (mirroring the engine LoopEvent variants):
//!   - text        {"delta": String}
//!   - thinking    {"delta": String}
//!   - tool        {"id", "name", "args"}
//!   - tool_result {"id", "ok", "value", "render", "error", "decision"}
//!   - done        {"text", "tool_calls": [...]}
//!   - status      {"phase": "start|progress|completed|cancelled|error|lagged",
//!                  "statusline": {...}, ...}
//! Every SSE event carries {"turn": N, "seq": M, "payload": {...}}.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock};
use std::time::{Duration, Instant};

use axum::extract::{OriginalUri, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, Mutex};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use celestea_core::{Content, ToolDecision};
use celestea_agent_loop::UsageTracker;
use celestea_runtime::{
    load_dotenv, merge_profile, resolve_base_url, resolve_profile, EventSink, LoopEvent,
    Profile, Runtime, SessionEvent, SessionLog, TurnOutcome, Usage, WorkerRegistryService,
};
mod api;
/// W236: model-provider management (providers.json + probe + default-model
/// hot-apply).
mod providers;
/// W237: workspace registry (workspaces.json) + per-session directories
/// over CELESTEA_SESSION_DIR.
mod workspaces;
/// W259: /compact —— 上下文压缩（摘要轮 + 最近 K 轮重写 cli-main.jsonl + 引擎重绑）。
mod compact;
/// W245: section-level prompt registry + compose-time assembly (plan B).
mod prompts;
/// W245: base default prompt = the builtin sections rendered in order
/// (re-exported under the legacy constant name; call it like a fn).
pub(crate) use crate::prompts::default_system_prompt as DEFAULT_SYSTEM_PROMPT;

/// Default bind address (loopback only; access via ssh -L tunnel).
const DEFAULT_BIND: &str = "127.0.0.1:3777";
/// Engine default config names, resolved from the process cwd.
const PRIMARY_CONFIG: &str = "celestea.toml";
const LEGACY_CONFIG: &str = "profile.json";

/// W218: static root — the TypeScript+Vite build output (frontend/dist).
const STATIC_ROOT: &str = "frontend/dist";
/// W218: step-cap floor applied at compose time. The engine agent loop drives
/// `for _step in 0..max_steps`, so max_steps=0 means *zero* steps (not
/// unlimited); removing the limit is therefore a high cap. 4096 covers
/// realistic long turns while still bounding runaway loops.
const MIN_STEPS: usize = 4096;
/// W218: context-window size used for the estimated usage ratio (contract).
const CONTEXT_WINDOW: u64 = 1_000_000;
/// W218: cadence of the SSE status "progress" events during a turn.
const STATUS_TICK: Duration = Duration::from_secs(2);
/// W218: sliding-window length for tokens_per_sec.
const RATE_WINDOW: Duration = Duration::from_secs(5);

// ---- W225: deployment model / effort catalog -------------------------------

/// W225: one entry of the deployment model catalog — the models the studio
/// offers (snapshot of the local provider's "celestea" group; mirrors the
/// DSH session.models listing). The 'reasoning' flag marks models that
/// accept a reasoning effort; efforts are meaningful only for those. The
/// catalog is static on purpose: deterministic, no upstream dependency at
/// startup; extend AVAILABLE_MODELS to add a model.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ModelMeta {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) reasoning: bool,
}

pub(crate) const AVAILABLE_MODELS: &[ModelMeta] = &[
    ModelMeta { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true },
    ModelMeta { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", reasoning: true },
    ModelMeta { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true },
    ModelMeta { id: "mimo-v2.5", name: "Mimo V2.5", reasoning: false },
    ModelMeta { id: "muse-spark-1.2-contributor", name: "Muse Spark", reasoning: false },
    ModelMeta { id: "glm-5.3", name: "GLM 5.3", reasoning: false },
    ModelMeta { id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false },
];

/// W225: effort tiers the studio exposes. Engine mapping: low -> Low,
/// high -> High, max -> High (the engine's ceiling; POST also accepts the
/// engine-native "medium" and "off"/null for back-compat with celestea.toml).
pub(crate) const AVAILABLE_EFFORTS: &[&str] = &["low", "high", "max"];

/// W237: serializes tests that mutate process-global env vars before an
/// engine compose (CELESTEA_SESSION_DIR / API-key env channels) — cargo
/// test threads share one process env.
#[cfg(test)]
pub(crate) static COMPOSE_ENV_LOCK: StdMutex<()> = StdMutex::new(());


/// W225: reasoning-capability lookup (None = unknown id on a custom endpoint;
/// POST validation treats unknown ids as reasoning-capable).
pub(crate) fn model_reasoning(id: &str) -> Option<bool> {
    AVAILABLE_MODELS.iter().find(|m| m.id == id).map(|m| m.reasoning)
}

/// W262: reasoning capability of one provider-store model: an explicit
/// non-empty `reasoning_efforts` list wins; otherwise the static catalog; an
/// unknown id is reasoning-capable (the same rule POST /api/config uses).
fn model_reasoning_of(m: &crate::providers::ProviderModel) -> bool {
    if !m.reasoning_efforts.is_empty() {
        return true;
    }
    model_reasoning(&m.id).unwrap_or(true)
}

/// W262: the 'available' block of the config contract — models + effort tiers.
///
/// Models are built from the LIVE providers store (one entry per stored model,
/// carrying its provider's display name) and the static AVAILABLE_MODELS
/// catalog is appended as a fallback for ids no provider lists (those entries
/// carry `provider: ""`). Ids are deduplicated — the provider-store record
/// wins and the catalog never repeats one. Entries expose id / name /
/// provider / reasoning ONLY: a provider's api_key can never ride along.
pub(crate) fn available_json(store: &crate::providers::ProvidersStore) -> Value {
    let snap = store.snapshot();
    let mut seen: Vec<String> = Vec::new();
    let mut models: Vec<Value> = Vec::new();
    for p in &snap.providers {
        let provider = if p.name.trim().is_empty() { p.id.as_str() } else { p.name.trim() };
        for m in &p.models {
            if seen.iter().any(|s| s == &m.id) {
                continue;
            }
            seen.push(m.id.clone());
            let name = if m.name.trim().is_empty() { m.id.as_str() } else { m.name.trim() };
            models.push(json!({
                "id": m.id,
                "name": name,
                "provider": provider,
                "reasoning": model_reasoning_of(m),
            }));
        }
    }
    for m in AVAILABLE_MODELS {
        if seen.iter().any(|s| s == m.id) {
            continue;
        }
        seen.push(m.id.to_string());
        models.push(json!({
            "id": m.id,
            "name": m.name,
            "provider": "",
            "reasoning": m.reasoning,
        }));
    }
    json!({"models": models, "efforts": AVAILABLE_EFFORTS})
}

/// W225/W262: sanitized config JSON — the shared body of GET /api/config and
/// the POST /api/config response. Never carries an api key (only the KEY's
/// env-var NAME is exposed) and never persists one; `available.models` is
/// built from the provider store handed in.
pub(crate) fn sanitized_config(
    profile: &Profile,
    base_url: &str,
    store: &crate::providers::ProvidersStore,
) -> Value {
    json!({
        "model": profile.model.clone(),
        "base_url": base_url,
        "max_steps": profile.max_steps,
        "max_parallel_tool_calls": profile.max_parallel_tool_calls,
        "reasoning_effort": serde_json::to_value(profile.reasoning_effort.clone()).unwrap_or(Value::Null),
        "max_output_tokens": profile.max_output_tokens,
        "context_window": profile.context_window_tokens,
        "system_prompt": profile.system_prompt.clone(),
        "api_key_env": profile.api_key_env.clone(),
        "available": available_json(store),
    })
}

/// W225: the current Profile as full profile JSON (every documented key;
/// optional None fields omitted), so POST /api/config can merge partial
/// overrides through the engine's own lenient merge before re-composing.
pub(crate) fn profile_to_json(profile: &Profile) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("model".to_string(), Value::String(profile.model.clone()));
    m.insert("system_prompt".to_string(), Value::String(profile.system_prompt.clone()));
    m.insert("max_steps".to_string(), json!(profile.max_steps));
    m.insert("max_parallel_tool_calls".to_string(), json!(profile.max_parallel_tool_calls));
    m.insert("context_window_tokens".to_string(), json!(profile.context_window_tokens));
    m.insert("context_trim_threshold".to_string(), json!(profile.context_trim_threshold));
    m.insert("context_keep_recent".to_string(), json!(profile.context_keep_recent));
    if let Some(b) = &profile.base_url {
        m.insert("base_url".to_string(), Value::String(b.clone()));
    }
    if let Some(e) = &profile.reasoning_effort {
        // W260: free-form passthrough - any user-defined tier label verbatim.
        m.insert("reasoning_effort".to_string(), serde_json::to_value(e).unwrap_or(Value::Null));
    }
    if let Some(t) = profile.max_output_tokens {
        m.insert("max_output_tokens".to_string(), json!(t));
    }
    m.insert("api_key_env".to_string(), Value::String(profile.api_key_env.clone()));
    if let Some(f) = &profile.api_key_file {
        m.insert("api_key_file".to_string(), Value::String(f.clone()));
    }
    Value::Object(m)
}

/// One turn-level event on the broadcast bus; kind is the SSE event name.
#[derive(Clone, Debug)]
pub(crate) struct BusEvent {
    pub(crate) kind: &'static str,
    pub(crate) data: Value,
}

/// W218 statusline tracker: event-counted steps (W263: one per tool call)
/// plus a sliding-window char-rate over text/thinking deltas (the
/// tokens_per_sec estimate).
pub(crate) struct StatusTracker {
    steps: AtomicU64,
    rate: StdMutex<RateWindow>,
}

impl StatusTracker {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            steps: AtomicU64::new(0),
            rate: StdMutex::new(RateWindow::default()),
        })
    }

    /// New-turn baseline: clear steps + rate window.
    pub(crate) fn reset(&self) {
        self.steps.store(0, Ordering::Relaxed);
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// Record one output delta (text/thinking) into the rate window.
    pub(crate) fn add_chars(&self, chars: u64) {
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(chars, Instant::now());
    }

    /// Record one step (one tool call; W263: tool_result no longer doubles it).
    pub(crate) fn add_step(&self) {
        self.steps.fetch_add(1, Ordering::Relaxed);
    }

    /// Current chars-per-second estimate over the sliding window.
    pub(crate) fn rate(&self) -> f64 {
        self.rate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .rate(Instant::now())
    }
}

/// Sliding window of delta samples: `(timestamp, chars)` per sample; samples
/// older than [RATE_WINDOW] are dropped on push/rate.
#[derive(Default)]
struct RateWindow {
    samples: VecDeque<(Instant, u64)>,
}

impl RateWindow {
    fn clear(&mut self) {
        self.samples.clear();
    }

    fn push(&mut self, chars: u64, now: Instant) {
        self.samples.push_back((now, chars));
        self.trim(now);
    }

    fn trim(&mut self, now: Instant) {
        while let Some((front, _)) = self.samples.front() {
            if now.duration_since(*front) > RATE_WINDOW {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// chars in the window / elapsed span (min 1s so a burst of a few deltas
    /// never reports a silly multi-thousand rate).
    fn rate(&mut self, now: Instant) -> f64 {
        self.trim(now);
        let Some((front, _)) = self.samples.front() else {
            return 0.0;
        };
        let secs = now.duration_since(*front).as_secs_f64().max(1.0);
        let chars: u64 = self.samples.iter().map(|(_, c)| c).sum();
        chars as f64 / secs
    }
}

/// Lightweight W218 statusline view: everything a statusline needs, so the
/// turn task can emit snapshots without a request path.
pub(crate) struct StatusView {
    pub(crate) model: String,
    pub(crate) reasoning_effort: Value,
    pub(crate) status: Arc<StatusTracker>,
    pub(crate) session: Arc<dyn SessionLog>,
    /// W225: live profile context window (0 = trimming off -> display default).
    pub(crate) context_window: u64,
    /// W263: engine usage tracker (Runtime.usage) — provider-reported token
    /// usage per LLM stream (latest + cumulative). The statusline reads it for
    /// the cache-hit-ratio surface and for the real context-usage ratio.
    pub(crate) usage: Arc<UsageTracker>,
}

/// W225: one engine generation — the hot-swappable unit behind /api/config.
/// Every field derives from the same Profile, so readers never observe a
/// mixed state (model from one compose, session from another).
pub(crate) struct Gen {
    pub(crate) runtime: Arc<Runtime>,
    pub(crate) profile: Profile,
    pub(crate) model: String,
    pub(crate) base_url: String,
    /// profile reasoning_effort serialized (null | "low" | "medium" | "high").
    pub(crate) reasoning_effort: Value,
    /// Sanitized config JSON (GET/POST /api/config response body).
    pub(crate) config_json: Value,
}

/// W225: compose one engine generation from a profile. With
/// CELESTEA_SESSION_DIR set the engine replays <dir>/cli-main.jsonl into the
/// new Runtime, so the host conversation survives the swap.
pub(crate) fn build_gen(
    profile: Profile,
    store: &crate::providers::ProvidersStore,
) -> Result<Gen, String> {
    // W245: compose-time prompt assembly (plan B, generation-level). A
    // user-set system_prompt from POST /api/config is an in-memory bypass of
    // the registry; otherwise the prompt is assembled from the section chain
    // (builtin <- global <- workspace <- session binding) and written into
    // profile.system_prompt BEFORE compose, so every generation swap
    // (hot model switch / session activation) re-assembles.
    let mut profile = profile;
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );
    profile.system_prompt = match crate::prompts::user_override() {
        // config panel direct override -> registry bypass (in-memory slot)
        Some(ov) => ov,
        // registry-managed: assemble EVERY generation swap — the assembled
        // value is never mistaken for a user override (only the slot is).
        None => match crate::prompts::assemble_system_prompt(&profile, &base_url) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[celestea-studio] prompt assembly failed, base fallback: {e}");
                crate::prompts::default_system_prompt().to_string()
            }
        },
    };
    let runtime = Runtime::compose(&profile).map_err(|e| format!("{e:#}"))?;
    Ok(Gen {
        runtime: Arc::new(runtime),
        model: profile.model.clone(),
        base_url: base_url.clone(),
        reasoning_effort: serde_json::to_value(profile.reasoning_effort.clone()).unwrap_or(Value::Null),
        config_json: sanitized_config(&profile, &base_url, store),
        profile,
    })
}

/// W236 shared recompose tail for hot swaps (post_config / providers default):
/// merge a profile JSON, inject an api key through the process env (the
/// engine's only key channel — in-memory only, never logged), then compose a
/// fresh generation. Env injection happens before compose so the new adapter
/// reads the new key.
pub(crate) fn prepare_gen(
    pj: Value,
    api_key: Option<&str>,
    store: &crate::providers::ProvidersStore,
) -> Result<Gen, String> {
    let new_profile = merge_profile(&pj).map_err(|e| e.to_string())?;
    if let Some(k) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        std::env::set_var(new_profile.api_key_env.as_str(), k);
    }
    build_gen(new_profile, store).map_err(|e| format!("compose failed: {e}"))
}

/// W236: swap a prepared generation under the gen write lock; returns the
/// new sanitized config JSON.
/// W240: bumps the generation epoch — the autowake loop watches it to drop its
/// old-mailbox recv subscription and rebind onto the new generation's mailbox.
pub(crate) fn swap_gen(st: &Shared, gen: Gen) -> Value {
    let response = gen.config_json.clone();
    // Replace under the write lock, then — BEFORE the old generation drops
    // (Runtime::shutdown purges its mailbox) — migrate any pending host
    // receipts (worker -> cli-main) from the old generation's mailbox onto
    // the new one, so receipts survive hot swaps (model/session/prompt
    // changes). Workers still running in the old runtime are shut down with
    // it; their already-sent receipts must not be lost with them.
    let old = {
        let mut guard = st.gen.write().unwrap_or_else(|p| p.into_inner());
        std::mem::replace(&mut *guard, gen)
    };
    let migrated = if let Some(wr) = old.runtime.ctx.get::<WorkerRegistryService>() {
        let msgs = wr.mailbox().poll("cli-main");
        let n = msgs.len();
        if n > 0 {
            let new_gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            if let Some(nwr) = new_gen.runtime.ctx.get::<WorkerRegistryService>() {
                for m in msgs {
                    nwr.mailbox().send("cli-main", m.content, m.from_label);
                }
            }
        }
        n
    } else {
        0
    };
    if migrated > 0 {
        eprintln!("[celestea-studio] swap_gen: migrated {migrated} pending host receipt(s) to the new generation");
    }
    let _ = st.gen_epoch.send_modify(|e| *e += 1);
    drop(old);
    response
}

/// W236: prepare + swap in one step (the post_config tail).
pub(crate) fn build_and_swap(
    st: &Shared,
    pj: Value,
    api_key: Option<&str>,
) -> Result<Value, String> {
    let gen = prepare_gen(pj, api_key, &st.providers)?;
    Ok(swap_gen(st, gen))
}

pub(crate) struct AppState {
    /// W225: current engine generation (hot-swapped by POST /api/config).
    pub(crate) gen: RwLock<Gen>,
    pub(crate) bcast: broadcast::Sender<BusEvent>,
    /// Active turn's cancel sender (single concurrent turn for the MVP).
    pub(crate) busy: Arc<Mutex<Option<watch::Sender<bool>>>>,
    pub(crate) next_turn: Arc<AtomicU64>,
    pub(crate) seq: Arc<AtomicU64>,
    /// W218: shared statusline tracker (steps / token rate), fed by the turn
    /// sink and read by SSE status payloads + GET /api/status.
    pub(crate) status: Arc<StatusTracker>,
    /// W236: model providers store (providers.json; api keys live here and
    /// are never serialized into any response or log line).
    pub(crate) providers: Arc<crate::providers::ProvidersStore>,
    /// W237: workspace registry (workspaces.json; the active session id is
    /// persisted here and drives CELESTEA_SESSION_DIR at boot/activation).
    pub(crate) workspaces: Arc<crate::workspaces::WorkspaceRegistry>,
    /// W240: generation epoch (bumped by swap_gen); the autowake loop uses it
    /// to detect a hot swap while parked on the old generation's mailbox and
    /// rebind onto the new one.
    pub(crate) gen_epoch: watch::Sender<u64>,
}

impl AppState {
    /// W218: snapshot view for statusline computation (turn task / API).
    pub(crate) fn status_view(&self) -> StatusView {
        let gen = self.gen.read().unwrap_or_else(|p| p.into_inner());
        StatusView {
            model: gen.model.clone(),
            reasoning_effort: gen.reasoning_effort.clone(),
            status: self.status.clone(),
            session: gen.runtime.session.clone(),
            context_window: gen.profile.context_window_tokens,
            usage: gen.runtime.usage.clone(),
        }
    }

    /// W218: current statusline JSON (SSE status payloads + GET /api/status).
    pub(crate) fn statusline(&self) -> Value {
        statusline_of(&self.status_view())
    }
}

pub(crate) type Shared = Arc<AppState>;

/// W218/W263: build the statusline JSON: {model, reasoning_effort, steps,
/// tokens_per_sec, context_usage, usage}. `steps` is counted from tool-call
/// events (W263: one per call); `tokens_per_sec` from text/thinking delta rate.
///
/// W263 `context_usage`: the engine's agent loop records every provider
/// usage frame into Runtime.usage, so the ratio is the REAL prompt size of the
/// most recent request (`prompt_tokens / window`, estimated:false,
/// method:"usage_prompt_tokens"). Only when no usage frame has been observed
/// yet does it fall back to the session-log character estimate
/// (estimated:true, method:"session_event_chars") — the contract field names
/// are unchanged either way.
///
/// W263 `usage`: {prompt_tokens, completion_tokens, total_tokens, cache_read,
/// cache_hit_ratio, reasoning_tokens} for the LATEST LLM stream plus the same
/// shape under `total` for the cumulative tracker values (hover/tooltip).
/// `cache_hit_ratio` = cache_read / prompt_tokens, clamped to [0,1] and
/// rounded to 4 decimals; 0 when prompt_tokens == 0.
pub(crate) fn statusline_of(view: &StatusView) -> Value {
    let latest = view.usage.latest();
    let total = view.usage.total();
    // W225: live profile window (0 = trimming off -> contract display default).
    let window = if view.context_window > 0 {
        view.context_window
    } else {
        CONTEXT_WINDOW
    };
    let context_usage = if latest.prompt_tokens > 0 {
        json!({
            "used": latest.prompt_tokens,
            "window": window,
            "ratio": ratio4(latest.prompt_tokens, window),
            "estimated": false,
            "method": "usage_prompt_tokens",
        })
    } else {
        let used = estimated_context_chars(&view.session.events());
        json!({
            "used": used,
            "window": window,
            "ratio": ratio4(used, window),
            "estimated": true,
            "method": "session_event_chars",
        })
    };
    json!({
        "model": view.model,
        "reasoning_effort": view.reasoning_effort,
        "steps": view.status.steps.load(Ordering::Relaxed),
        "tokens_per_sec": (view.status.rate() * 100.0).round() / 100.0,
        "context_usage": context_usage,
        "usage": usage_json(&latest, &total),
    })
}

/// W263: `cache_read / prompt_tokens`, clamped to [0,1], 4 decimals, 0 when
/// the denominator is 0 (no usage recorded yet).
fn cache_hit_ratio(u: &Usage) -> f64 {
    if u.prompt_tokens == 0 {
        return 0.0;
    }
    let r = u.cache_read as f64 / u.prompt_tokens as f64;
    (r.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0
}

/// W263: used/window ratio, clamped to [0,1], rounded to 4 decimals.
fn ratio4(used: u64, window: u64) -> f64 {
    if window == 0 {
        return 0.0;
    }
    let r = used as f64 / window as f64;
    (r.clamp(0.0, 1.0) * 10_000.0).round() / 10_000.0
}

/// W263: one usage block (latest) + the cumulative block (`total`).
fn usage_json(latest: &Usage, total: &Usage) -> Value {
    json!({
        "prompt_tokens": latest.prompt_tokens,
        "completion_tokens": latest.completion_tokens,
        "total_tokens": latest.total_tokens,
        "cache_read": latest.cache_read,
        "cache_hit_ratio": cache_hit_ratio(latest),
        "reasoning_tokens": latest.reasoning_tokens,
        "total": {
            "prompt_tokens": total.prompt_tokens,
            "completion_tokens": total.completion_tokens,
            "total_tokens": total.total_tokens,
            "cache_read": total.cache_read,
            "cache_hit_ratio": cache_hit_ratio(total),
            "reasoning_tokens": total.reasoning_tokens,
        },
    })
}

/// W218 context-usage estimate: total character volume of the session log
/// (user/assistant text + tool call args + tool results/errors).
fn estimated_context_chars(events: &[SessionEvent]) -> u64 {
    let mut total = 0u64;
    for ev in events {
        match ev {
            SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } | SessionEvent::ThinkingDelta { .. } => {}
            SessionEvent::UserMessage { text } => total += text.chars().count() as u64,
            SessionEvent::AssistantMessage { text } => total += text.chars().count() as u64,
            SessionEvent::ToolCall { id, name, args, .. } => {
                total += id.chars().count() as u64;
                total += name.chars().count() as u64;
                total += args.to_string().chars().count() as u64;
            }
            SessionEvent::ToolResult { id, value, error, .. } => {
                total += id.chars().count() as u64;
                if let Some(v) = value {
                    total += v.to_string().chars().count() as u64;
                }
                if let Some(e) = error {
                    total += e.chars().count() as u64;
                }
            }
        }
    }
    total
}

#[derive(Deserialize)]
struct TurnReq {
    input: String,
}
pub(crate) fn emit(
    bcast: &broadcast::Sender<BusEvent>,
    seq: &AtomicU64,
    turn: u64,
    kind: &'static str,
    payload: Value,
) {
    let _ = bcast.send(BusEvent {
        kind,
        data: json!({
            "turn": turn,
            "seq": seq.fetch_add(1, Ordering::Relaxed),
            "payload": payload,
        }),
    });
}

fn to_sse(ev: &BusEvent) -> Event {
    Event::default().event(ev.kind).data(ev.data.to_string())
}

/// Map one engine LoopEvent to (SSE event name, payload).
fn loop_event_to_json(ev: LoopEvent) -> (&'static str, Value) {
    match ev {
        LoopEvent::Text(t) => ("text", json!({"delta": t})),
        LoopEvent::Thinking(t) => ("thinking", json!({"delta": t})),
        LoopEvent::ToolCall { id, name, args } => {
            ("tool", json!({"id": id, "name": name, "args": args}))
        }
        LoopEvent::ToolResult(o) => {
            let decision = match &o.decision {
                Some(ToolDecision::Allow) => Some("allow"),
                Some(ToolDecision::Deny(_)) => Some("deny"),
                Some(ToolDecision::Ask(_)) => Some("ask"),
                None => None,
            };
            (
                "tool_result",
                json!({
                    "id": o.call_id,
                    "ok": o.error.is_none(),
                    "value": o.value,
                    "render": o.render,
                    "error": o.error,
                    "decision": decision,
                }),
            )
        }
        LoopEvent::TurnEnd(outcome) => (
            "turn_end",
            json!({"outcome": outcome_phase(&outcome), "error": outcome_error(&outcome)}),
        ),
        LoopEvent::Done(m) => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for c in &m.content {
                match c {
                    Content::Text(t) => text.push_str(t),
                    Content::ToolCall(tc) => tool_calls.push(json!({
                        "id": tc.id,
                        "name": tc.name,
                        "args": tc.args,
                    })),
                }
            }
            ("done", json!({"text": text, "tool_calls": tool_calls}))
        }
    }
}

/// Terminal outcome -> SSE phase string (shared by the TurnEnd envelope and
/// the final status event).
fn outcome_phase(o: &TurnOutcome) -> &'static str {
    match o {
        TurnOutcome::Completed => "completed",
        TurnOutcome::Cancelled => "cancelled",
        TurnOutcome::Error { .. } => "error",
        TurnOutcome::StepLimit => "step_limit",
        TurnOutcome::Interrupted => "interrupted",
    }
}

/// Terminal outcome -> optional error detail for the SSE envelope.
fn outcome_error(o: &TurnOutcome) -> Option<String> {
    match o {
        TurnOutcome::Error { kind, message } => Some(format!("{kind}: {message}")),
        _ => None,
    }
}

// ---- static handlers -------------------------------------------------------

/// W218: serve the frontend build (frontend/dist/) for the UI and every
/// root-level asset the Vite build emits (index.html, assets/*.js|css,
/// favicon, ...); unknown non-API paths fall back to the SPA index
/// (Vite history-mode). When dist/ is absent the index shows the
/// "build the frontend first" hint page instead.
async fn get_static(OriginalUri(uri): OriginalUri) -> Response {
    let path = uri.path();
    // keep 404 semantics for unknown API paths (this handler is the fallback)
    if path.starts_with("/api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "not found"})),
        )
            .into_response();
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let Some(rel) = sanitize_rel(rel) else {
        return not_found_response();
    };
    let base = Path::new(STATIC_ROOT);
    match tokio::fs::read(base.join(&rel)).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, mime_for(&rel)),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        // Missing extensionless path = SPA route: index.html when the build
        // exists, otherwise the build hint.
        Err(_) if rel == "index.html" || !rel.contains('.') => {
            match tokio::fs::read(base.join("index.html")).await {
                Ok(bytes) => (
                    [
                        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    bytes,
                )
                    .into_response(),
                Err(_) => hint_response(),
            }
        }
        Err(_) => not_found_response(),
    }
}

/// Harden a request-relative path: allow normal components only, reject
/// `..` / absolute / prefix components.
fn sanitize_rel(rel: &str) -> Option<String> {
    let mut out = String::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => {
                if !out.is_empty() {
                    out.push('/');
                }
                out.push_str(c.to_str()?);
            }
            Component::CurDir => {}
            Component::ParentDir => return None,
            _ => return None,
        }
    }
    Some(out)
}

fn mime_for(rel: &str) -> &'static str {
    match Path::new(rel).extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// W218: index placeholder when frontend/dist/ is absent (frontend not built).
fn hint_response() -> Response {
    const HINT: &str = concat!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<title>Celestea-Studio</title>",
        "<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e8eaf0;",
        "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}",
        ".box{max-width:34rem;padding:2rem;border:1px solid #2a3040;border-radius:12px;line-height:1.7}",
        "code{background:#1a2030;padding:.15rem .4rem;border-radius:6px}</style></head><body>",
        "<div class=\"box\"><h2>先构建前端</h2>",
        "<p>Celestea-Studio 前端尚未构建：<code>frontend/dist/</code> 不存在（或缺少 <code>index.html</code>）。</p>",
        "<p>在 <code>/src/celestea_studio/frontend</code> 执行 ",
        "<code>npm install &amp;&amp; npm run build</code> 生成 Vite 产物到 ",
        "<code>frontend/dist/</code> 后刷新本页即可；API 端点照常可用。</p>",
        "</div></body></html>"
    );
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        HINT,
    )
        .into_response()
}

fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "not found",
    )
        .into_response()
}

// ---- handlers -------------------------------------------------------------

async fn get_health(State(st): State<Shared>) -> Json<Value> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    Json(json!({
        "ok": true,
        "name": "celestea-studio",
        "model": gen.model,
        "base_url": gen.base_url,
        "bind": DEFAULT_BIND,
    }))
}

async fn get_events(
    State(st): State<Shared>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = st.bcast.subscribe();
    let st_for_lag = st.clone();
    // tokio-stream's filter_map is sync: a lagged client gets a resync
    // status event and the stream keeps flowing (EventSource auto-reconnects
    // anyway if it drops).
    let stream = BroadcastStream::new(rx).filter_map(move |item| {
        let st = st_for_lag.clone();
        match item {
            Ok(ev) => Some(Ok::<_, Infallible>(to_sse(&ev))),
            Err(_) => Some(Ok(Event::default()
                .event("status")
                .data(
                    json!({
                        "phase": "lagged",
                        "hint": "slow client, skipped events",
                        "statusline": st.statusline(),
                    })
                    .to_string(),
                ))),
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// W240: shared turn executor — drives one runtime.run_turn with the standard
/// SSE sink + progress ticker and ALWAYS releases the busy slot afterwards.
/// POST /api/turn spawns it; the autowake loop awaits it inline. Hard errors
/// ride the SSE "error" phase and are returned for the caller to log.
async fn execute_turn(
    st: Shared,
    runtime: Arc<Runtime>,
    turn: u64,
    input: String,
    cancel_rx: watch::Receiver<bool>,
) -> Result<TurnOutcome, String> {
    let bcast = st.bcast.clone();
    let seq = st.seq.clone();
    let tracker = st.status.clone();
    let view = st.status_view();

    // Turn sink: feed the statusline tracker (steps from tool /
    // tool_result, delta chars for tokens_per_sec) and forward every
    // event to the SSE bus.
    let sink: EventSink = {
        let sink_bcast = bcast.clone();
        let sink_seq = seq.clone();
        let tracker = tracker.clone();
        Arc::new(move |ev: LoopEvent| {
            match &ev {
                LoopEvent::Text(t) => tracker.add_chars(t.chars().count() as u64),
                LoopEvent::Thinking(t) => tracker.add_chars(t.chars().count() as u64),
                // W263: one step per tool CALL (its tool_result closes that
                // step) — same口径 as the frontend's per-turn tool counter.
                LoopEvent::ToolCall { .. } => tracker.add_step(),
                LoopEvent::ToolResult(_) | LoopEvent::Done(_) | LoopEvent::TurnEnd(_) => {}
            }
            let (kind, payload) = loop_event_to_json(ev);
            let _ = sink_bcast.send(BusEvent {
                kind,
                data: json!({
                    "turn": turn,
                    "seq": sink_seq.fetch_add(1, Ordering::Relaxed),
                    "payload": payload,
                }),
            });
        })
    };

    // Drive the turn; every STATUS_TICK emit a "progress" status event
    // carrying the live statusline (SSE incremental channel).
    let mut ticker = tokio::time::interval(STATUS_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // consume the immediate first tick
    let run = runtime.run_turn(&input, Some(cancel_rx), Some(sink));
    tokio::pin!(run);
    let outcome = loop {
        tokio::select! {
            out = &mut run => break out,
            _ = ticker.tick() => {
                emit(&bcast, &seq, turn, "status", json!({
                    "phase": "progress",
                    "statusline": statusline_of(&view),
                }));
            }
        }
    };
    let (phase, error) = match &outcome {
        Ok(TurnOutcome::Completed) => ("completed", None),
        Ok(TurnOutcome::Cancelled) => ("cancelled", None),
        Ok(TurnOutcome::Error { kind, message }) => ("error", Some(format!("{kind}: {message}"))),
        Ok(TurnOutcome::StepLimit) => ("step_limit", None),
        Ok(TurnOutcome::Interrupted) => ("interrupted", None),
        Err(e) => ("error", Some(e.to_string())),
    };
    let mut final_payload = json!({
        "phase": phase,
        "statusline": statusline_of(&view),
    });
    if let Some(e) = error {
        final_payload["error"] = json!(e);
    }
    emit(&bcast, &seq, turn, "status", final_payload);

    // W240: the busy-slot release is the LAST step on every path (completed /
    // cancelled / error), so the next user turn or autowake pass can claim it.
    let mut busy_slot = st.busy.lock().await;
    *busy_slot = None;

    outcome.map_err(|e| e.to_string())
}

async fn post_turn(State(st): State<Shared>, Json(req): Json<TurnReq>) -> impl IntoResponse {
    let input = req.input.trim().to_string();
    if input.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "input must not be empty"})),
        );
    }
    let mut busy = st.busy.lock().await;
    if busy.is_some() {
        return (
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": "a turn is already running"})),
        );
    }
    let (cancel_tx, cancel_rx) = watch::channel(false);
    *busy = Some(cancel_tx);
    drop(busy);

    // W218: new-turn statusline baseline (steps=0, empty rate window).
    st.status.reset();
    let turn = st.next_turn.fetch_add(1, Ordering::Relaxed);
    emit(
        &st.bcast,
        &st.seq,
        turn,
        "status",
        json!({"phase": "start", "statusline": st.statusline()}),
    );

    let runtime = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        gen.runtime.clone()
    };
    tokio::spawn(async move {
        if let Err(e) = execute_turn(st, runtime, turn, input, cancel_rx).await {
            eprintln!("[celestea-studio] turn error: {e}");
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({"turn": turn, "status": "started"})),
    )
}
async fn post_cancel(State(st): State<Shared>) -> Json<Value> {
    let busy = st.busy.lock().await;
    match busy.as_ref() {
        Some(tx) => {
            let _ = tx.send(true);
            Json(json!({"ok": true, "cancelled": true}))
        }
        None => Json(json!({"ok": true, "cancelled": false})),
    }
}

// ---- W240: mailbox auto-wake loop ------------------------------------------

/// W240: CELESTEA_AUTOWAKE switch. Default ON; "0"/"off"/"false"/"no" disables
/// the auto-wake loop (smoke comparisons / A-B runs). Any other value keeps
/// the default (on).
pub(crate) fn autowake_enabled() -> bool {
    !matches!(
        std::env::var("CELESTEA_AUTOWAKE").ok().as_deref().map(str::trim),
        Some("0") | Some("off") | Some("false") | Some("no")
    )
}

/// W240: spawn the auto-wake loop as a detached background task (started once
/// at boot from main; lives for the process lifetime, ends on shutdown).
pub(crate) fn spawn_autowake(st: Shared) -> tokio::task::JoinHandle<()> {
    tokio::spawn(autowake_loop(st))
}

/// W240: auto-wake loop — the "delivery wakes the agent" semantics for the
/// active session's mailbox:
///   * every iteration rebinds onto the CURRENT generation's cli-main mailbox
///     (WorkerRegistryService from gen.runtime.ctx) and parks on recv();
///   * a generation swap (swap_gen bumps gen_epoch) wakes the parked recv via
///     the epoch watch, discarding the old-generation subscription; a message
///     popped from a stale mailbox is re-queued onto the new generation's;
///   * while a turn runs (busy guard taken) a popped message is re-queued and
///     retried after a short backoff — no message is lost, and FIFO order is
///     preserved because the drain takes the whole queue at once;
///   * on wake: drain ALL pending messages (FIFO) into one input, claim the
///     busy slot and run ONE automatic turn over the standard SSE bus (the
///     client sees it live, exactly like a POST /api/turn);
///   * turn errors are logged (eprintln) with a small backoff — never panic,
///     never spin hot.
pub(crate) async fn autowake_loop(st: Shared) {
    /// Engine's host session id — mirrors the engine's pub(crate)
    /// compose::HOST_SID: engine-side receipts target "cli-main".
    const HOST_SID: &str = "cli-main";
    /// Busy-conflict retry cadence (message left queued for the next pass).
    const BUSY_RETRY: Duration = Duration::from_millis(250);
    /// Backoff after a hard turn error / missing service.
    const ERR_BACKOFF: Duration = Duration::from_millis(500);

    loop {
        // Generation-aware bind: subscribe to the epoch watch FIRST, then
        // snapshot runtime + mailbox + epoch synchronously (no await in
        // between), so a swap either lands before the snapshot (we read the
        // new generation) or wakes the select below (we rebind).
        let mut gen_watch = st.gen_epoch.subscribe();
        // resolve the worker service first: the read guard must never be
        // alive across an await (RwLockReadGuard is !Send and tokio::spawn
        // requires a Send future)
        let wr = {
            let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            gen.runtime.ctx.get::<WorkerRegistryService>()
        };
        let Some(wr) = wr else {
            eprintln!("[celestea-studio] autowake: WorkerRegistryService missing; retrying");
            tokio::time::sleep(ERR_BACKOFF).await;
            continue;
        };
        let (runtime, mailbox, epoch) = {
            let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            (
                gen.runtime.clone(),
                wr.mailbox().clone(),
                *st.gen_epoch.borrow(),
            )
        };

        // Park on THIS generation's cli-main queue. A generation swap drops
        // this subscription (the epoch watch fires) and the next iteration
        // rebinds onto the new generation's mailbox.
        let msg = tokio::select! {
            m = mailbox.recv(HOST_SID) => m,
            _ = gen_watch.changed() => continue,
        };

        // A swap may have raced the select: the popped message belongs to the
        // OLD generation — hand it to the CURRENT generation's queue, rebind.
        if *st.gen_epoch.borrow() != epoch {
            {
                let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
                if let Some(wr) = gen.runtime.ctx.get::<WorkerRegistryService>() {
                    wr.mailbox().send(HOST_SID, msg.content, msg.from_label);
                }
            }
            continue;
        }

        // Busy conflict: leave the message for the next pass — re-enqueue at
        // the tail (FIFO order is preserved because the drain below takes the
        // whole queue at once) and back off.
        if st.busy.lock().await.is_some() {
            mailbox.send(HOST_SID, msg.content, msg.from_label);
            tokio::time::sleep(BUSY_RETRY).await;
            continue;
        }

        // Claim the single-turn busy slot (same guard as post_turn), then
        // re-verify the generation: post_config / session activate may have
        // swapped it in the window before the claim.
        let (cancel_tx, cancel_rx) = watch::channel(false);
        *st.busy.lock().await = Some(cancel_tx);
        if *st.gen_epoch.borrow() != epoch {
            *st.busy.lock().await = None;
            {
                let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
                if let Some(wr) = gen.runtime.ctx.get::<WorkerRegistryService>() {
                    wr.mailbox().send(HOST_SID, msg.content, msg.from_label);
                }
            }
            continue;
        }

        // Drain everything pending (the recv'd message is already popped) and
        // run ONE automatic turn with the receipts as its input, streamed
        // over the standard SSE bus.
        let mut msgs = vec![msg];
        msgs.extend(mailbox.poll(HOST_SID));
        let input = msgs
            .iter()
            .map(|m| {
                if m.from_label.is_empty() {
                    m.content.clone()
                } else {
                    format!("[from {}] {}", m.from_label, m.content)
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        st.status.reset();
        let turn = st.next_turn.fetch_add(1, Ordering::Relaxed);
        emit(
            &st.bcast,
            &st.seq,
            turn,
            "status",
            json!({"phase": "start", "source": "autowake", "statusline": st.statusline()}),
        );
        match execute_turn(st.clone(), runtime, turn, input, cancel_rx).await {
            Ok(_) => {}
            Err(e) => {
                eprintln!("[celestea-studio] autowake turn error: {e}");
                tokio::time::sleep(ERR_BACKOFF).await;
            }
        }
    }
}

// ---- main -----------------------------------------------------------------

#[tokio::main]
async fn main() {
    load_dotenv();
    // W237: workspace registry. workspaces.json lives next to the binary's
    // cwd (CELESTEA_WORKSPACES_FILE overrides it for smoke instances); when
    // it is missing the legacy flat sessions/ layout is migrated into
    // per-session directories and the default workspace (默认 ->
    // <cwd>/sessions, active "默认/cli-main") is registered.
    let registry_path = std::env::var("CELESTEA_WORKSPACES_FILE")
        .ok()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("workspaces.json"));
    let sessions_root = std::env::current_dir()
        .map(|cwd| cwd.join("sessions"))
        .unwrap_or_else(|_| PathBuf::from("sessions"));
    let registry = Arc::new(match crate::workspaces::load_registry(registry_path, &sessions_root) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[celestea-studio] workspaces registry error: {e}");
            std::process::exit(1);
        }
    });
    // W237: restore the persisted active session BEFORE the first compose —
    // CELESTEA_SESSION_DIR names the session DIRECTORY and the engine
    // replays <dir>/cli-main.jsonl through PersistentSessionLog. A dangling
    // id falls back to the first registered workspace's cli-main session.
    let mut active_id = registry.active_session();
    let mut active_dir = active_id.as_deref().and_then(|id| {
        crate::workspaces::resolve_session_dir(&registry.snapshot(), id)
            .ok()
            .map(|r| r.2)
            .filter(|d| d.parent().is_some_and(|p| p.is_dir()))
    });
    if active_dir.is_none() {
        if let Some(ws) = registry.snapshot().workspaces.first() {
            let dir = Path::new(&ws.path).join("cli-main");
            let base = crate::workspaces::workspace_basename(&ws.path).unwrap_or_default();
            let id = format!("{base}/cli-main");
            eprintln!(
                "[celestea-studio] active session '{:?}' unusable; falling back to workspace '{}' session 'cli-main'",
                active_id, base,
            );
            if registry.set_active(Some(id.clone())).is_ok() {
                active_id = Some(id);
                active_dir = Some(dir);
            }
        }
    }
    match &active_dir {
        Some(dir) => {
            std::env::set_var("CELESTEA_SESSION_DIR", dir);
            eprintln!(
                "[celestea-studio] active session {} -> {}",
                active_id.as_deref().unwrap_or("?"),
                dir.display()
            );
        }
        None => {
            std::env::remove_var("CELESTEA_SESSION_DIR");
            eprintln!("[celestea-studio] no workspace registered; engine session is in-memory");
        }
    }
    let mut profile = match resolve_profile(
        None,
        false,
        Path::new(PRIMARY_CONFIG),
        Path::new(LEGACY_CONFIG),
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[celestea-studio] profile error: {e:#}");
            std::process::exit(1);
        }
    };
    // W218: remove the step limit. The agent loop runs _step over
    // 0..max_steps, so max_steps=0 means *zero* steps (not unlimited);
    // "no limit" is expressed as a high floor (4096). A config may only
    // raise the cap, never lower it below MIN_STEPS.
    profile.max_steps = profile.max_steps.max(MIN_STEPS);

    // W236: model providers store. providers.json carries api_key plaintext
    // (contract), so the file is 0600 + gitignored; CELESTEA_PROVIDERS_FILE
    // overrides the path (smoke instances). Loading it here — before the
    // first compose — lets a persisted default_model override the
    // celestea.toml model at startup.
    let providers_path = std::env::var("CELESTEA_PROVIDERS_FILE")
        .ok()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("providers.json"));
    let providers = Arc::new(match crate::providers::ProvidersStore::open(providers_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[celestea-studio] providers error: {e}");
            std::process::exit(1);
        }
    });
    if let Some(dm) = crate::providers::apply_startup_default(&providers, &mut profile) {
        eprintln!(
            "[celestea-studio] providers.json default_model '{dm}' overrides celestea.toml (applied before compose)"
        );
    }
    let model = profile.model.clone();
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );
    let gen = match build_gen(profile, &providers) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[celestea-studio] compose error: {e}");
            std::process::exit(1);
        }
    };

    let state = Arc::new(AppState {
        gen: RwLock::new(gen),
        bcast: broadcast::channel(512).0,
        busy: Arc::new(Mutex::new(None)),
        next_turn: Arc::new(AtomicU64::new(1)),
        seq: Arc::new(AtomicU64::new(0)),
        status: StatusTracker::new(),
        providers,
        workspaces: registry,
        gen_epoch: watch::channel(0).0,
    });

    // W240: auto-wake loop — worker receipts delivered to the active session's
    // cli-main mailbox wake the host agent into an automatic turn (no client
    // POST /api/turn needed). CELESTEA_AUTOWAKE=0/off disables it.
    if crate::autowake_enabled() {
        let _autowake = crate::spawn_autowake(state.clone());
        eprintln!(
            "[celestea-studio] autowake loop started (CELESTEA_AUTOWAKE=0/off to disable)"
        );
    } else {
        eprintln!("[celestea-studio] autowake loop disabled (CELESTEA_AUTOWAKE)");
    }

    let app = Router::new()
        .route("/", get(get_static))
        .route("/index.html", get(get_static))
        .route("/assets/{*path}", get(get_static))
        .route("/favicon.ico", get(get_static))
        .route("/api/health", get(get_health))
        .route("/api/status", get(api::get_status))
        .route("/api/events", get(get_events))
        .route("/api/turn", post(post_turn))
        .route("/api/cancel", post(post_cancel))
        .route("/api/tools", get(api::get_tools))
        .route("/api/config", get(api::get_config).post(api::post_config))
        .route("/api/sessions", get(workspaces::get_sessions).post(workspaces::post_session_create))
        // W236/W237: session ids contain a slash ("<workspace>/<session>");
        // clients pass them percent-encoded (the W227 frontend uses
        // encodeURIComponent), which axum decodes back into the segment value.
        .route("/api/sessions/{id}/messages", get(workspaces::get_session_messages))
        .route("/api/sessions/{id}/activate", post(workspaces::post_session_activate))
        .route("/api/sessions/{id}/rename", post(workspaces::post_session_rename))
        .route("/api/sessions/{id}/branch", post(workspaces::post_session_branch))
        // W259: /compact —— 上下文压缩（409 = turn 进行中）
        .route("/api/sessions/{id}/compact", post(compact::post_session_compact))
        .route("/api/sessions/{id}/archive", post(workspaces::post_session_archive))
        .route("/api/sessions/{id}/unarchive", post(workspaces::post_session_unarchive))
        .route("/api/sessions/batch-archive", post(workspaces::post_sessions_batch_archive))
        .route("/api/sessions/batch-delete", post(workspaces::post_sessions_batch_delete))
        .route("/api/workspaces", get(workspaces::get_workspaces).post(workspaces::post_workspace_create))
        .route("/api/workspaces/{name}/rename", post(workspaces::post_workspace_rename))
        .route("/api/workspaces/{name}/delete", post(workspaces::post_workspace_delete))
        .route("/api/workspaces/batch-delete", post(workspaces::post_workspaces_batch_delete))
        .route("/api/fs/browse", get(workspaces::get_fs_browse))
        .route("/api/providers", get(providers::get_providers).post(providers::post_providers))
        .route("/api/providers/{id}/delete", post(providers::post_provider_delete))
        .route("/api/providers/test", post(providers::post_provider_test))
        .route("/api/providers/{id}/models/fetch", post(providers::post_models_fetch))
        .route("/api/providers/default", post(providers::post_provider_default))
        .route("/api/prompts", get(prompts::get_prompts).post(prompts::post_prompts_upsert))
        .route("/api/prompts/{id}/delete", post(prompts::post_prompts_delete))
        .route("/api/prompts/{id}/default", post(prompts::post_prompts_default))
        .route("/api/clear", post(workspaces::post_clear))
        .route("/api/worker/spawn", post(api::post_worker_spawn))
        .route("/api/worker/send", post(api::post_worker_send))
        .route("/api/worker/status", get(api::get_worker_status))
        .fallback(get_static)
        .with_state(state);

    let bind = std::env::var("STUDIO_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[celestea-studio] bind {bind} failed: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "[celestea-studio] listening on http://{bind}  (model={model}, base_url={base_url})"
    );
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[celestea-studio] server error: {e}");
        std::process::exit(1);
    }
}

// ---- W240 tests ------------------------------------------------------------

#[cfg(test)]
mod w240_tests {
    use super::*;

    use celestea_core::{
        Llm, LlmError, LlmService, LlmStream, Message, ModelRequest, StreamEvent,
    };
    use futures::StreamExt;

    /// Scripted LLM: pops the next pre-baked reply per generate() call, so a
    /// composed Runtime turns are deterministic and network-free.
    struct FakeLlm {
        replies: std::sync::Mutex<std::collections::VecDeque<Message>>,
    }
    impl FakeLlm {
        fn new(replies: Vec<Message>) -> Self {
            Self { replies: std::sync::Mutex::new(replies.into()) }
        }
    }
    #[async_trait::async_trait]
    impl Llm for FakeLlm {
        async fn generate(&self, _req: ModelRequest) -> Result<LlmStream, LlmError> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Message::assistant_text("done"));
            Ok(futures::stream::iter(vec![StreamEvent::Done(reply)]).boxed())
        }
    }

    /// Minimal Runtime assembly: engine compose (real tool/session wiring,
    /// cli-main registered in the WorkerRegistry) with the LLM adapter swapped
    /// for the scripted fake afterwards (Context::provide replaces by type).
    pub(crate) fn test_runtime(profile: Profile, replies: Vec<Message>) -> Arc<Runtime> {
        let mut rt = Runtime::compose(&profile).expect("compose");
        rt.ctx.provide(LlmService(Arc::new(FakeLlm::new(replies))));
        Arc::new(rt)
    }

    /// AppState for the wake loop: one generation over the given runtime.
    pub(crate) fn build_state(dir: &Path, profile: Profile, runtime: Arc<Runtime>) -> Shared {
        let gen = Gen {
            model: profile.model.clone(),
            base_url: resolve_base_url(profile.base_url.as_deref(), None),
            reasoning_effort: Value::Null,
            config_json: json!({}),
            profile,
            runtime,
        };
        Arc::new(AppState {
            gen: RwLock::new(gen),
            bcast: broadcast::channel(64).0,
            busy: Arc::new(Mutex::new(None)),
            next_turn: Arc::new(AtomicU64::new(1)),
            seq: Arc::new(AtomicU64::new(0)),
            status: StatusTracker::new(),
            providers: Arc::new(
                crate::providers::ProvidersStore::open(dir.join("providers.json")).unwrap(),
            ),
            workspaces: Arc::new(crate::workspaces::WorkspaceRegistry::new(
                dir.join("workspaces.json"),
            )),
            gen_epoch: watch::channel(0).0,
        })
    }

    pub(crate) fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w240-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn user_count(rt: &Runtime) -> usize {
        rt.session
            .events()
            .iter()
            .filter(|e| matches!(e, SessionEvent::UserMessage { .. }))
            .count()
    }

    async fn wait_until<F: Fn() -> bool>(what: &str, f: F) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if f() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for {what}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub(crate) fn test_profile() -> Profile {
        merge_profile(&json!({
            "model": "deepseek-v4-flash-0731",
            "api_key_env": "W240_TEST_KEY",
        }))
        .expect("lenient merge")
    }

    /// The core acceptance case: a receipt on the cli-main mailbox runs ONE
    /// automatic turn (no POST /api/turn) while the busy slot is idle — the
    /// receipt becomes the turn input with sender provenance, the reply lands
    /// in the session log, the mailbox drains, the busy slot is released and
    /// the whole turn rides the standard SSE bus (start with source=autowake,
    /// done with the reply).
    #[tokio::test]
    async fn autowake_runs_auto_turn_on_mailbox_message_when_idle() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("autowake-run");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let profile = test_profile();
        let rt = test_runtime(profile.clone(), vec![Message::assistant_text("auto reply")]);
        let st = build_state(&dir, profile, rt.clone());

        let mut rx = st.bcast.subscribe();
        let h = spawn_autowake(st.clone());

        // engine-side delivery: a worker receipt lands on cli-main's mailbox
        rt.workers
            .mailbox()
            .send("cli-main", "receipt: all done", "W240");

        // no HTTP request anywhere — the loop wakes on its own
        wait_until("auto turn to complete", || {
            rt.session.events().iter().any(|e| {
                matches!(e, SessionEvent::AssistantMessage { text } if text == "auto reply")
            })
        })
        .await;

        // receipt became the turn input, with sender provenance
        assert!(rt.session.events().iter().any(|e| {
            matches!(e, SessionEvent::UserMessage { text } if text == "[from W240] receipt: all done")
        }));
        assert_eq!(rt.workers.mailbox().pending("cli-main"), 0, "mailbox drained");
        assert!(st.busy.lock().await.is_none(), "busy slot released");

        // the automatic turn rode the standard SSE bus
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(ev);
        }
        let done = events
            .iter()
            .find(|e| e.kind == "done")
            .expect("done event on the SSE bus");
        assert_eq!(done.data["turn"], 1, "first auto turn");
        assert_eq!(done.data["payload"]["text"], "auto reply");
        let start = events
            .iter()
            .find(|e| e.kind == "status" && e.data["payload"]["phase"] == "start")
            .expect("start status event");
        assert_eq!(start.data["payload"]["source"], "autowake");

        h.abort();
        std::env::remove_var("W240_TEST_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Generation-aware rebind: after swap_gen the loop drops its old-mailbox
    /// subscription, follows the epoch bump onto the NEW generation's mailbox
    /// and runs the auto turn there; a message that later lands on the OLD
    /// generation's mailbox is left untouched (no spurious turn).
    #[tokio::test]
    async fn autowake_rebinds_after_generation_swap() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("autowake-swap");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let profile = test_profile();
        let rt_a = test_runtime(profile.clone(), vec![Message::assistant_text("reply-A")]);
        let st = build_state(&dir, profile.clone(), rt_a.clone());
        let h = spawn_autowake(st.clone());

        rt_a.workers.mailbox().send("cli-main", "first receipt", "W1");
        wait_until("turn A to complete", || {
            rt_a.session
                .events()
                .iter()
                .any(|e| matches!(e, SessionEvent::AssistantMessage { text } if text == "reply-A"))
        })
        .await;
        // let the busy slot settle before the hot swap
        wait_until("busy release after turn A", || {
            st.busy.try_lock().map(|b| b.is_none()).unwrap_or(false)
        })
        .await;

        // hot swap onto a new generation (new runtime + new mailbox)
        let rt_b = test_runtime(profile.clone(), vec![Message::assistant_text("reply-B")]);
        let gen_b = Gen {
            model: profile.model.clone(),
            base_url: resolve_base_url(profile.base_url.as_deref(), None),
            reasoning_effort: Value::Null,
            config_json: json!({}),
            profile: profile.clone(),
            runtime: rt_b.clone(),
        };
        let epoch_before = *st.gen_epoch.borrow();
        swap_gen(&st, gen_b);
        assert_eq!(
            *st.gen_epoch.borrow(),
            epoch_before + 1,
            "swap bumps the generation epoch"
        );

        // a receipt on the NEW generation's mailbox still wakes the loop
        rt_b.workers.mailbox().send("cli-main", "second receipt", "W2");
        wait_until("turn B to complete", || {
            rt_b.session
                .events()
                .iter()
                .any(|e| matches!(e, SessionEvent::AssistantMessage { text } if text == "reply-B"))
        })
        .await;
        assert!(rt_b.session.events().iter().any(|e| {
            matches!(e, SessionEvent::UserMessage { text } if text == "[from W2] second receipt")
        }));
        assert_eq!(rt_b.workers.mailbox().pending("cli-main"), 0);

        // the OLD generation's mailbox is no longer subscribed: a stale-gen
        // message stays queued and never triggers a turn on A
        let user_before = user_count(&rt_a);
        rt_a.workers.mailbox().send("cli-main", "stale receipt", "W9");
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            rt_a.workers.mailbox().pending("cli-main"),
            1,
            "old-generation message left queued"
        );
        assert_eq!(
            user_count(&rt_a),
            user_before,
            "no turn ran on the old generation"
        );

        h.abort();
        std::env::remove_var("W240_TEST_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The busy-conflict contract: while a turn runs the popped receipt is
    /// re-queued (no loss) and processed once the busy slot frees up.
    #[tokio::test]
    async fn autowake_leaves_message_queued_while_busy() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("autowake-busy");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let profile = test_profile();
        let rt = test_runtime(profile.clone(), vec![Message::assistant_text("after busy")]);
        let st = build_state(&dir, profile, rt.clone());
        let h = spawn_autowake(st.clone());

        // a turn is already running (busy taken, as post_turn does)
        let (tx, _rx) = watch::channel(false);
        *st.busy.lock().await = Some(tx);

        rt.workers.mailbox().send("cli-main", "receipt while busy", "W240");
        tokio::time::sleep(Duration::from_millis(400)).await;
        // message survives the busy window (re-queued, not lost) and no turn
        // ran on the busy runtime
        assert_eq!(
            rt.workers.mailbox().pending("cli-main"),
            1,
            "receipt stays queued while busy"
        );
        assert_eq!(user_count(&rt), 0, "no turn while busy");

        // free the busy slot -> the loop picks the receipt up and runs
        *st.busy.lock().await = None;
        wait_until("auto turn after busy release", || {
            rt.session.events().iter().any(|e| {
                matches!(e, SessionEvent::AssistantMessage { text } if text == "after busy")
            })
        })
        .await;
        assert_eq!(rt.workers.mailbox().pending("cli-main"), 0);
        assert!(st.busy.lock().await.is_none());

        h.abort();
        std::env::remove_var("W240_TEST_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// CELESTEA_AUTOWAKE switch parsing: default on, 0/off/false/no off.
    #[test]
    fn autowake_switch_parses_env_values() {
        std::env::remove_var("CELESTEA_AUTOWAKE");
        assert!(autowake_enabled(), "default on");
        for off in ["0", "off", "false", "no"] {
            std::env::set_var("CELESTEA_AUTOWAKE", off);
            assert!(!autowake_enabled(), "{off} disables");
        }
        for on in ["1", "on", "true", "yes", "weird"] {
            std::env::set_var("CELESTEA_AUTOWAKE", on);
            assert!(autowake_enabled(), "{on} keeps on");
        }
        std::env::remove_var("CELESTEA_AUTOWAKE");
    }

    /// W243: the DSH-style default prompt keeps the fallback contract
    /// (post_config maps "" -> DEFAULT_SYSTEM_PROMPT) and carries the key
    /// paragraphs: identity, tool-call discipline, worker receipt flow.
    #[test]
    fn default_system_prompt_carries_worker_receipt_contract() {
        assert!(DEFAULT_SYSTEM_PROMPT().contains("You are an AI agent powered by the Celestea engine"));
        assert!(DEFAULT_SYSTEM_PROMPT().contains("never wrap tool calls in prose"));
        assert!(DEFAULT_SYSTEM_PROMPT().contains("run_shell background:true"));
        assert!(DEFAULT_SYSTEM_PROMPT().contains("report_to=cli-main"));
        assert!(DEFAULT_SYSTEM_PROMPT().contains("results/<wid>-*.md"));
        assert!(DEFAULT_SYSTEM_PROMPT().contains("mention the primary outputs in your final response"));
    }
}


/// W262: the model catalog of the config contract is built from the provider
/// store (with the static AVAILABLE_MODELS as fallback) — these tests pin the
/// grouping/dedup/fallback rules the statusline tree renders.
/// W263: statusline usage / cache-hit-ratio / real-context-usage surface.
/// Reuses the W240 test harness (scripted FakeLlm + composed Runtime) so the
/// engine's own UsageTracker is the only moving part.
#[cfg(test)]
mod w263_statusline_tests {
    use super::w240_tests::{build_state, scratch, test_profile, test_runtime};
    use super::*;

    use celestea_core::{Message, ToolCall};

    /// One usage frame as a provider reports it (deepseek-style cache hit).
    fn frame(prompt: u64, cache_read: u64) -> Usage {
        Usage {
            prompt_tokens: prompt,
            completion_tokens: 400,
            total_tokens: prompt + 400,
            cache_read,
            reasoning_tokens: 60,
        }
    }

    fn view_of(rt: &Runtime, window: u64) -> StatusView {
        StatusView {
            model: "test-model".to_string(),
            reasoning_effort: Value::Null,
            status: StatusTracker::new(),
            session: rt.session.clone(),
            context_window: window,
            usage: rt.usage.clone(),
        }
    }

    /// 无用量：cache_hit_ratio 为 0，context_usage 回退字符估算（契约字段名不变）。
    #[tokio::test]
    async fn no_usage_yields_zero_ratio_and_estimated_fallback() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let rt = test_runtime(test_profile(), vec![Message::assistant_text("reply text")]);
        let view = view_of(&rt, 1_000_000);

        // empty session + no usage → 0 estimate, still the documented shape
        let v = statusline_of(&view);
        assert_eq!(v["usage"]["prompt_tokens"], json!(0));
        assert_eq!(v["usage"]["cache_read"], json!(0));
        assert_eq!(v["usage"]["cache_hit_ratio"], json!(0.0));
        assert_eq!(v["usage"]["total"]["cache_hit_ratio"], json!(0.0));
        assert_eq!(v["context_usage"]["used"], json!(0));
        assert_eq!(v["context_usage"]["estimated"], json!(true));
        assert_eq!(v["context_usage"]["method"], json!("session_event_chars"));

        // a real turn fills the session log (FakeLlm reports NO usage frame)
        let (cancel_tx, cancel_rx) = watch::channel(false);
        drop(cancel_tx);
        rt.run_turn("hello there", Some(cancel_rx), None)
            .await
            .expect("turn runs");
        let v = statusline_of(&view);
        assert_eq!(v["usage"]["prompt_tokens"], json!(0), "engine reported no usage");
        assert_eq!(v["usage"]["cache_hit_ratio"], json!(0.0));
        let used = v["context_usage"]["used"].as_u64().unwrap();
        assert!(used > 0, "char estimate must be non-zero after a turn, got {used}");
        assert_eq!(v["context_usage"]["estimated"], json!(true));
        assert_eq!(v["context_usage"]["method"], json!("session_event_chars"));
    }

    /// 有用量：cache_hit_ratio = cache_read/prompt_tokens（最近一次），
    /// total 为累计值；context_usage 走真实分支（estimated:false）。
    #[tokio::test]
    async fn usage_drives_cache_ratio_and_real_context_usage() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let rt = test_runtime(test_profile(), vec![]);
        let view = view_of(&rt, 1_000_000);

        rt.usage.record(frame(10_000, 7_800));
        let v = statusline_of(&view);
        assert_eq!(v["usage"]["prompt_tokens"], json!(10_000));
        assert_eq!(v["usage"]["completion_tokens"], json!(400));
        assert_eq!(v["usage"]["cache_read"], json!(7_800));
        assert_eq!(v["usage"]["cache_hit_ratio"], json!(0.78), "7800/10000");
        assert_eq!(v["usage"]["reasoning_tokens"], json!(60));
        assert_eq!(v["usage"]["total"]["cache_hit_ratio"], json!(0.78));
        // real branch: prompt_tokens / window, 4 decimals, not estimated
        assert_eq!(v["context_usage"]["used"], json!(10_000));
        assert_eq!(v["context_usage"]["ratio"], json!(0.01));
        assert_eq!(v["context_usage"]["estimated"], json!(false));
        assert_eq!(v["context_usage"]["method"], json!("usage_prompt_tokens"));

        // second stream: latest replaces, total accumulates (cumulative ratio
        // is computed from the summed counters, not averaged ratios)
        rt.usage.record(frame(2_000, 0));
        let v = statusline_of(&view);
        assert_eq!(v["usage"]["prompt_tokens"], json!(2_000));
        assert_eq!(v["usage"]["cache_hit_ratio"], json!(0.0));
        assert_eq!(v["usage"]["total"]["prompt_tokens"], json!(12_000));
        assert_eq!(v["usage"]["total"]["cache_read"], json!(7_800));
        assert_eq!(v["usage"]["total"]["cache_hit_ratio"], json!(0.65), "7800/12000");
        assert_eq!(v["context_usage"]["used"], json!(2_000));

        // window 0 (trimming off) falls back to the contract display window
        let v0 = statusline_of(&view_of(&rt, 0));
        assert_eq!(v0["context_usage"]["window"], json!(CONTEXT_WINDOW));
        assert_eq!(v0["context_usage"]["ratio"], json!(0.002));
    }

    /// W263：顶部 #slSteps（/api/status steps）与底部状态栏口径一致 ——
    /// 每个 tool_call 记 1 步，tool_result 不再重复计数。
    #[tokio::test]
    async fn status_steps_count_one_per_tool_call() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("steps");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("readme.txt");
        std::fs::write(&file, "hello").unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let profile = test_profile();
        let rt = test_runtime(
            profile.clone(),
            vec![
                Message::assistant_tool_call(ToolCall {
                    id: "call-1".to_string(),
                    name: "read_file".to_string(),
                    args: json!({"path": file.to_string_lossy()}),
                }),
                Message::assistant_text("done"),
            ],
        );
        let st = build_state(&dir, profile, rt.clone());
        assert_eq!(st.statusline()["steps"], json!(0));
        let (_tx, cancel_rx) = watch::channel(false);
        execute_turn(st.clone(), rt.clone(), 1, "read it".to_string(), cancel_rx)
            .await
            .expect("turn completes");
        assert_eq!(st.statusline()["steps"], json!(1), "one call = one step");
    }

    /// SSE status 事件与 GET /api/status 都带 usage：execute_turn 的终态
    /// status 事件里 statusline.usage 与信封 turn 同时到位。
    #[tokio::test]
    async fn sse_status_event_and_api_status_carry_usage() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("usage-status");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::set_var("W240_TEST_KEY", "sk-test");

        let profile = test_profile();
        let rt = test_runtime(profile.clone(), vec![Message::assistant_text("hi back")]);
        let st = build_state(&dir, profile, rt.clone());
        rt.usage.record(frame(10_000, 7_800));

        let mut rx = st.bcast.subscribe();
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        execute_turn(st.clone(), rt.clone(), 7, "hello".to_string(), cancel_rx)
            .await
            .expect("turn completes");

        // GET /api/status shape (AppState::statusline + the session field)
        let status = st.statusline();
        assert_eq!(status["usage"]["cache_hit_ratio"], json!(0.78));
        assert_eq!(status["usage"]["total"]["prompt_tokens"], json!(10_000));
        assert_eq!(status["context_usage"]["estimated"], json!(false));
        assert_eq!(status["context_usage"]["method"], json!("usage_prompt_tokens"));

        // SSE status event: envelope turn + nested statusline usage
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(ev);
        }
        let done = events
            .iter()
            .find(|e| e.kind == "status" && e.data["payload"]["phase"] == "completed")
            .expect("completed status event on the bus");
        assert_eq!(done.data["turn"], json!(7), "envelope carries the turn");
        assert_eq!(
            done.data["payload"]["statusline"]["usage"]["cache_hit_ratio"],
            json!(0.78)
        );
        assert_eq!(
            done.data["payload"]["statusline"]["context_usage"]["estimated"],
            json!(false)
        );
    }
}

#[cfg(test)]
mod w262_tests {
    use super::*;
    use crate::providers::{Provider, ProviderModel, ProvidersStore, ENGINE_FORMAT};

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w262-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn model(id: &str, name: &str, efforts: &[&str]) -> ProviderModel {
        ProviderModel {
            id: id.to_string(),
            name: name.to_string(),
            reasoning_efforts: efforts.iter().map(|e| e.to_string()).collect(),
            context_window: None,
            max_output_tokens: None,
        }
    }

    fn provider(id: &str, name: &str, models: Vec<ProviderModel>) -> Provider {
        Provider {
            id: id.to_string(),
            name: name.to_string(),
            note: String::new(),
            base_url: "http://127.0.0.1:9/v1".to_string(),
            request_format: ENGINE_FORMAT.to_string(),
            api_key: Some("sk-w262-secret".to_string()),
            models,
        }
    }

    fn models_of(available: &Value) -> Vec<Value> {
        available
            .get("models")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default()
    }

    fn entry<'a>(models: &'a [Value], id: &str) -> &'a Value {
        models
            .iter()
            .find(|m| m.get("id").and_then(|i| i.as_str()) == Some(id))
            .unwrap_or_else(|| panic!("model '{id}' missing from available.models"))
    }

    /// Provider-store models come first, carry their provider's display name,
    /// and never leak the api_key.
    #[test]
    fn available_models_carry_provider_name_and_never_a_key() {
        let dir = scratch("store");
        std::fs::create_dir_all(&dir).unwrap();
        let store = ProvidersStore::open(dir.join("providers.json")).unwrap();
        store
            .upsert(provider(
                "p1",
                "本地网关",
                vec![
                    model("deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731", &["low", "high"]),
                    model("mystery-model", "", &[]),
                ],
            ))
            .unwrap();

        let available = available_json(&store);
        let models = models_of(&available);
        assert_eq!(
            entry(&models, "deepseek-v4-flash-0731"),
            &json!({
                "id": "deepseek-v4-flash-0731",
                "name": "DeepSeek V4 Flash 0731",
                "provider": "本地网关",
                "reasoning": true,
            })
        );
        // empty display name falls back to the id; empty efforts + unknown id
        // => reasoning-capable (the POST validation口径)
        assert_eq!(
            entry(&models, "mystery-model"),
            &json!({
                "id": "mystery-model",
                "name": "mystery-model",
                "provider": "本地网关",
                "reasoning": true,
            })
        );
        // effort tiers are untouched by W262
        assert_eq!(available.get("efforts"), Some(&json!(["low", "high", "max"])));
        // ids no provider lists still come from the static catalog (provider "")
        let flash = entry(&models, "deepseek-v4-flash");
        assert_eq!(flash.get("provider").and_then(|p| p.as_str()), Some(""));
        // no key material may ride in the catalog
        assert!(!available.to_string().contains("sk-w262-secret"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Duplicate ids are emitted once: the first provider-store record wins and
    /// the static catalog never repeats a store id (its reasoning flag is still
    /// consulted for store models without an explicit effort list).
    #[test]
    fn available_models_dedupes_ids_across_providers_and_catalog() {
        let dir = scratch("dedupe");
        std::fs::create_dir_all(&dir).unwrap();
        let store = ProvidersStore::open(dir.join("providers.json")).unwrap();
        store
            .upsert(provider(
                "p1",
                "第一提供商",
                vec![
                    // a static-catalog id with NO effort list: the catalog's
                    // reasoning=false must be consulted
                    model("glm-5.3", "GLM 5.3 (store)", &[]),
                    model("shared-id", "Shared (p1)", &[]),
                ],
            ))
            .unwrap();
        store
            .upsert(provider("p2", "第二提供商", vec![model("shared-id", "Shared (p2)", &["low"])]))
            .unwrap();

        let models = models_of(&available_json(&store));
        let shared: Vec<&Value> = models
            .iter()
            .filter(|m| m.get("id").and_then(|i| i.as_str()) == Some("shared-id"))
            .collect();
        assert_eq!(shared.len(), 1, "duplicate id must be emitted once");
        assert_eq!(shared[0].get("provider").and_then(|p| p.as_str()), Some("第一提供商"));
        assert_eq!(shared[0].get("name").and_then(|n| n.as_str()), Some("Shared (p1)"));

        let glm: Vec<&Value> = models
            .iter()
            .filter(|m| m.get("id").and_then(|i| i.as_str()) == Some("glm-5.3"))
            .collect();
        assert_eq!(glm.len(), 1, "a store id must not repeat from the catalog");
        assert_eq!(glm[0].get("provider").and_then(|p| p.as_str()), Some("第一提供商"));
        assert_eq!(
            glm[0].get("reasoning"),
            Some(&json!(false)),
            "store model without efforts falls back to the static reasoning flag"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An empty store still publishes the static catalog (provider "").
    #[test]
    fn available_models_fall_back_to_static_catalog_when_store_empty() {
        let store = ProvidersStore::empty();
        let models = models_of(&available_json(&store));
        assert_eq!(models.len(), AVAILABLE_MODELS.len());
        for (got, want) in models.iter().zip(AVAILABLE_MODELS.iter()) {
            assert_eq!(got.get("id").and_then(|i| i.as_str()), Some(want.id));
            assert_eq!(got.get("name").and_then(|n| n.as_str()), Some(want.name));
            assert_eq!(got.get("provider").and_then(|p| p.as_str()), Some(""));
            assert_eq!(got.get("reasoning"), Some(&json!(want.reasoning)));
        }
        // a store model is APPENDED-TO, never replaces the fallback catalog
        let dir = scratch("fallback");
        std::fs::create_dir_all(&dir).unwrap();
        let store = ProvidersStore::open(dir.join("providers.json")).unwrap();
        store
            .upsert(provider("p1", "P1", vec![model("only-store-model", "Only Store", &["max"])]))
            .unwrap();
        let models = models_of(&available_json(&store));
        assert_eq!(models[0].get("id").and_then(|i| i.as_str()), Some("only-store-model"));
        assert_eq!(models.len(), AVAILABLE_MODELS.len() + 1);
        assert!(models.iter().any(|m| m.get("id").and_then(|i| i.as_str()) == Some("glm-5.3-flash")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
