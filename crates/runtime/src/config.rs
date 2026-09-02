//! Profile loading (lenient by default, strict validates), composition of the
//! shared Context (compose renders the engine from a profile), .env handling
//! and api-key / base-url resolution. Extracted from the CLI (W214): pure
//! engine config — no terminal/CLI concepts.

use std::path::Path;

use anyhow::{anyhow, bail, Result};
use celestea_llm::ReasoningEffort;
use serde_json::Value;

/// Runtime configuration loaded from celestea.toml (or the legacy
/// profile.json, or defaults).
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub model: String,
    pub system_prompt: String,
    pub max_steps: usize,
    pub max_parallel_tool_calls: usize,
    /// Model context window in tokens; 0 disables context trimming (W220).
    pub context_window_tokens: u64,
    /// Window fraction (0..=1) that triggers old-message trimming.
    pub context_trim_threshold: f64,
    /// How many most-recent messages to keep when trimming (plus system).
    pub context_keep_recent: usize,
    /// Optional API base URL; falls back to env DEEPSEEK_BASE_URL, then the
    /// provider default. The token value itself NEVER lives here (env only).
    pub base_url: Option<String>,
    /// Optional reasoning effort for reasoning models.
    pub reasoning_effort: Option<ReasoningEffort>,
    /// Optional output-token cap.
    pub max_output_tokens: Option<u32>,
    /// Env var that holds the API key (default DEEPSEEK_API_KEY).
    pub api_key_env: String,
    /// Optional path to a file whose trimmed contents hold the API key
    /// (second priority behind env[api_key_env]; the key value itself is
    /// never stored here).
    pub api_key_file: Option<String>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            // The agent identity must match celestea_core::AgentConfig::default
            // (W194): the runtime is the celestea agent, not a generic assistant.
            system_prompt: "You are celestea, an AI agent. You are concise, accurate and direct."
                .into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
            context_window_tokens: 65_536,
            context_trim_threshold: 0.8,
            context_keep_recent: 10,
            base_url: None,
            reasoning_effort: None,
            max_output_tokens: None,
            api_key_env: "DEEPSEEK_API_KEY".into(),
            api_key_file: None,
        }
    }
}

/// The documented profile keys the runtime understands today. W178 added the
/// model-config keys and W192 added api_key_file; strict unknown-key rejection
/// keys off this list.
pub const PROFILE_KEYS: [&str; 12] = [
    "model",
    "system_prompt",
    "max_steps",
    "max_parallel_tool_calls",
    "context_window_tokens",
    "context_trim_threshold",
    "context_keep_recent",
    "base_url",
    "reasoning_effort",
    "max_output_tokens",
    "api_key_env",
    "api_key_file",
];

/// Merge a parsed profile JSON over the defaults (lenient). The root must be
/// an object; only the documented keys are read; unknown keys are ignored and
/// wrong-type fields fall back to the default (backwards compatible).
pub fn merge_profile(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, false)
}

/// Strict merge: unknown keys and wrong-type fields are hard errors.
pub fn merge_profile_strict(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, true)
}

pub fn merge_profile_mode(json: &Value, strict: bool) -> Result<Profile> {
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
    if let Some(v) = obj.get("context_window_tokens") {
        match v.as_u64() {
            Some(n) => profile.context_window_tokens = n,
            None if strict => bail!(
                "profile field 'context_window_tokens' must be a non-negative integer, got {}",
                json_kind(v)
            ),
            None => {}
        }
    }
    if let Some(v) = obj.get("context_trim_threshold") {
        match v.as_f64() {
            Some(f) if (0.0..=1.0).contains(&f) => profile.context_trim_threshold = f,
            Some(_) if strict => bail!(
                "profile field 'context_trim_threshold' must be between 0.0 and 1.0, got {}",
                json_kind(v)
            ),
            None if strict => bail!(
                "profile field 'context_trim_threshold' must be a number, got {}",
                json_kind(v)
            ),
            _ => {}
        }
    }
    if let Some(v) = obj.get("context_keep_recent") {
        match v.as_u64() {
            Some(n) => profile.context_keep_recent = n as usize,
            None if strict => bail!(
                "profile field 'context_keep_recent' must be a non-negative integer, got {}",
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
/// both formats onto one Profile via the same merge keeps strict semantics
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
pub const DEFAULT_CONFIG: &str = "celestea.toml";
/// Legacy JSON config file name, used as a fallback for backwards
/// compatibility with the pre-TOML profile.json.
pub const LEGACY_CONFIG: &str = "profile.json";

/// Load a profile from one config file, auto-detecting the format from the
/// extension: .toml parses with the toml crate (then maps onto the same
/// Profile merge), anything else parses as legacy JSON. Returns Ok(None)
/// when the file does not exist, Ok(Some) on success, and Err on any
/// parse / validation failure (the root must be a table/object; in strict
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

/// Load a profile from an explicitly named file. Missing file to defaults
/// (with a notice); parse errors are hard errors.
pub fn load_profile(path: &Path, strict: bool) -> Result<Profile> {
    match load_profile_file(path, strict)? {
        Some(p) => Ok(p),
        None => {
            eprintln!("profile '{}' not found; using defaults", path.display());
            Ok(Profile::default())
        }
    }
}

/// Resolve the effective profile. An explicit path wins and the file must
/// exist; otherwise auto-discover the primary TOML file, then the legacy JSON
/// file, then fall back to defaults. All three share the same merge semantics
/// (9 documented keys; strict rejects unknown keys and wrong types in any
/// format). User-level config dir: ~/.celestea (home-dir fallback so the
/// engine works from any working directory).
fn home_config_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(home).join(".celestea"))
}

pub fn resolve_profile(
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

/// Resolve the effective base URL: profile value wins, then env
/// DEEPSEEK_BASE_URL, then the provider default. Pure — unit-tested.
pub fn resolve_base_url(profile_base: Option<&str>, env_base: Option<&str>) -> String {
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
pub fn validate_model(model: &str) -> Result<()> {
    if model.trim().is_empty() {
        bail!("model must not be empty")
    } else {
        Ok(())
    }
}

/// Best-effort .env loading: load path only when it exists; any failure
/// (unreadable, malformed) is silent — never fatal. Returns true when loaded.
/// Used at startup so DEEPSEEK_API_KEY (or whatever api_key_env names) can
/// be supplied by a local .env file without exporting it in the shell.
pub fn load_dotenv_at(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    dotenvy::from_path(path).is_ok()
}

/// Load .env from the current directory at startup (best-effort), then from
/// the home config dir (~/.celestea/.env).
pub fn load_dotenv() {
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
pub fn resolve_api_key(profile: &Profile) -> Result<String> {
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


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// A unique scratch path under the system temp dir (no tempfile dep).
    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("celestea-runtime-test-{}-{}", std::process::id(), name))
    }

    /// Write a profile file, returning its path. Caller cleans up.
    fn write_profile(name: &str, content: &str) -> PathBuf {
        let path = scratch(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn default_profile_uses_celestea_identity() {
        // D: the runtime default system prompt is the celestea agent identity,
        // matching celestea_core::AgentConfig::default (not a generic assistant).
        let p = Profile::default();
        assert_eq!(
            p.system_prompt,
            "You are celestea, an AI agent. You are concise, accurate and direct."
        );
        assert!(!p.system_prompt.contains("helpful assistant"));
    }

    // ---- strict / lenient merge --------------------------------------------
    #[test]
    fn strict_rejects_unknown_key() {
        let err = merge_profile_strict(&json!({ "model": "m", "bogus": 1 })).unwrap_err();
        assert!(err.to_string().contains("unknown profile key 'bogus'"));
    }

    #[test]
    fn strict_rejects_wrong_type() {
        let err = merge_profile_strict(&json!({ "max_steps": "many" })).unwrap_err();
        assert!(err.to_string().contains("max_steps"));
        let err2 = merge_profile_strict(&json!({ "model": 123 })).unwrap_err();
        assert!(err2.to_string().contains("model"));
        let err3 = merge_profile_strict(&json!({ "max_parallel_tool_calls": true })).unwrap_err();
        assert!(err3.to_string().contains("max_parallel_tool_calls"));
    }

    #[test]
    fn strict_rejects_negative_max_steps() {
        let err = merge_profile_strict(&json!({ "max_steps": -3 })).unwrap_err();
        assert!(err.to_string().contains("max_steps"));
    }

    #[test]
    fn strict_accepts_valid_profile() {
        let p = merge_profile_strict(&json!({
            "model": "m",
            "system_prompt": "s",
            "max_steps": 3,
            "max_parallel_tool_calls": 7
        }))
        .unwrap();
        assert_eq!(
            p,
            Profile {
                model: "m".into(),
                system_prompt: "s".into(),
                max_steps: 3,
                max_parallel_tool_calls: 7,
                ..Profile::default()
            }
        );
    }

    #[test]
    fn lenient_still_ignores_unknown_and_wrong_type() {
        let p = merge_profile(&json!({ "model": 123, "bogus": 1 })).unwrap();
        assert_eq!(p, Profile::default());
    }

    // ---- profile loading: legacy W176 cases keep passing --------------------
    #[test]
    fn missing_file_falls_back_to_defaults() {
        let path = scratch("does-not-exist.json");
        let _ = std::fs::remove_file(&path); // make sure it is absent
        let profile = load_profile(&path, false).unwrap();
        assert_eq!(profile, Profile::default());
    }

    #[test]
    fn partial_json_merges_over_defaults() {
        let json = serde_json::json!({
            "model": "custom-model",
            "max_steps": 32
        });
        let profile = merge_profile(&json).unwrap();
        assert_eq!(profile.model, "custom-model");
        assert_eq!(profile.system_prompt, Profile::default().system_prompt);
        assert_eq!(profile.max_steps, 32);
        assert_eq!(
            profile.max_parallel_tool_calls,
            Profile::default().max_parallel_tool_calls
        );
    }

    #[test]
    fn full_json_overrides_everything() {
        let json = serde_json::json!({
            "model": "m2",
            "system_prompt": "be terse",
            "max_steps": 5,
            "max_parallel_tool_calls": 2,
            "unknown_key": "ignored"
        });
        let profile = merge_profile(&json).unwrap();
        assert_eq!(
            profile,
            Profile {
                model: "m2".into(),
                system_prompt: "be terse".into(),
                max_steps: 5,
                max_parallel_tool_calls: 2,
                ..Profile::default()
            }
        );
    }

    #[test]
    fn empty_object_keeps_all_defaults() {
        let profile = merge_profile(&serde_json::json!({})).unwrap();
        assert_eq!(profile, Profile::default());
    }

    #[test]
    fn invalid_json_is_an_error() {
        let path = write_profile("bad.json", "{ not json !!");
        let err = load_profile(&path, false).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.to_string().contains("invalid JSON"));
    }

    #[test]
    fn non_object_root_is_an_error() {
        let err = merge_profile(&serde_json::json!([1, 2, 3])).unwrap_err();
        assert!(err.to_string().contains("must be an object"));
        let err = merge_profile(&serde_json::json!("nope")).unwrap_err();
        assert!(err.to_string().contains("must be an object"));
        assert!(merge_profile(&serde_json::Value::Null).is_err());
        let path = write_profile("array.json", "[1, 2, 3]");
        let err = load_profile(&path, false).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.to_string().contains("must be an object"));
    }

    #[test]
    fn wrong_type_fields_keep_defaults() {
        let json = serde_json::json!({
            "model": 123,
            "system_prompt": ["not", "a", "string"],
            "max_steps": "many",
            "max_parallel_tool_calls": true
        });
        let profile = merge_profile(&json).unwrap();
        assert_eq!(profile, Profile::default());
    }

    #[test]
    fn negative_max_steps_is_ignored() {
        let json = serde_json::json!({ "max_steps": -3 });
        let profile = merge_profile(&json).unwrap();
        assert_eq!(profile.max_steps, Profile::default().max_steps);
    }

    #[test]
    fn load_profile_from_valid_file() {
        let path = write_profile(
            "good.json",
            r#"{"model":"from-file","system_prompt":"s","max_steps":3,"max_parallel_tool_calls":7}"#,
        );
        let profile = load_profile(&path, false).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            profile,
            Profile {
                model: "from-file".into(),
                system_prompt: "s".into(),
                max_steps: 3,
                max_parallel_tool_calls: 7,
                ..Profile::default()
            }
        );
    }

    #[test]
    fn strict_load_profile_rejects_bad_file() {
        let path = write_profile("strict-bad.json", r#"{"model":"m","unknown_thing":true}"#);
        let err = load_profile(&path, true).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.to_string().contains("unknown profile key"));
    }

    // ---- W178: model-config keys (base_url/reasoning_effort/...) -------------
    #[test]
    fn new_keys_parse_lenient() {
        let p = merge_profile(&json!({
            "base_url": "https://proxy.example.test/v1",
            "reasoning_effort": "high",
            "max_output_tokens": 4096,
            "api_key_env": "MY_DEEPSEEK_KEY"
        }))
        .unwrap();
        assert_eq!(p.base_url.as_deref(), Some("https://proxy.example.test/v1"));
        assert_eq!(p.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(p.max_output_tokens, Some(4096));
        assert_eq!(p.api_key_env, "MY_DEEPSEEK_KEY");
    }

    #[test]
    fn new_keys_defaults() {
        let p = Profile::default();
        assert_eq!(p.base_url, None);
        assert_eq!(p.reasoning_effort, None);
        assert_eq!(p.max_output_tokens, None);
        assert_eq!(p.api_key_env, "DEEPSEEK_API_KEY");
    }

    #[test]
    fn strict_accepts_new_keys() {
        let p = merge_profile_strict(&json!({
            "model": "deepseek-reasoner",
            "base_url": "https://proxy.example.test",
            "reasoning_effort": "medium",
            "max_output_tokens": 8192,
            "api_key_env": "K"
        }))
        .unwrap();
        assert_eq!(p.reasoning_effort, Some(ReasoningEffort::Medium));
        assert_eq!(p.max_output_tokens, Some(8192));
        assert_eq!(p.api_key_env, "K");
    }

    #[test]
    fn strict_rejects_bad_new_key_types() {
        let err = merge_profile_strict(&json!({ "base_url": 123 })).unwrap_err();
        assert!(err.to_string().contains("base_url"));
        let err = merge_profile_strict(&json!({ "reasoning_effort": 1 })).unwrap_err();
        assert!(err.to_string().contains("reasoning_effort"));
        let err = merge_profile_strict(&json!({ "max_output_tokens": "many" })).unwrap_err();
        assert!(err.to_string().contains("max_output_tokens"));
        let err = merge_profile_strict(&json!({ "api_key_env": 5 })).unwrap_err();
        assert!(err.to_string().contains("api_key_env"));
    }

    #[test]
    fn strict_rejects_unknown_reasoning_effort_value() {
        let err = merge_profile_strict(&json!({ "reasoning_effort": "extreme" })).unwrap_err();
        assert!(err.to_string().contains("reasoning_effort"));
    }

    #[test]
    fn strict_rejects_negative_max_output_tokens() {
        let err = merge_profile_strict(&json!({ "max_output_tokens": -1 })).unwrap_err();
        assert!(err.to_string().contains("max_output_tokens"));
    }

    #[test]
    fn lenient_ignores_bad_new_key_types() {
        let p = merge_profile(&json!({
            "base_url": 123,
            "reasoning_effort": "extreme",
            "max_output_tokens": "many",
            "api_key_env": 7
        }))
        .unwrap();
        assert_eq!(p, Profile::default());
    }

    #[test]
    fn resolve_base_url_precedence_profile_over_env_over_default() {
        assert_eq!(
            resolve_base_url(Some("https://p.test"), Some("https://e.test")),
            "https://p.test"
        );
        assert_eq!(resolve_base_url(None, Some("https://e.test")), "https://e.test");
        assert_eq!(resolve_base_url(None, None), "https://api.deepseek.com");
        assert_eq!(resolve_base_url(Some(""), Some("https://e.test")), "https://e.test");
    }

    #[test]
    fn validate_model_accepts_any_non_empty_model() {
        assert!(validate_model("deepseek-chat").is_ok());
        assert!(validate_model("deepseek-v4-flash").is_ok());
        assert!(validate_model("glm-5.2").is_ok());
        assert!(validate_model("").is_err());
        assert!(validate_model("   ").is_err());
    }

    // ---- W192: TOML config, .env, api_key_file -----------------------------
    #[test]
    fn toml_profile_parses_and_maps_types() {
        let toml = r#"model = "deepseek-chat"
system_prompt = "be terse"
max_steps = 32
max_parallel_tool_calls = 2
base_url = "https://proxy.example.test/v1"
reasoning_effort = "high"
max_output_tokens = 4096
api_key_env = "MY_KEY"
api_key_file = "/tmp/keys/deepseek.key"
"#;
        let path = write_profile("w192-good.toml", toml);
        let p = load_profile(&path, false).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(p.model, "deepseek-chat");
        assert_eq!(p.system_prompt, "be terse");
        assert_eq!(p.max_steps, 32);
        assert_eq!(p.max_parallel_tool_calls, 2);
        assert_eq!(p.base_url.as_deref(), Some("https://proxy.example.test/v1"));
        assert_eq!(p.reasoning_effort, Some(ReasoningEffort::High));
        assert_eq!(p.max_output_tokens, Some(4096));
        assert_eq!(p.api_key_env, "MY_KEY");
        assert_eq!(p.api_key_file.as_deref(), Some("/tmp/keys/deepseek.key"));
    }

    #[test]
    fn toml_preferred_over_json() {
        let toml_path = write_profile(
            "w192-primary.toml",
            r#"model = "from-toml"
max_steps = 7
"#,
        );
        let json_path = write_profile("w192-fallback.json", r#"{"model":"from-json","max_steps":9}"#);
        let p = resolve_profile(None, false, &toml_path, &json_path).unwrap();
        let _ = std::fs::remove_file(&toml_path);
        let _ = std::fs::remove_file(&json_path);
        assert_eq!(p.model, "from-toml");
        assert_eq!(p.max_steps, 7);
    }

    #[test]
    fn json_fallback_when_toml_missing() {
        let missing = scratch("w192-missing.toml");
        let _ = std::fs::remove_file(&missing);
        let json_path = write_profile("w192-only.json", r#"{"model":"from-json","max_steps":5}"#);
        let p = resolve_profile(None, false, &missing, &json_path).unwrap();
        let _ = std::fs::remove_file(&json_path);
        assert_eq!(p.model, "from-json");
        assert_eq!(p.max_steps, 5);
    }

    #[test]
    fn both_configs_missing_returns_defaults() {
        let missing_toml = scratch("w192-a.toml");
        let missing_json = scratch("w192-b.json");
        let _ = std::fs::remove_file(&missing_toml);
        let _ = std::fs::remove_file(&missing_json);
        let p = resolve_profile(None, false, &missing_toml, &missing_json).unwrap();
        assert_eq!(p, Profile::default());
    }

    #[test]
    fn invalid_toml_is_an_error() {
        let path = write_profile("w192-bad.toml", "model = [unclosed");
        let err = load_profile(&path, false).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.to_string().contains("invalid TOML"));
    }

    #[test]
    fn toml_strict_rejects_unknown_key() {
        let toml = r#"model = "m"
bogus = 1
"#;
        let path = write_profile("w192-strict.toml", toml);
        let err = load_profile(&path, true).unwrap_err();
        let _ = std::fs::remove_file(&path);
        assert!(err.to_string().contains("unknown profile key 'bogus'"));
    }

    // ---- api key 3-path precedence -------------------------------------------
    #[test]
    fn env_key_has_priority_over_api_key_file() {
        let key_env = "W192_TEST_KEY_ENV";
        std::env::set_var(key_env, "sk-from-env");
        let key_file = scratch("w192-key.txt");
        std::fs::write(&key_file, "sk-from-file\n").unwrap();
        let profile = Profile {
            api_key_env: key_env.into(),
            api_key_file: Some(key_file.to_string_lossy().into_owned()),
            ..Profile::default()
        };
        assert_eq!(resolve_api_key(&profile).unwrap(), "sk-from-env");
        std::env::remove_var(key_env);
        let _ = std::fs::remove_file(&key_file);
    }

    #[test]
    fn api_key_file_read_and_trimmed() {
        let key_env = "W192_TEST_KEY_FILE_ONLY";
        std::env::remove_var(key_env);
        let key_file = scratch("w192-key2.txt");
        std::fs::write(&key_file, "  sk-from-file-with-whitespace  \n").unwrap();
        let profile = Profile {
            api_key_env: key_env.into(),
            api_key_file: Some(key_file.to_string_lossy().into_owned()),
            ..Profile::default()
        };
        assert_eq!(
            resolve_api_key(&profile).unwrap(),
            "sk-from-file-with-whitespace"
        );
        let _ = std::fs::remove_file(&key_file);
    }

    #[test]
    fn missing_api_key_is_an_error() {
        let key_env = "W192_TEST_KEY_MISSING";
        std::env::remove_var(key_env);
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let err = resolve_api_key(&profile).unwrap_err();
        assert!(err.to_string().contains(key_env));
    }

    #[test]
    fn missing_api_key_file_is_an_error() {
        let key_env = "W192_TEST_KEY_NOFILE";
        std::env::remove_var(key_env);
        let profile = Profile {
            api_key_env: key_env.into(),
            api_key_file: Some(scratch("w192-no-such-key.txt").to_string_lossy().into_owned()),
            ..Profile::default()
        };
        let err = resolve_api_key(&profile).unwrap_err();
        assert!(err.to_string().contains("cannot read api_key_file"));
    }

    #[test]
    fn strict_accepts_api_key_file() {
        let p = merge_profile_strict(&json!({ "api_key_file": "/tmp/k.txt" })).unwrap();
        assert_eq!(p.api_key_file.as_deref(), Some("/tmp/k.txt"));
    }

    #[test]
    fn strict_rejects_wrong_api_key_file_type() {
        let err = merge_profile_strict(&json!({ "api_key_file": 5 })).unwrap_err();
        assert!(err.to_string().contains("api_key_file"));
    }

    // ---- dotenv ---------------------------------------------------------------
    #[test]
    fn dotenv_loads_existing_file() {
        let key = "W192_DOTENV_LOADED";
        std::env::remove_var(key);
        let env_path = scratch("w192-dotenv.env");
        std::fs::write(&env_path, format!("{key}=sk-dotenv\n")).unwrap();
        assert!(load_dotenv_at(&env_path));
        assert_eq!(std::env::var(key).ok().as_deref(), Some("sk-dotenv"));
        std::env::remove_var(key);
        let _ = std::fs::remove_file(&env_path);
    }

    #[test]
    fn dotenv_missing_is_silent() {
        let missing = scratch("w192-no-dotenv.env");
        let _ = std::fs::remove_file(&missing);
        assert!(!load_dotenv_at(&missing));
    }
    // ---- W220: context-trim profile keys -----------------------------------
    #[test]
    fn context_keys_parse_lenient() {
        let p = merge_profile(&json!({
            "context_window_tokens": 131072,
            "context_trim_threshold": 0.9,
            "context_keep_recent": 6
        }))
        .unwrap();
        assert_eq!(p.context_window_tokens, 131072);
        assert_eq!(p.context_trim_threshold, 0.9);
        assert_eq!(p.context_keep_recent, 6);
    }

    #[test]
    fn context_keys_defaults() {
        let p = Profile::default();
        assert_eq!(p.context_window_tokens, 65_536);
        assert_eq!(p.context_trim_threshold, 0.8);
        assert_eq!(p.context_keep_recent, 10);
    }

    #[test]
    fn context_keys_zero_disables_trimming() {
        let p = merge_profile(&json!({ "context_window_tokens": 0 })).unwrap();
        assert_eq!(p.context_window_tokens, 0);
    }

    #[test]
    fn strict_rejects_bad_context_key_types() {
        assert!(merge_profile_strict(&json!({ "context_window_tokens": "many" })).is_err());
        assert!(merge_profile_strict(&json!({ "context_trim_threshold": 1.5 })).is_err());
        assert!(merge_profile_strict(&json!({ "context_trim_threshold": "high" })).is_err());
        assert!(merge_profile_strict(&json!({ "context_keep_recent": -1 })).is_err());
    }

    #[test]
    fn lenient_ignores_bad_context_keys() {
        let p = merge_profile(&json!({
            "context_window_tokens": "many",
            "context_trim_threshold": 7,
            "context_keep_recent": true
        }))
        .unwrap();
        assert_eq!(p.context_window_tokens, Profile::default().context_window_tokens);
        assert_eq!(p.context_trim_threshold, Profile::default().context_trim_threshold);
        assert_eq!(p.context_keep_recent, Profile::default().context_keep_recent);
    }

    #[test]
    fn strict_accepts_context_keys() {
        let p = merge_profile_strict(&json!({
            "context_window_tokens": 4096,
            "context_trim_threshold": 0.75,
            "context_keep_recent": 4
        }))
        .unwrap();
        assert_eq!(p.context_window_tokens, 4096);
        assert_eq!(p.context_trim_threshold, 0.75);
        assert_eq!(p.context_keep_recent, 4);
    }
}
