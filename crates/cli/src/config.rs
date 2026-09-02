//! Profile loading (lenient by default, `--strict` validates), composition
//! (compose renders the shared Context from a profile), .env handling and
//! API-key / base-url resolution.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use celestea_agent_loop::{DefaultAgentLoop, EventSink};
use celestea_core::{
    AgentConfig, AgentLoop, AgentLoopService, Context, LlmRegistryService, LlmService,
    SessionLog, SessionService, ToolRegistry, ToolRegistryService,
};
use celestea_llm::{deepseek_registry, DeepSeekConfig, DeepSeekLlm, ReasoningEffort};
use celestea_session::InMemorySessionLog;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use serde_json::Value;
use tokio::sync::watch;

use crate::rich::RichRenderer;

/// Runtime configuration loaded from celestea.toml (or the legacy
/// profile.json, or defaults).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Profile {
    pub(crate) model: String,
    pub(crate) system_prompt: String,
    pub(crate) max_steps: usize,
    pub(crate) max_parallel_tool_calls: usize,
    /// Optional API base URL; falls back to env DEEPSEEK_BASE_URL, then the
    /// provider default. The token value itself NEVER lives here (env only).
    pub(crate) base_url: Option<String>,
    /// Optional reasoning effort for reasoning models.
    pub(crate) reasoning_effort: Option<ReasoningEffort>,
    /// Optional output-token cap.
    pub(crate) max_output_tokens: Option<u32>,
    /// Env var that holds the API key (default DEEPSEEK_API_KEY).
    pub(crate) api_key_env: String,
    /// Optional path to a file whose trimmed contents hold the API key
    /// (second priority behind env[api_key_env]; the key value itself is
    /// never stored here).
    pub(crate) api_key_file: Option<String>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            // The agent identity must match celestea_core::AgentConfig::default
            // (W194): the CLI is the celestea agent, not a generic assistant.
            system_prompt: "You are celestea, an AI agent. You are concise, accurate and direct.".into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
            base_url: None,
            reasoning_effort: None,
            max_output_tokens: None,
            api_key_env: "DEEPSEEK_API_KEY".into(),
            api_key_file: None,
        }
    }
}

/// The documented profile keys the CLI understands today. W178 added the
/// model-config keys and W192 added `api_key_file`; `--strict` unknown-key
/// rejection keys off this list.
pub(crate) const PROFILE_KEYS: [&str; 9] = [
    "model",
    "system_prompt",
    "max_steps",
    "max_parallel_tool_calls",
    "base_url",
    "reasoning_effort",
    "max_output_tokens",
    "api_key_env",
    "api_key_file",
];

/// Merge a parsed profile JSON over the defaults (lenient). The root must be
/// an object; only the documented keys are read; unknown keys are ignored and
/// wrong-type fields fall back to the default (backwards compatible).
///
/// Only referenced from tests; production calls `resolve_profile` (which routes
/// through `load_profile_file` / `merge_profile_mode`), so this stays behind
/// `#[cfg(test)]`.
#[cfg(test)]
pub(crate) fn merge_profile(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, false)
}

/// Strict merge: unknown keys and wrong-type fields are hard errors.
#[cfg(test)]
pub(crate) fn merge_profile_strict(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, true)
}

pub(crate) fn merge_profile_mode(json: &Value, strict: bool) -> Result<Profile> {
    let obj = json
        .as_object()
        .ok_or_else(|| anyhow!("profile JSON root must be an object, got {}", json_kind(json)))?;

    if strict {
        for key in obj.keys() {
            if !PROFILE_KEYS.contains(&key.as_str()) {
                bail!(
                    "unknown profile key '{key}' (strict mode; known keys: {})",
                    PROFILE_KEYS.join(", ")
                );
            }
        }
    }

    let mut profile = Profile::default();
    if let Some(v) = obj.get("model") {
        match v.as_str() {
            Some(s) => profile.model = s.to_string(),
            None if strict => {
                bail!("profile field 'model' must be a string, got {}", json_kind(v))
            }
            None => {}
        }
    }
    if let Some(v) = obj.get("system_prompt") {
        match v.as_str() {
            Some(s) => profile.system_prompt = s.to_string(),
            None if strict => {
                bail!("profile field 'system_prompt' must be a string, got {}", json_kind(v))
            }
            None => {}
        }
    }
    if let Some(v) = obj.get("max_steps") {
        match v.as_u64() {
            Some(n) => profile.max_steps = n as usize,
            None if strict => {
                bail!(
                    "profile field 'max_steps' must be a non-negative integer, got {}",
                    json_kind(v)
                )
            }
            None => {}
        }
    }
    if let Some(v) = obj.get("max_parallel_tool_calls") {
        match v.as_u64() {
            Some(n) => profile.max_parallel_tool_calls = n as usize,
            None if strict => bail!(
                "profile field 'max_parallel_tool_calls' must be a non-negative integer, got {}",
                json_kind(v)
            ),
            None => {}
        }
    }
    if let Some(v) = obj.get("base_url") {
        match v.as_str() {
            Some(s) if !s.is_empty() => profile.base_url = Some(s.to_string()),
            Some(_) if strict => bail!(
                "profile field 'base_url' must be a non-empty string, got empty string"
            ),
            None if strict => {
                bail!("profile field 'base_url' must be a string, got {}", json_kind(v))
            }
            _ => {}
        }
    }
    if let Some(v) = obj.get("reasoning_effort") {
        match v.as_str() {
            Some("low") => profile.reasoning_effort = Some(ReasoningEffort::Low),
            Some("medium") => profile.reasoning_effort = Some(ReasoningEffort::Medium),
            Some("high") => profile.reasoning_effort = Some(ReasoningEffort::High),
            Some(other) if strict => bail!(
                "profile field 'reasoning_effort' must be one of \"low\"/\"medium\"/\"high\", got \"{other}\""
            ),
            None if strict => {
                bail!("profile field 'reasoning_effort' must be a string, got {}", json_kind(v))
            }
            _ => {}
        }
    }
    if let Some(v) = obj.get("max_output_tokens") {
        match v.as_u64().and_then(|n| u32::try_from(n).ok()) {
            Some(n) => profile.max_output_tokens = Some(n),
            None if strict => bail!(
                "profile field 'max_output_tokens' must be a non-negative integer (u32), got {}",
                json_kind(v)
            ),
            None => {}
        }
    }
    if let Some(v) = obj.get("api_key_env") {
        match v.as_str() {
            Some(s) if !s.is_empty() => profile.api_key_env = s.to_string(),
            Some(_) if strict => bail!(
                "profile field 'api_key_env' must be a non-empty string, got empty string"
            ),
            None if strict => {
                bail!("profile field 'api_key_env' must be a string, got {}", json_kind(v))
            }
            _ => {}
        }
    }
    if let Some(v) = obj.get("api_key_file") {
        match v.as_str() {
            Some(s) if !s.is_empty() => profile.api_key_file = Some(s.to_string()),
            Some(_) if strict => bail!(
                "profile field 'api_key_file' must be a non-empty string, got empty string"
            ),
            None if strict => {
                bail!("profile field 'api_key_file' must be a string, got {}", json_kind(v))
            }
            _ => {}
        }
    }
    Ok(profile)
}

/// Human-readable kind of a JSON value, for error messages.
fn json_kind(json: &Value) -> &'static str {
    match json {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Convert a parsed TOML value to the JSON value shape the profile merge
/// consumes. TOML integers are i64 (so negatives survive), floats/booleans/
/// strings/arrays/tables map 1:1; datetimes become their string form. Mapping
/// both formats onto one Profile via the same merge keeps --strict semantics
/// identical for TOML and JSON.
fn toml_to_json(v: &toml::Value) -> Value {
    match v {
        toml::Value::String(s) => Value::String(s.clone()),
        toml::Value::Integer(i) => Value::from(*i),
        toml::Value::Float(f) => Value::from(*f),
        toml::Value::Boolean(b) => Value::Bool(*b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(a) => Value::Array(a.iter().map(toml_to_json).collect()),
        toml::Value::Table(t) => Value::Object(
            t.iter()
                .map(|(k, v)| (k.clone(), toml_to_json(v)))
                .collect(),
        ),
    }
}

/// The preferred config file name (TOML). Auto-discovery tries it first.
pub(crate) const DEFAULT_CONFIG: &str = "celestea.toml";
/// Legacy JSON config file name, used as a fallback for backwards
/// compatibility with the pre-TOML profile.json.
pub(crate) const LEGACY_CONFIG: &str = "profile.json";

/// Load a profile from one config file, auto-detecting the format from the
/// extension: `.toml` parses with the `toml` crate (then maps onto the same
/// Profile merge), anything else parses as legacy JSON. Returns `Ok(None)`
/// when the file does not exist, `Ok(Some)` on success, and `Err` on any
/// parse / validation failure (the root must be a table/object; in `strict`
/// mode unknown keys and wrong-type fields are hard errors too).
fn load_profile_file(path: &Path, strict: bool) -> Result<Option<Profile>> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };

    let profile = if path.extension().and_then(|e| e.to_str()) == Some("toml") {
        let toml_value: toml::Value = toml::from_str(&content)
            .map_err(|e| anyhow!("invalid TOML in profile '{}': {}", path.display(), e))?;
        merge_profile_mode(&toml_to_json(&toml_value), strict)
            .map_err(|e| anyhow!("invalid profile '{}': {:#}", path.display(), e))?
    } else {
        let json: Value = serde_json::from_str(&content)
            .map_err(|e| anyhow!("invalid JSON in profile '{}': {}", path.display(), e))?;
        merge_profile_mode(&json, strict)
            .map_err(|e| anyhow!("invalid profile '{}': {:#}", path.display(), e))?
    };
    Ok(Some(profile))
}

/// Load a profile from an explicitly named file. Missing file → defaults
/// (with a notice); parse errors are hard errors. Retained for legacy callers
/// and tests that exercise a single file.
#[cfg(test)]
pub(crate) fn load_profile(path: &Path, strict: bool) -> Result<Profile> {
    match load_profile_file(path, strict)? {
        Some(p) => Ok(p),
        None => {
            eprintln!("profile '{}' not found; using defaults", path.display());
            Ok(Profile::default())
        }
    }
}

/// Resolve the effective profile. An explicit `--profile <path>` wins and the
/// file must exist; otherwise auto-discover the primary TOML file, then the
/// legacy JSON file, then fall back to defaults. All three share the same
/// merge semantics (9 documented keys; `--strict` rejects unknown keys and
/// wrong types in any format).
/// User-level config dir: ~/.celestea (home-dir fallback so celestea
/// works from any working directory).
fn home_config_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(home).join(".celestea"))
}

pub(crate) fn resolve_profile(
    explicit: Option<&Path>,
    strict: bool,
    primary: &Path,
    fallback: &Path,
) -> Result<Profile> {
    if let Some(p) = explicit {
        return load_profile_file(p, strict)?
            .ok_or_else(|| anyhow!("profile '{}' not found", p.display()));
    }
    if let Some(p) = load_profile_file(primary, strict)? {
        return Ok(p);
    }
    if let Some(p) = load_profile_file(fallback, strict)? {
        eprintln!(
            "'{}' not found; using legacy '{}'",
            primary.display(),
            fallback.display()
        );
        return Ok(p);
    }
    // Home-dir fallback: ~/.celestea/celestea.toml then ~/.celestea/profile.json.
    if let Some(dir) = home_config_dir() {
        let hp = dir.join(primary);
        if let Some(p) = load_profile_file(&hp, strict)? {
            return Ok(p);
        }
        let hf = dir.join(fallback);
        if let Some(p) = load_profile_file(&hf, strict)? {
            eprintln!(
                "'{}' not found; using home '{}'",
                primary.display(),
                hf.display()
            );
            return Ok(p);
        }
    }
    eprintln!(
        "no config file ('{}' / '{}'); using defaults",
        primary.display(),
        fallback.display()
    );
    Ok(Profile::default())
}
pub(crate) struct Env {
    pub(crate) ctx: Context,
    pub(crate) session: Arc<dyn SessionLog>,
    pub(crate) registry: Arc<dyn ToolRegistry>,
    /// The AgentConfig derived from the profile; run paths rebuild a loop
    /// per turn (with cancel + optional sink) via make_loop.
    pub(crate) config: AgentConfig,
    /// Rich renderer (None when output is plain/JSON). Its sink is injected
    /// into the per-turn loop so stream events are styled instead of printed.
    pub(crate) renderer: Option<RichRenderer>,
}

impl Env {
    /// The injected sink, if rich rendering is active.
    pub(crate) fn sink(&self) -> Option<EventSink> {
        self.renderer.as_ref().map(|r| r.sink.clone())
    }

    /// Build a per-turn DefaultAgentLoop from the profile config, an optional
    /// cooperative cancel signal and the optional sink.
    pub(crate) fn make_loop(&self, cancel: Option<watch::Receiver<bool>>) -> Arc<dyn AgentLoop> {
        let cfg = self.config.clone();
        let sink = self.sink();
        match (cancel, sink) {
            (Some(rx), Some(s)) => Arc::new(DefaultAgentLoop::with_cancel_sink(cfg, rx, s)),
            (Some(rx), None) => Arc::new(DefaultAgentLoop::with_cancel(cfg, rx)),
            (None, Some(s)) => Arc::new(DefaultAgentLoop::with_sink(cfg, s)),
            (None, None) => Arc::new(DefaultAgentLoop::new(cfg)),
        }
    }
}

/// Resolve the effective base URL: profile value wins, then env
/// DEEPSEEK_BASE_URL, then the provider default. Pure — unit-tested.
pub(crate) fn resolve_base_url(profile_base: Option<&str>, env_base: Option<&str>) -> String {
    profile_base
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| env_base.filter(|s| !s.is_empty()).map(|s| s.to_string()))
        .unwrap_or_else(|| "https://api.deepseek.com".to_string())
}

/// Validate the model string. Model names are free-form: the provider talks
/// to whatever OpenAI-compatible endpoint the profile points at, which
/// decides its own catalog, so there is no hardcoded supported-model list.
/// The only hard check is a non-empty model name. Pure — unit-tested.
pub(crate) fn validate_model(model: &str) -> Result<()> {
    if model.trim().is_empty() {
        bail!("model must not be empty")
    } else {
        Ok(())
    }
}

/// Best-effort `.env` loading: load `path` only when it exists; any failure
/// (unreadable, malformed) is silent — never fatal. Returns true when loaded.
/// Used at startup so `DEEPSEEK_API_KEY` (or whatever api_key_env names) can
/// be supplied by a local `.env` file without exporting it in the shell.
pub(crate) fn load_dotenv_at(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    dotenvy::from_path(path).is_ok()
}

/// Load `.env` from the current directory at startup (best-effort).
pub(crate) fn load_dotenv() {
    let _ = load_dotenv_at(Path::new(".env"));
    if let Some(dir) = home_config_dir() {
        let _ = load_dotenv_at(&dir.join(".env"));
    }
}

/// Resolve the DeepSeek API key with 3-path precedence:
///   1. env[api_key_env] (default DEEPSEEK_API_KEY) — wins when set + non-empty;
///   2. api_key_file — trimmed file contents, when the profile points at one;
///   3. a hard error naming the missing source.
/// The key VALUE is never logged and never written anywhere.
pub(crate) fn resolve_api_key(profile: &Profile) -> Result<String> {
    if let Ok(v) = std::env::var(&profile.api_key_env) {
        let key = v.trim();
        if !key.is_empty() {
            return Ok(key.to_string());
        }
    }
    if let Some(path) = &profile.api_key_file {
        let content = std::fs::read_to_string(path).map_err(|e| {
            anyhow!("cannot read api_key_file '{}': {}", path, e)
        })?;
        let key = content.trim().to_string();
        if !key.is_empty() {
            return Ok(key);
        }
        bail!("api_key_file '{}' is empty", path);
    }
    bail!(
        "API key not found: environment variable '{}' is not set and no api_key_file is configured; set the env var (or point api_key_env at a different variable), or set api_key_file to a file whose trimmed contents are the key",
        profile.api_key_env
    )
}

/// Compose the shared Context from the profile: LLM adapter registry, session,
/// tool registry, agent loop, each registered as its *Service newtype.
pub(crate) fn compose(profile: &Profile) -> Result<Env> {
    // Model validation first: reject an empty model up front, before any
    // secret or URL resolution.
    validate_model(&profile.model)?;

    // API key: env[api_key_env] wins, then api_key_file (trimmed), then error.
    // The token value itself never lives in the profile or any log output.
    let api_key = resolve_api_key(profile)?;

    // base_url precedence: profile.base_url -> env DEEPSEEK_BASE_URL -> default.
    let base_url = resolve_base_url(
        profile.base_url.as_deref(),
        std::env::var("DEEPSEEK_BASE_URL").ok().as_deref(),
    );

    let config = DeepSeekConfig {
        base_url,
        api_key,
        model: profile.model.clone(),
        reasoning_effort: profile.reasoning_effort,
        max_output_tokens: profile.max_output_tokens,
    };
    // LLM adapter registry (multi-provider seam, W189): register the deepseek
    // provider by name, then resolve it. LlmService stays provided for
    // back-compat with consumers that read the single adapter directly;
    // LlmRegistryService is the extension seam for name-routed providers.
    let llm_registry = deepseek_registry(DeepSeekLlm::new(config));
    let resolved = llm_registry
        .resolve("deepseek")
        .expect("deepseek registered above");

    let session: Arc<dyn SessionLog> = Arc::new(InMemorySessionLog::new());

    let mut registry = ToolRegistryImpl::new();
    for tool in builtin_tools() {
        registry.register(tool);
    }
    let registry: Arc<dyn ToolRegistry> = Arc::new(registry);

    let config = AgentConfig {
        model: profile.model.clone(),
        system_prompt: profile.system_prompt.clone(),
        max_steps: profile.max_steps,
        max_parallel_tool_calls: profile.max_parallel_tool_calls,
    };
    // Back-compat plain loop (no sink, no cancel); run paths rebuild a
    // per-turn loop with cancel + optional rich sink via Env::make_loop.
    let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::new(config.clone()));

    let mut ctx = Context::new();
    ctx.provide(LlmService(resolved));
    ctx.provide(LlmRegistryService(Arc::new(llm_registry)));
    ctx.provide(SessionService(session.clone()));
    ctx.provide(ToolRegistryService(registry.clone()));
    ctx.provide(AgentLoopService(agent.clone()));
    Ok(Env { ctx, session, registry, config, renderer: None })
}
