//! W236: model-provider management — a providers.json-backed store plus the
//! provider HTTP surface, and the shared hot-apply helpers for default_model.
//!
//! Storage: `<cwd>/providers.json` (env override CELESTEA_PROVIDERS_FILE for
//! smoke/parallel instances). The file carries api_key IN PLAINTEXT by
//! contract, so it is created 0600, gitignored, and no log line or HTTP
//! response may ever echo a key: GET and every POST response expose only
//! `has_key: bool`.
//!
//! request_format: "chat_completions" | "responses" | "anthropic_messages".
//! Runtime adapter status: only chat_completions drives the engine adapter
//! today (celestea-runtime's DeepSeekLlm); responses / anthropic_messages are
//! stored + displayed only — the engine adapter for them is TODO (W236 note).
//!
//! Endpoints (mounted in main):
//!   GET  /api/providers                 -> {"providers":[...],"default_model":...}
//!   POST /api/providers                 -> upsert by id (api_key absent = keep)
//!   POST /api/providers/{id}/delete     -> {"ok":true}; clears default_model
//!                                           when the deleted provider owned it
//!   POST /api/providers/test            -> probe GET {base_url}/models (8s)
//!   POST /api/providers/{id}/models/fetch -> probe + {"models":[{"id":..}]}
//!   POST /api/providers/default         -> persist default_model + hot-apply
//!                                           (engine recompose; busy -> 409)

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use celestea_runtime::{resolve_api_key, Profile};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{prepare_gen, profile_to_json, swap_gen, Shared};

/// W236: provider request formats the contract defines. Runtime support:
/// "chat_completions" is the only one the engine adapter (DeepSeekLlm,
/// celestea-runtime) can drive today; the other two are persisted and shown
/// but the engine adapter for them is not yet extended (storage/display only).
pub(crate) const REQUEST_FORMATS: [&str; 3] =
    ["chat_completions", "responses", "anthropic_messages"];
/// The only format the engine adapter currently supports.
pub(crate) const ENGINE_FORMAT: &str = "chat_completions";

// ---- on-disk model -----------------------------------------------------------

/// One model of a provider (the /models catalog entry we store).
// No Debug derive on purpose: api_key-bearing types must never be printed.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ProviderModel {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) reasoning_efforts: Vec<String>,
    #[serde(default)]
    pub(crate) context_window: Option<u64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u64>,
}

/// One provider record as persisted (api_key plaintext, 0600 file).
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Provider {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) note: String,
    pub(crate) base_url: String,
    pub(crate) request_format: String,
    #[serde(default)]
    pub(crate) api_key: Option<String>,
    #[serde(default)]
    pub(crate) models: Vec<ProviderModel>,
}

/// The providers.json root: providers + the persisted default model.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct ProvidersFile {
    #[serde(default)]
    pub(crate) providers: Vec<Provider>,
    #[serde(default)]
    pub(crate) default_model: Option<String>,
}

// ---- store -------------------------------------------------------------------

/// Shared providers store: RwLock over the parsed file + its path; every
/// mutation persists immediately (atomic tmp+rename, 0600).
pub(crate) struct ProvidersStore {
    path: PathBuf,
    inner: RwLock<ProvidersFile>,
}

impl ProvidersStore {
    /// Load the store. A missing file yields an empty store (created on the
    /// first mutation); a malformed file is a hard error — never start from
    /// an empty store over an unreadable one (a later save would destroy the
    /// keys inside).
    pub(crate) fn open(path: PathBuf) -> Result<Self, String> {
        let data = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<ProvidersFile>(&text).map_err(|e| {
                format!("providers.json '{}' is malformed: {e}", path.display())
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProvidersFile::default(),
            Err(e) => {
                return Err(format!(
                    "cannot read providers.json '{}': {e}",
                    path.display()
                ))
            }
        };
        eprintln!(
            "[celestea-studio] providers: {} provider(s) loaded from {} (default_model={:?})",
            data.providers.len(),
            path.display(),
            data.default_model,
        );
        Ok(Self { path, inner: RwLock::new(data) })
    }

    /// Clone of the current data (api keys included — internal use only).
    pub(crate) fn snapshot(&self) -> ProvidersFile {
        self.inner.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub(crate) fn get(&self, id: &str) -> Option<Provider> {
        self.snapshot().providers.into_iter().find(|p| p.id == id)
    }

    pub(crate) fn find_provider_with_model(&self, model: &str) -> Option<Provider> {
        self.snapshot()
            .providers
            .into_iter()
            .find(|p| p.models.iter().any(|m| m.id == model))
    }

    /// Upsert by id; persist. Returns the stored record.
    pub(crate) fn upsert(&self, p: Provider) -> Result<(), String> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        match data.providers.iter_mut().find(|x| x.id == p.id) {
            Some(slot) => *slot = p,
            None => data.providers.push(p),
        }
        save(&self.path, &data)
    }

    /// Remove a provider by id. When default_model belonged to the removed
    /// provider (no surviving provider lists it), default_model is cleared
    /// (contract: deleting a default provider's default model clears it).
    /// Ok(false) = unknown id (no change, nothing persisted).
    pub(crate) fn delete(&self, id: &str) -> Result<bool, String> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let before = data.providers.len();
        data.providers.retain(|p| p.id != id);
        if data.providers.len() == before {
            return Ok(false);
        }
        let dm_still_known = data.default_model.as_deref().is_some_and(|dm| {
            data.providers.iter().any(|p| p.models.iter().any(|m| m.id == dm))
        });
        if !dm_still_known {
            data.default_model = None;
        }
        save(&self.path, &data)?;
        Ok(true)
    }

    /// W262: an empty in-memory store (no path) — for tests that need a store
    /// but never mutate it. `upsert`/`delete` on it would fail to persist.
    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        Self { path: PathBuf::new(), inner: RwLock::new(ProvidersFile::default()) }
    }

    /// Persist default_model (the caller hot-applies the engine separately).
    pub(crate) fn set_default_model(&self, model: &str) -> Result<(), String> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        data.default_model = Some(model.to_string());
        save(&self.path, &data)
    }
}

/// Atomic save: pretty JSON to `<path>.json.tmp` (mode 0600) then rename over
/// the target — the 0600 bit is reasserted on every write. The api_key values
/// ride inside; nothing here ever logs the content.
fn save(path: &Path, data: &ProvidersFile) -> Result<(), String> {
    let text = serde_json::to_string_pretty(data)
        .map_err(|e| format!("providers serialize failed: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("cannot write providers tmp '{}': {e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .map_err(|e| format!("providers write failed: {e}"))?;
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, &text).map_err(|e| format!("providers write failed: {e}"))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("providers rename onto '{}' failed: {e}", path.display()))
}

// ---- public view -------------------------------------------------------------

/// The contract response body for GET /api/providers and the upsert/default
/// POSTs: every provider minus the key (has_key only) + default_model. Never
/// serializes an api_key.
pub(crate) fn public_view(store: &ProvidersStore) -> Value {
    let snap = store.snapshot();
    json!({
        "providers": snap.providers.iter().map(|p| json!({
            "id": p.id,
            "name": p.name,
            "note": p.note,
            "base_url": p.base_url,
            "request_format": p.request_format,
            "models": p.models.iter().map(|m| json!({
                "id": m.id,
                "name": m.name,
                "reasoning_efforts": m.reasoning_efforts,
                "context_window": m.context_window,
                "max_output_tokens": m.max_output_tokens,
            })).collect::<Vec<Value>>(),
            "is_default": snap.default_model.as_deref()
                .is_some_and(|dm| p.models.iter().any(|m| m.id == dm)),
            "has_key": p.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false),
        })).collect::<Vec<Value>>(),
        "default_model": snap.default_model,
    })
}

// ---- validation helpers -------------------------------------------------------

/// Validate request_format against the contract enum. Note (W236): the engine
/// adapter is only wired for chat_completions; the other two are storage +
/// display only until the adapter is extended.
fn validate_request_format(f: &str) -> Result<String, String> {
    let t = f.trim();
    if REQUEST_FORMATS.contains(&t) {
        Ok(t.to_string())
    } else {
        Err(format!(
            "invalid request_format '{t}': expected chat_completions | responses | anthropic_messages"
        ))
    }
}

fn validate_base_url(u: &str) -> Result<String, String> {
    let u = u.trim();
    if u.starts_with("http://") || u.starts_with("https://") {
        Ok(u.to_string())
    } else {
        Err("base_url must be an http:// or https:// URL".to_string())
    }
}

/// Deserialized POST /api/providers body (upsert).
#[derive(Deserialize)]
pub(crate) struct ProviderReq {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) note: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) request_format: Option<String>,
    /// Absent / null / empty = keep the existing key on upsert.
    pub(crate) api_key: Option<String>,
    pub(crate) models: Option<Vec<ProviderModelReq>>,
}

/// Deserialized POST /api/providers/test body (all optional, inline overlay).
#[derive(Deserialize)]
pub(crate) struct ProviderTestReq {
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) note: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) request_format: Option<String>,
    pub(crate) api_key: Option<String>,
    pub(crate) models: Option<Vec<ProviderModelReq>>,
}

#[derive(Deserialize)]
pub(crate) struct ProviderModelReq {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) reasoning_efforts: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) context_window: Option<u64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct DefaultModelReq {
    pub(crate) model: String,
}

/// Map + validate an inline models list onto stored ProviderModels.
fn build_models(req: &[ProviderModelReq]) -> Result<Vec<ProviderModel>, String> {
    req.iter()
        .map(|m| {
            let id = m.id.trim().to_string();
            if id.is_empty() {
                return Err("each model needs a non-empty id".to_string());
            }
            Ok(ProviderModel {
                name: m
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
                id,
                reasoning_efforts: m.reasoning_efforts.clone().unwrap_or_default(),
                context_window: m.context_window,
                max_output_tokens: m.max_output_tokens,
            })
        })
        .collect()
}

/// Merge a POST /api/providers payload onto the stored record (by id): every
/// present field wins; api_key absent / null / empty keeps the existing key
/// (缺省 = 保持原 key). Validation failures are 400-ready strings.
fn provider_from_req(store: &ProvidersStore, req: &ProviderReq) -> Result<Provider, String> {
    let id = req.id.trim().to_string();
    if id.is_empty() {
        return Err("provider id must not be empty".to_string());
    }
    let base_url = validate_base_url(
        req.base_url
            .as_deref()
            .ok_or_else(|| "base_url is required".to_string())?,
    )?;
    let request_format = match req.request_format.as_deref() {
        Some(f) => validate_request_format(f)?,
        None => ENGINE_FORMAT.to_string(),
    };
    let models = match &req.models {
        Some(list) => build_models(list)?,
        None => Vec::new(),
    };
    let keep_key = store.get(&id).and_then(|p| p.api_key.clone());
    let api_key = match req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        Some(k) => Some(k.to_string()), // provided key replaces
        None => keep_key,               // 缺省 = 保持原 key
    };
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&id)
        .to_string();
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    Ok(Provider {
        id,
        name,
        note,
        base_url,
        request_format,
        api_key,
        models,
    })
}

// ---- HTTP probe (test / fetch) -------------------------------------------------

/// GET {base_url}/models (OpenAI-style, Authorization: Bearer <key>) with an
/// ~8s total timeout. Returns (latency_ms, model ids). Error strings never
/// carry the key (the header value is not echoed anywhere). W257: an empty key
/// sends NO Authorization header at all — the transport stays neutral; whether
/// a keyless probe is allowed is the caller's decision, not this function's.
pub(crate) async fn probe_models(
    base_url: &str,
    api_key: &str,
) -> Result<(u128, Vec<String>), String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let start = Instant::now();
    let mut request = client.get(&url);
    let key = api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("GET {url} failed: {e}"))?;
    let latency = start.elapsed().as_millis();
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("reading response failed: {e}"))?;
    if !status.is_success() {
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("HTTP {status}: {snippet}"));
    }
    let v: Value = serde_json::from_str(&body)
        .map_err(|e| format!("response is not JSON ({e}); body head: {}", {
            let s: String = body.chars().take(120).collect();
            s
        }))?;
    let mut ids = Vec::new();
    for arr in [v.get("data"), v.get("models")].into_iter().flatten() {
        if let Some(list) = arr.as_array() {
            for item in list {
                if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                    ids.push(id.to_string());
                }
            }
            break;
        }
    }
    Ok((latency, ids))
}

/// Resolve the provider a test request targets: overlay the inline payload
/// onto the stored record with the requested id (when present). Never echoes
/// keys; returns Ok(candidate) or an Err string that already carries the
/// contract "该请求格式暂不支持自动测试" wording for non-chat formats.
fn candidate_from_test_req(
    store: &ProvidersStore,
    req: &ProviderTestReq,
) -> Result<Provider, String> {
    let existing = req.id.as_deref().and_then(|id| store.get(id.trim()));
    // id is optional for a probe: a fully inline payload (test-before-save)
    // gets a synthetic id; it only labels the candidate, never touches disk.
    let id = req
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| existing.as_ref().map(|p| p.id.clone()))
        .unwrap_or_else(|| "__inline__".to_string());
    let base_url = match req.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) => validate_base_url(u)?,
        None => existing
            .as_ref()
            .map(|p| p.base_url.clone())
            .ok_or_else(|| "base_url is required".to_string())?,
    };
    let request_format = match req.request_format.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(f) => validate_request_format(f)?,
        None => existing
            .as_ref()
            .map(|p| p.request_format.clone())
            .unwrap_or_else(|| ENGINE_FORMAT.to_string()),
    };
    let api_key = match req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        Some(k) => Some(k.to_string()), // inline key wins
        None => existing.as_ref().and_then(|p| p.api_key.clone()),
    };
    let models = match &req.models {
        Some(list) => build_models(list)?,
        None => existing.as_ref().map(|p| p.models.clone()).unwrap_or_default(),
    };
    Ok(Provider {
        name: req
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| existing.as_ref().map(|p| p.name.as_str()))
            .unwrap_or(&id)
            .to_string(),
        note: req
            .note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| existing.as_ref().map(|p| p.note.as_str()))
            .unwrap_or("")
            .to_string(),
        id,
        base_url,
        request_format,
        api_key,
        models,
    })
}

/// W257: identity form of a base_url for the "is this the engine's own
/// gateway?" comparison: trimmed with trailing '/'s dropped, so
/// "http://127.0.0.1:3001/v1" == "http://127.0.0.1:3001/v1/".
fn base_url_identity(base_url: &str) -> &str {
    base_url.trim().trim_end_matches('/')
}

/// W257: the engine's own key, offered ONLY to a provider record whose
/// (normalized) base_url equals the live generation's base_url — i.e. the
/// keyless record points back at the gateway this process is already using.
/// The key comes from the engine's own channel (env[api_key_env], then
/// api_key_file) and is request-scoped: it is never written to providers.json,
/// never returned, and never logged. None = not the engine's origin, or the
/// engine has no key of its own.
fn engine_self_key(st: &Shared, base_url: &str) -> Option<String> {
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    if base_url_identity(base_url) != base_url_identity(&gen.base_url) {
        return None;
    }
    resolve_api_key(&gen.profile)
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// W257: the key a probe should authenticate with: the provider's stored key
/// when it has one, otherwise the engine's own key for a self-origin record
/// (the keyless gateway row). None -> the contract's missing-key error.
fn probe_key(st: &Shared, candidate: &Provider) -> Option<String> {
    if let Some(k) = candidate.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        return Some(k.to_string());
    }
    engine_self_key(st, &candidate.base_url)
}

/// Shared probe for POST /api/providers/test and .../models/fetch: the
/// contract's unsupported-format error for non-chat_completions, missing-key
/// error otherwise, then the real GET {base_url}/models.
async fn run_probe(
    st: &Shared,
    candidate: &Provider,
) -> (StatusCode, Json<Value>) {
    if candidate.request_format != ENGINE_FORMAT {
        // W236: only chat_completions has an engine adapter today; probing a
        // responses / anthropic_messages endpoint is not supported.
        return (
            StatusCode::OK,
            Json(json!({"ok": false, "error": "该请求格式暂不支持自动测试"})),
        );
    }
    let Some(key) = probe_key(st, candidate) else {
        return (
            StatusCode::OK,
            Json(json!({"ok": false, "error": "该提供商未配置 api_key"})),
        );
    };
    match probe_models(&candidate.base_url, &key).await {
        Ok((latency, ids)) => (
            StatusCode::OK,
            Json(json!({"ok": true, "latency_ms": latency, "model_count": ids.len()})),
        ),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))),
    }
}

// ---- startup / hot-apply -------------------------------------------------------

/// W236 startup merge: when providers.json exists and carries default_model,
/// that model overrides the celestea.toml model before the first compose. If
/// the model belongs to a chat_completions provider, base_url + api key are
/// applied too (key via the process env — the engine's only key channel), so
/// the engine adapter can actually reach the provider. responses /
/// anthropic_messages providers contribute the model name only until their
/// engine adapters exist. Returns the applied model id.
pub(crate) fn apply_startup_default(
    store: &ProvidersStore,
    profile: &mut Profile,
) -> Option<String> {
    let snap = store.snapshot();
    let dm = snap.default_model.clone()?;
    profile.model = dm.clone();
    if let Some(p) = snap
        .providers
        .iter()
        .find(|p| p.models.iter().any(|m| m.id == dm))
    {
        if p.request_format == ENGINE_FORMAT {
            if !p.base_url.is_empty() {
                profile.base_url = Some(p.base_url.clone());
            }
            if let Some(k) = p.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                std::env::set_var(profile.api_key_env.as_str(), k);
            }
        }
    }
    Some(dm)
}

/// W236 hot-apply core: swap the engine generation onto `model` — model +
/// (for a chat_completions provider) base_url + api key via env — persist
/// default_model, and swap under the gen write lock. Order: busy guard (409),
/// compose FIRST (a compose failure never persists), persist (a persist
/// failure never swaps), then swap. Mirrors post_config's merge+recompose.
pub(crate) async fn apply_default_model(
    st: &Shared,
    model: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    let guard = st.busy.lock().await;
    if guard.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"ok": false, "error": "a turn is running; provider default applies between turns"})),
        ));
    }

    let provider = st.providers.find_provider_with_model(model);
    let pj = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        let mut pj = profile_to_json(&gen.profile);
        pj["model"] = json!(model);
        if let Some(p) = &provider {
            if p.request_format == ENGINE_FORMAT && !p.base_url.is_empty() {
                pj["base_url"] = json!(p.base_url);
            }
            // 非 chat_completions：仅切模型名 + 持久化；引擎适配器待扩展（W236）。
        }
        pj
    };
    let api_key = provider.as_ref().and_then(|p| p.api_key.clone());

    // 1. compose (env key injection happens inside prepare_gen).
    let gen = prepare_gen(pj, api_key.as_deref(), &st.providers).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": e})),
        )
    })?;
    // 2. persist default_model to providers.json.
    st.providers.set_default_model(model).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": e})),
        )
    })?;
    // 3. swap.
    swap_gen(st, gen);
    drop(guard);
    Ok(())
}

// ---- handlers -------------------------------------------------------------------

/// GET /api/providers — the contract body; has_key only, never the key.
pub(crate) async fn get_providers(State(st): State<Shared>) -> Json<Value> {
    Json(public_view(&st.providers))
}

/// POST /api/providers — upsert by id; api_key absent/null/empty keeps the
/// existing key. Response: 200 with the GET shape.
pub(crate) async fn post_providers(
    State(st): State<Shared>,
    Json(req): Json<ProviderReq>,
) -> impl IntoResponse {
    let provider = match provider_from_req(&st.providers, &req) {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e})))
                .into_response()
        }
    };
    match st.providers.upsert(provider) {
        Ok(()) => (StatusCode::OK, Json(public_view(&st.providers))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

/// POST /api/providers/{id}/delete -> {"ok":true}. Deleting the provider that
/// owned default_model clears default_model (store-level, persisted).
pub(crate) async fn post_provider_delete(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> impl IntoResponse {
    match st.providers.delete(id.trim()) {
        Ok(true) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({"ok": false, "error": format!("unknown provider '{id}'")})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

/// POST /api/providers/test — probe the inline payload (or the stored
/// provider by id) with GET {base_url}/models (OpenAI style, Bearer key,
/// ~8s). 200 always: {"ok":true,"latency_ms","model_count"} or
/// {"ok":false,"error"} (unsupported format uses the contract wording).
pub(crate) async fn post_provider_test(
    State(st): State<Shared>,
    Json(req): Json<ProviderTestReq>,
) -> impl IntoResponse {
    let candidate = match candidate_from_test_req(&st.providers, &req) {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": e})))
                .into_response()
        }
    };
    run_probe(&st, &candidate).await.into_response()
}

/// POST /api/providers/{id}/models/fetch — same probe for a stored provider,
/// returning {"ok":true,"models":[{"id":..}]}.
pub(crate) async fn post_models_fetch(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> impl IntoResponse {
    let Some(provider) = st.providers.get(id.trim()) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"ok": false, "error": format!("unknown provider '{id}'")})),
        )
            .into_response();
    };
    if provider.request_format != ENGINE_FORMAT {
        return (
            StatusCode::OK,
            Json(json!({"ok": false, "error": "该请求格式暂不支持自动测试"})),
        )
            .into_response();
    }
    // W257: a keyless record that points at THIS engine's own gateway probes
    // with the engine's key (request-scoped; never persisted into the store).
    let Some(key) = probe_key(&st, &provider) else {
        return (
            StatusCode::OK,
            Json(json!({"ok": false, "error": "该提供商未配置 api_key"})),
        )
            .into_response();
    };
    match probe_models(&provider.base_url, &key).await {
        Ok((_, ids)) => (
            StatusCode::OK,
            Json(json!({"ok": true, "models": ids.iter().map(|id| json!({"id": id})).collect::<Vec<Value>>()})),
        )
            .into_response(),
        Err(e) => (StatusCode::OK, Json(json!({"ok": false, "error": e}))).into_response(),
    }
}

/// POST /api/providers/default {"model":..} — persist default_model and
/// hot-apply it through the post_config merge+recompose path (busy -> 409).
/// Response: 200 with the GET shape.
pub(crate) async fn post_provider_default(
    State(st): State<Shared>,
    Json(req): Json<DefaultModelReq>,
) -> impl IntoResponse {
    let model = req.model.trim();
    if model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok": false, "error": "model must not be empty"})),
        )
            .into_response();
    }
    match apply_default_model(&st, model).await {
        Ok(()) => (StatusCode::OK, Json(public_view(&st.providers))).into_response(),
        Err(e) => e.into_response(),
    }
}

// ---- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use tokio::sync::{broadcast, Mutex};

    use crate::{build_gen, AppState, StatusTracker};

    /// Unique scratch dir under the system temp dir (no tempfile dep).
    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w236-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn provider(id: &str, model: &str, key: Option<&str>) -> Provider {
        Provider {
            id: id.to_string(),
            name: format!("{id}-name"),
            note: String::new(),
            base_url: "http://127.0.0.1:9/v1".to_string(),
            request_format: ENGINE_FORMAT.to_string(),
            api_key: key.map(str::to_string),
            models: vec![ProviderModel {
                id: model.to_string(),
                name: format!("{model}-name"),
                reasoning_efforts: vec!["low".to_string(), "high".to_string()],
                context_window: Some(1_000_000),
                max_output_tokens: None,
            }],
        }
    }

    fn req(id: &str, key: Option<&str>) -> ProviderReq {
        ProviderReq {
            id: id.to_string(),
            name: None,
            note: None,
            base_url: Some("http://127.0.0.1:9/v1".to_string()),
            request_format: None,
            api_key: key.map(str::to_string),
            models: Some(vec![ProviderModelReq {
                id: "m1".to_string(),
                name: None,
                reasoning_efforts: None,
                context_window: None,
                max_output_tokens: None,
            }]),
        }
    }

    #[test]
    fn upsert_creates_updates_and_keeps_key_when_absent() {
        let dir = scratch("upsert");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        let store = ProvidersStore::open(path.clone()).unwrap();
        assert_eq!(store.snapshot().providers.len(), 0);

        // create with a key (handler merge path)
        store.upsert(provider_from_req(&store, &req("p1", Some("sk-first"))).unwrap()).unwrap();
        assert_eq!(store.snapshot().providers.len(), 1);
        assert_eq!(store.get("p1").unwrap().api_key.as_deref(), Some("sk-first"));

        // update without key -> key kept (缺省 = 保持原 key)
        let merged = provider_from_req(&store, &req("p1", None)).unwrap();
        assert_eq!(
            merged.api_key.as_deref(),
            Some("sk-first"),
            "api_key 缺省 must keep the stored key"
        );
        store.upsert(merged).unwrap();
        let snap = store.snapshot();
        assert_eq!(snap.providers.len(), 1, "upsert by id must not duplicate");
        assert_eq!(snap.providers[0].api_key.as_deref(), Some("sk-first"));

        // update with a new key -> replaced
        store.upsert(provider_from_req(&store, &req("p1", Some("sk-second"))).unwrap()).unwrap();
        assert_eq!(store.get("p1").unwrap().api_key.as_deref(), Some("sk-second"));

        // file on disk is 0600 (contract) and round-trips
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "providers.json must be 0600, got {mode:o}");
        let reloaded = ProvidersStore::open(path.clone()).unwrap();
        assert_eq!(reloaded.get("p1").unwrap().api_key.as_deref(), Some("sk-second"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn public_view_never_echoes_keys() {
        let dir = scratch("view");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        let store = ProvidersStore::open(path).unwrap();
        store.upsert(provider("p1", "m1", Some("sk-secret"))).unwrap();
        store.set_default_model("m1").unwrap();

        let view = public_view(&store);
        let text = view.to_string();
        assert!(!text.contains("sk-secret"), "key leaked in public view: {text}");
        assert!(!text.contains("api_key"), "api_key field leaked: {text}");
        assert_eq!(view["providers"][0]["has_key"], json!(true));
        assert_eq!(view["providers"][0]["is_default"], json!(true));
        assert_eq!(view["default_model"], json!("m1"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_provider_and_clears_owned_default_model() {
        let dir = scratch("delete");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        let store = ProvidersStore::open(path.clone()).unwrap();
        store.upsert(provider("p1", "m1", Some("sk-1"))).unwrap();
        store.upsert(provider("p2", "m2", Some("sk-2"))).unwrap();
        store.set_default_model("m1").unwrap();

        assert!(!store.delete("nope").unwrap(), "unknown id = no-op");
        assert_eq!(store.snapshot().providers.len(), 2);

        assert!(store.delete("p1").unwrap());
        let snap = store.snapshot();
        assert_eq!(snap.providers.len(), 1);
        assert_eq!(snap.default_model, None, "default of deleted provider cleared");

        // deleting a non-default provider keeps the other default
        store.set_default_model("m2").unwrap();
        store.upsert(provider("p3", "m3", Some("sk-3"))).unwrap();
        assert!(store.delete("p3").unwrap());
        assert_eq!(store.snapshot().default_model.as_deref(), Some("m2"));

        // persisted on disk
        let reloaded = ProvidersStore::open(path.clone()).unwrap();
        assert_eq!(reloaded.snapshot().default_model.as_deref(), Some("m2"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_default_overrides_profile_model_and_routes_provider() {
        let dir = scratch("startup");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("providers.json");
        let store = ProvidersStore::open(path).unwrap();
        store.upsert(provider("p1", "m1", Some("sk-startup"))).unwrap();
        store.set_default_model("m1").unwrap();

        let key_env = "W236_STARTUP_KEY";
        std::env::remove_var(key_env);
        let mut profile = Profile {
            model: "from-toml".to_string(),
            api_key_env: key_env.to_string(),
            ..Profile::default()
        };
        assert_eq!(
            apply_startup_default(&store, &mut profile).as_deref(),
            Some("m1")
        );
        assert_eq!(profile.model, "m1", "default_model overrides celestea.toml");
        assert_eq!(profile.base_url.as_deref(), Some("http://127.0.0.1:9/v1"));
        assert_eq!(
            std::env::var(key_env).ok().as_deref(),
            Some("sk-startup"),
            "provider key lands in the engine's env channel"
        );
        std::env::remove_var(key_env);

        // no default_model -> profile untouched
        let store2 = ProvidersStore::open(dir.join("providers-empty.json")).unwrap();
        let mut profile2 = Profile { model: "keep".to_string(), ..Profile::default() };
        assert!(apply_startup_default(&store2, &mut profile2).is_none());
        assert_eq!(profile2.model, "keep");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn default_model_hot_applies_engine_gen_and_persists() {
        // W237: this test mutates process-global env vars and composes the
        // engine — serialize with the workspaces activation/replay test.
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("hotapply");
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(ProvidersStore::open(dir.join("providers.json")).unwrap());
        store.upsert(provider("p1", "m1", Some("sk-hot"))).unwrap();

        let sess = dir.join("sessions");
        std::fs::create_dir_all(&sess).unwrap();
        let key_env = "W236_HOT_KEY";
        std::env::set_var(key_env, "sk-old");
        std::env::set_var("CELESTEA_SESSION_DIR", &sess);
        let profile = Profile {
            model: "old-model".to_string(),
            api_key_env: key_env.to_string(),
            ..Profile::default()
        };
        let gen = build_gen(profile, &store).unwrap();
        let st: Shared = Arc::new(AppState {
            gen: RwLock::new(gen),
            bcast: broadcast::channel(4).0,
            busy: Arc::new(Mutex::new(None)),
            next_turn: Arc::new(AtomicU64::new(1)),
            seq: Arc::new(AtomicU64::new(0)),
            status: StatusTracker::new(),
            providers: store.clone(),
            workspaces: Arc::new(crate::workspaces::WorkspaceRegistry::new(
                dir.join("workspaces.json"),
            )),
            gen_epoch: tokio::sync::watch::channel(0).0,
        });
        assert_eq!(st.gen.read().unwrap().model, "old-model");

        // busy guard: a running turn -> 409, nothing applied or persisted
        let (tx, _rx) = tokio::sync::watch::channel(false);
        *st.busy.lock().await = Some(tx);
        let err = apply_default_model(&st, "m1").await.unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert_eq!(st.gen.read().unwrap().model, "old-model", "busy must not swap");
        assert_eq!(store.snapshot().default_model, None, "busy must not persist");
        *st.busy.lock().await = None;

        apply_default_model(&st, "m1").await.unwrap();

        let gen = st.gen.read().unwrap();
        assert_eq!(gen.model, "m1", "engine gen hot-swapped onto the provider model");
        assert_eq!(gen.base_url, "http://127.0.0.1:9/v1");
        drop(gen);
        assert_eq!(
            store.snapshot().default_model.as_deref(),
            Some("m1"),
            "default_model persisted to providers.json"
        );
        assert_eq!(
            std::env::var(key_env).ok().as_deref(),
            Some("sk-hot"),
            "engine env key channel now holds the provider key"
        );

        // unknown model still applies (custom model passthrough) + persists
        apply_default_model(&st, "custom-model").await.unwrap();
        assert_eq!(st.gen.read().unwrap().model, "custom-model");
        assert_eq!(store.snapshot().default_model.as_deref(), Some("custom-model"));

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var(key_env);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_format_validation_covers_contract_enum() {
        assert!(validate_request_format("chat_completions").is_ok());
        assert!(validate_request_format("responses").is_ok());
        assert!(validate_request_format("anthropic_messages").is_ok());
        assert!(validate_request_format("openai").is_err());
        assert!(validate_request_format("").is_err());
    }

    #[test]
    fn base_url_validation_requires_http_scheme() {
        assert!(validate_base_url("http://127.0.0.1:3001/v1").is_ok());
        assert!(validate_base_url("https://api.example.com").is_ok());
        assert!(validate_base_url("127.0.0.1:3001").is_err());
        assert!(validate_base_url("").is_err());
    }

    // ---- W257: keyless self-origin (own gateway) probe -------------------------

    /// W257: the Authorization header a mock upstream observed (std mutex so
    /// assertions stay synchronous).
    type SeenAuth = Arc<std::sync::Mutex<Option<String>>>;

    /// W257: minimal one-shot HTTP/1.1 upstream. Records the Authorization
    /// header it received (None when absent) and answers a fixed JSON body.
    async fn mock_models_upstream(
        body: &'static str,
    ) -> (String, SeenAuth, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: SeenAuth = Arc::new(std::sync::Mutex::new(None));
        let seen_task = seen.clone();
        let handle = tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string());
                *seen_task.lock().unwrap() = auth;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}/v1"), seen, handle)
    }

    /// W257: AppState whose live generation is the engine at `engine_base`,
    /// holding its own key in env[key_env].
    fn probe_state(dir: &Path, engine_base: &str, key_env: &str) -> Shared {
        std::env::set_var(key_env, "sk-engine-self");
        let sess = dir.join("sessions");
        std::fs::create_dir_all(&sess).unwrap();
        std::env::set_var("CELESTEA_SESSION_DIR", &sess);
        let profile = Profile {
            model: "gateway-model".to_string(),
            base_url: Some(engine_base.to_string()),
            api_key_env: key_env.to_string(),
            ..Profile::default()
        };
        let store = Arc::new(ProvidersStore::open(dir.join("providers.json")).unwrap());
        let gen = build_gen(profile, &store).unwrap();
        Arc::new(AppState {
            gen: RwLock::new(gen),
            bcast: broadcast::channel(4).0,
            busy: Arc::new(Mutex::new(None)),
            next_turn: Arc::new(AtomicU64::new(1)),
            seq: Arc::new(AtomicU64::new(0)),
            status: StatusTracker::new(),
            providers: store,
            workspaces: Arc::new(crate::workspaces::WorkspaceRegistry::new(
                dir.join("workspaces.json"),
            )),
            gen_epoch: tokio::sync::watch::channel(0).0,
        })
    }

    async fn response_parts(res: axum::response::Response) -> (StatusCode, Value) {
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .expect("response body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[test]
    fn base_url_identity_drops_trailing_slashes_and_whitespace() {
        assert_eq!(base_url_identity("http://127.0.0.1:3001/v1/"), "http://127.0.0.1:3001/v1");
        assert_eq!(
            base_url_identity("  http://127.0.0.1:3001/v1///  "),
            base_url_identity("http://127.0.0.1:3001/v1")
        );
        assert_ne!(
            base_url_identity("http://127.0.0.1:3001/v1"),
            base_url_identity("http://127.0.0.1:3002/v1")
        );
    }

    /// W257 acceptance: a keyless stored record whose base_url is the engine's
    /// own gateway really probes upstream with the engine's key (request-scoped,
    /// never persisted, never echoed).
    #[tokio::test]
    async fn keyless_self_origin_record_probes_with_engine_key() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let body = r#"{"data":[{"id":"glm-5.2"},{"id":"deepseek-v4-pro"}]}"#;
        let (base, seen, server) = mock_models_upstream(body).await;
        let dir = scratch("self-origin");
        std::fs::create_dir_all(&dir).unwrap();
        let st = probe_state(&dir, &base, "W257_SELF_KEY");

        // stored gateway record: NO key, trailing slash on the stored URL.
        let mut p = provider("Celestea 网关", "m1", None);
        p.base_url = format!("{base}/");
        st.providers.upsert(p).unwrap();

        let (status, v) = response_parts(
            post_models_fetch(State(st.clone()), AxPath("Celestea 网关".to_string()))
                .await
                .into_response(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["ok"], json!(true), "keyless own-gateway record must probe: {v}");
        assert_eq!(
            v["models"],
            json!([{"id": "glm-5.2"}, {"id": "deepseek-v4-pro"}]),
            "model list from upstream"
        );
        assert!(!v.to_string().contains("sk-engine-self"), "key leaked: {v}");
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            Some("Bearer sk-engine-self"),
            "probe must authenticate with the ENGINE's own key"
        );

        // request-scoped only: providers.json still carries no key
        let disk = std::fs::read_to_string(dir.join("providers.json")).unwrap();
        assert!(!disk.contains("sk-engine-self"), "engine key persisted: {disk}");
        assert_eq!(st.providers.get("Celestea 网关").unwrap().api_key, None);

        server.abort();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W257_SELF_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W257 acceptance: the same keyless record also works through the shared
    /// /api/providers/test probe (run_probe).
    #[tokio::test]
    async fn keyless_self_origin_record_probes_through_shared_run_probe() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let (base, seen, server) = mock_models_upstream(r#"{"data":[{"id":"m1"},{"id":"m2"}]}"#).await;
        let dir = scratch("self-origin-test");
        std::fs::create_dir_all(&dir).unwrap();
        let st = probe_state(&dir, &base, "W257_SELF_KEY2");
        let mut p = provider("gw", "m1", None);
        p.base_url = base.clone();

        let (status, Json(v)) = run_probe(&st, &p).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["ok"], json!(true), "{v:?}");
        assert_eq!(v["model_count"], json!(2));
        assert_eq!(seen.lock().unwrap().as_deref(), Some("Bearer sk-engine-self"));

        server.abort();
        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W257_SELF_KEY2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W257: a keyless record for a DIFFERENT host keeps the contract error,
    /// and nothing is sent upstream.
    #[tokio::test]
    async fn keyless_foreign_record_keeps_missing_key_error() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("foreign");
        std::fs::create_dir_all(&dir).unwrap();
        let st = probe_state(&dir, "http://127.0.0.1:3001/v1", "W257_FOREIGN_KEY");
        let mut p = provider("other", "m1", None);
        p.base_url = "http://127.0.0.1:9/v1".to_string();
        st.providers.upsert(p).unwrap();

        let (status, v) = response_parts(
            post_models_fetch(State(st.clone()), AxPath("other".to_string()))
                .await
                .into_response(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!("该提供商未配置 api_key"));

        // shared probe gate identical
        let candidate = st.providers.get("other").unwrap();
        let (_, Json(v2)) = run_probe(&st, &candidate).await;
        assert_eq!(v2["error"], json!("该提供商未配置 api_key"));

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W257_FOREIGN_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W257: own-origin record but the ENGINE has no key either -> contract error.
    #[tokio::test]
    async fn self_origin_record_without_engine_key_keeps_error() {
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("self-nokey");
        std::fs::create_dir_all(&dir).unwrap();
        let st = probe_state(&dir, "http://127.0.0.1:3001/v1", "W257_NOKEY");
        std::env::remove_var("W257_NOKEY"); // engine key channel empty

        let mut p = provider("gw", "m1", None);
        p.base_url = "http://127.0.0.1:3001/v1/".to_string(); // normalized match
        let (_, Json(v)) = run_probe(&st, &p).await;
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!("该提供商未配置 api_key"));

        std::env::remove_var("CELESTEA_SESSION_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// W257: probe_models itself is header-neutral — empty key = no
    /// Authorization header, non-empty key = Bearer header.
    #[tokio::test]
    async fn probe_models_sends_authorization_only_with_a_key() {
        let (base, seen, server) = mock_models_upstream(r#"{"data":[{"id":"m1"}]}"#).await;
        let (_, ids) = probe_models(&base, "").await.unwrap();
        assert_eq!(ids, vec!["m1".to_string()]);
        assert_eq!(
            seen.lock().unwrap().as_deref(),
            None,
            "empty key must not send an Authorization header"
        );
        server.abort();

        let (base2, seen2, server2) = mock_models_upstream(r#"{"models":[{"id":"m2"}]}"#).await;
        let (_, ids2) = probe_models(&base2, "sk-x").await.unwrap();
        assert_eq!(ids2, vec!["m2".to_string()], "models[] shape also parsed");
        assert_eq!(seen2.lock().unwrap().as_deref(), Some("Bearer sk-x"));
        server2.abort();
    }
}
