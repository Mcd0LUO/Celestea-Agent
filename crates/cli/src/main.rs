//! celestea-cli — entry point, compose, profile loading, chat/run/tools (W105/W176/W182).
//!
//! Parses --profile (a TOML file, with legacy JSON fallback), builds the shared
//! celestea_core::Context,
//! plugs in the concrete providers (DeepSeek llm, in-memory session, tool
//! registry, default agent loop) as the *Service newtypes, then runs one of:
//!
//! - `chat` (default): interactive REPL on a terminal stdin, backed by
//!   rustyline (history / line editing / Ctrl-C / Ctrl-D); when stdin is NOT
//!   a terminal (piped/redirected) it reads all of stdin as one turn instead.
//! - `run -e|--input <text> [--json]`: one-shot — run a single turn and exit;
//!   without --input it reads all of stdin. `--json` emits a structured
//!   {turn, assistant_text, tool_calls, results, error?} document.
//! - `tools`: list the built-in tool names + descriptions (no LLM needed).
//!
//! Exit-code contract: 0 success; 1 configuration/init error; 2 turn execution
//! error; 3 runtime I/O or internal error. See --help for precedence rules.

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use celestea_agent_loop::{DefaultAgentLoop, EventSink, LoopEvent};
use celestea_core::{
    AgentConfig, AgentError, AgentLoop, AgentLoopService, Context, LlmRegistryService,
    LlmService, SessionEvent, SessionLog, SessionService, ToolDecision, ToolOutput,
    ToolRegistry, ToolRegistryService, ToolSpec,
};
use celestea_llm::{deepseek_registry, DeepSeekConfig, DeepSeekLlm, ReasoningEffort};
use celestea_session::InMemorySessionLog;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use clap::{Parser, Subcommand};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

// ============================================================================
// CLI args + help
// ============================================================================

/// Command-line arguments for the celestea agent.
#[derive(Debug, Parser)]
#[command(
    name = "celestea",
    version,
    about = "celestea_harness agent CLI (chat / run / tools)",
    long_about = "celestea_harness agent CLI: compose a Context from a TOML/JSON profile, then run \
                  a chat REPL, a one-shot run, or list the built-in tools.\n\
                  \n\
                  COMMANDS:\n\
                    chat   Interactive REPL (default). On a terminal stdin it uses rustyline\n\
                           (history / line editing / Ctrl-C / Ctrl-D); when stdin is piped or\n\
                           redirected it reads ALL of stdin as one user turn instead.\n\
                    run    One-shot: run a single user turn and exit. Input from -e/--input,\n\
                           or all of stdin when --input is absent. --json emits a structured\n\
                           {turn, assistant_text, tool_calls, results, error?} document.\n\
                    tools  List the built-in tool names and descriptions (no model needed).\n\
                  \n\
                  INPUT PRIORITY: -e/--input wins over piped stdin; piped stdin (non-terminal)\n\
                  is one-shot regardless of subcommand; an interactive terminal stdin without\n\
                  --input means chat REPL.\n\
                  \n\
                  REPL: blank lines are skipped; exit/quit (or /exit) end the session; a\n\
                  leading / invokes a command (/tools /model /clear /profile /exit).\n\
                  \n\
                  EXIT CODES: 0 success; 1 configuration/init error; 2 turn execution error;\n\
                  3 runtime I/O or internal error. In the REPL, any failing turn sets the code\n\
                  to 2, and EOF returns the accumulated code."
)]
struct Args {
    /// Path to the config file (TOML or legacy JSON). Default: auto-discover
    /// `celestea.toml`, then fall back to `profile.json`, then defaults.
    #[arg(long, global = true)]
    profile: Option<PathBuf>,

    /// Reject unknown / wrong-type profile fields instead of leniently
    /// falling back to defaults (backwards compatible default: lenient).
    #[arg(long, global = true)]
    strict: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Interactive REPL (default). Reads all of stdin as one turn when piped.
    Chat,
    /// Run a single user turn and exit (one-shot).
    Run {
        /// Input text for the one-shot turn.
        #[arg(short = 'e', long = "input")]
        input: Option<String>,
        /// Emit the one-shot result as structured JSON
        /// ({turn, assistant_text, tool_calls, results, error?}).
        #[arg(long)]
        json: bool,
    },
    /// List built-in tools (name + description).
    Tools,
}

// ============================================================================
// Exit-code contract
// ============================================================================

/// Process exit codes: 0 success; 1 configuration/init error; 2 turn execution
/// error; 3 runtime I/O or internal error; 130 interrupted (Ctrl-C, the
/// conventional 128+SIGINT code — used for one-shot turns and REPL force-quit).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
enum ExitKind {
    Ok = 0,
    Config = 1,
    Turn = 2,
    Runtime = 3,
    Interrupted = 130,
}

impl ExitKind {
    fn code(self) -> i32 {
        self as i32
    }

    /// REPL accumulation: keep the most severe code seen so far.
    fn merge(&mut self, other: ExitKind) {
        if (other as i32) > (*self as i32) {
            *self = other;
        }
    }
}

// ============================================================================
// Profile loading (lenient by default, `--strict` validates)
// ============================================================================

/// Runtime configuration loaded from celestea.toml (or the legacy
/// profile.json, or defaults).
#[derive(Debug, Clone, PartialEq)]
struct Profile {
    model: String,
    system_prompt: String,
    max_steps: usize,
    max_parallel_tool_calls: usize,
    /// Optional API base URL; falls back to env DEEPSEEK_BASE_URL, then the
    /// provider default. The token value itself NEVER lives here (env only).
    base_url: Option<String>,
    /// Optional reasoning effort for reasoning models.
    reasoning_effort: Option<ReasoningEffort>,
    /// Optional output-token cap.
    max_output_tokens: Option<u32>,
    /// Env var that holds the API key (default DEEPSEEK_API_KEY).
    api_key_env: String,
    /// Optional path to a file whose trimmed contents hold the API key
    /// (second priority behind env[api_key_env]; the key value itself is
    /// never stored here).
    api_key_file: Option<String>,
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
const PROFILE_KEYS: [&str; 9] = [
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
fn merge_profile(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, false)
}

/// Strict merge: unknown keys and wrong-type fields are hard errors.
#[cfg(test)]
fn merge_profile_strict(json: &Value) -> Result<Profile> {
    merge_profile_mode(json, true)
}

fn merge_profile_mode(json: &Value, strict: bool) -> Result<Profile> {
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
const DEFAULT_CONFIG: &str = "celestea.toml";
/// Legacy JSON config file name, used as a fallback for backwards
/// compatibility with the pre-TOML profile.json.
const LEGACY_CONFIG: &str = "profile.json";

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
fn load_profile(path: &Path, strict: bool) -> Result<Profile> {
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

fn resolve_profile(
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

// ============================================================================
// REPL command surface
// ============================================================================

/// A leading-`/` command in the REPL.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplCommand {
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
fn parse_repl_command(line: &str) -> Option<ReplCommand> {
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

/// Human-readable listing of the registered tools (name + description).
fn format_tool_list(specs: &[ToolSpec]) -> String {
    let mut out = String::new();
    for spec in specs {
        out.push_str(&format!("{:<18} {}\n", spec.name, spec.description));
    }
    out
}

/// Human-readable rendering of the active profile.
fn format_profile(profile: &Profile) -> String {
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
struct TurnSummary {
    turn: String,
    assistant_text: String,
    tool_calls: Vec<ToolCallRec>,
    results: Vec<ToolResultRec>,
}

#[derive(Debug, Clone, PartialEq)]
struct ToolCallRec {
    id: String,
    name: String,
    args: Value,
}

#[derive(Debug, Clone, PartialEq)]
struct ToolResultRec {
    id: String,
    value: Option<Value>,
    error: Option<String>,
}

impl TurnSummary {
    /// Render as the `--json` document: {turn, assistant_text, tool_calls,
    /// results, error?}.
    fn to_json(&self, error: Option<&str>) -> Value {
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
fn summarize_turn(events: &[SessionEvent]) -> TurnSummary {
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

// ============================================================================
// Best-effort stdout redirection for clean --json output
// ============================================================================

/// Temporarily divert process stdout so the `--json` document is the only
/// thing on stdout: streaming deltas printed by the agent loop (and any
/// tracing output) land in a scratch file while the silencer is alive.
#[cfg(unix)]
mod stdout_redirect {
    use std::fs::File;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    unsafe extern "C" {
        fn dup(oldfd: i32) -> i32;
        fn dup2(oldfd: i32, newfd: i32) -> i32;
    }

    pub struct Silencer {
        saved: i32,
        scratch: PathBuf,
    }

    impl Silencer {
        /// Create a silencer, or None when it could not be set up (the caller
        /// then runs without silencing — best effort only).
        pub fn new() -> Option<Self> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let scratch = std::env::temp_dir()
                .join(format!("celestea-cli-{}-{}.out", std::process::id(), nanos));
            let file = File::create(&scratch).ok()?;
            let saved = unsafe { dup(1) };
            if saved < 0 {
                let _ = std::fs::remove_file(&scratch);
                return None;
            }
            if unsafe { dup2(file.as_raw_fd(), 1) } < 0 {
                let _ = std::fs::remove_file(&scratch);
                return None;
            }
            Some(Self { saved, scratch })
        }
    }

    impl Drop for Silencer {
        fn drop(&mut self) {
            unsafe {
                let _ = dup2(self.saved, 1); // restore stdout
                let _ = File::from_raw_fd(self.saved); // close the saved fd
            }
            let _ = std::fs::remove_file(&self.scratch);
        }
    }

    pub fn silencer() -> Option<Silencer> {
        Silencer::new()
    }
}

#[cfg(not(unix))]
mod stdout_redirect {
    pub struct Silencer;
    pub fn silencer() -> Option<Silencer> {
        None
    }
}

// ============================================================================
// Rich rendering (P1): incremental markdown, syntect code highlight, thinking
// blocks and tool cards. Only used in interactive chat / non-json runs on a
// TTY; --json and piped output stay plain/structured.
// ============================================================================

mod rich {
    use super::*;

    /// True-color / style ANSI codes used throughout the renderer.
    const RESET: &str = "\x1b[0m";
    const BOLD: &str = "\x1b[1m";
    const DIM: &str = "\x1b[2m";
    const ITALIC: &str = "\x1b[3m";
    const UNDERLINE: &str = "\x1b[4m";
    const REVERSE: &str = "\x1b[7m";
    const RED: &str = "\x1b[31m";
    const GREEN: &str = "\x1b[32m";
    const YELLOW: &str = "\x1b[33m";
    const CYAN: &str = "\x1b[36m";

    /// Shared syntect syntax set + theme. Building is expensive (a second or
    /// two), so it is created once and reused, lazily, only when rich rendering
    /// first needs to highlight a code block.
    pub(crate) struct Highlighter {
        syntaxes: syntect::parsing::SyntaxSet,
        theme: syntect::highlighting::Theme,
    }

    impl Highlighter {
        fn new() -> Self {
            let syntaxes = syntect::parsing::SyntaxSet::load_defaults_newlines();
            let mut themes = syntect::highlighting::ThemeSet::load_defaults();
            let theme = themes
                .themes
                .remove("base16-ocean.dark")
                .or_else(|| themes.themes.into_values().next())
                .expect("syntect ships default themes");
            Self { syntaxes, theme }
        }

        /// Highlight `code` with syntect, returning true-color terminal escapes.
        /// Falls back to the plain-text syntax when `lang` is unknown/absent.
        fn highlight(&self, code: &str, lang: Option<&str>) -> String {
            use syntect::easy::HighlightLines;
            use syntect::util::{as_24_bit_terminal_escaped, LinesWithEndings};
            let syntax = lang
                .and_then(|l| self.syntaxes.find_syntax_by_token(l))
                .or_else(|| self.syntaxes.find_syntax_by_extension("rs"))
                .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
            let mut h = HighlightLines::new(syntax, &self.theme);
            let mut out = String::new();
            for line in LinesWithEndings::from(code) {
                match h.highlight_line(line, &self.syntaxes) {
                    Ok(ranges) => out.push_str(&as_24_bit_terminal_escaped(&ranges, false)),
                    Err(_) => out.push_str(line),
                }
            }
            out
        }
    }

    /// One shared Highlighter across all rich sessions (built once, lazily).
    pub(crate) fn highlighter() -> Arc<Highlighter> {
        use std::sync::OnceLock;
        static HL: OnceLock<Arc<Highlighter>> = OnceLock::new();
        HL.get_or_init(|| Arc::new(Highlighter::new())).clone()
    }

    /// Render inline markdown (bold / italic / strikethrough / inline code /
    /// links) to ANSI. Pure and unit-testable.
    fn inline_ansi(line: &str) -> String {
        use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
        let parser = Parser::new_ext(line, Options::ENABLE_STRIKETHROUGH);
        let mut out = String::new();
        for ev in parser {
            match ev {
                Event::Start(tag) => match tag {
                    Tag::Strong => out.push_str(BOLD),
                    Tag::Emphasis => out.push_str(ITALIC),
                    Tag::Strikethrough => out.push_str(DIM),
                    Tag::Link { .. } => out.push_str(UNDERLINE),
                    _ => {}
                },
                Event::End(tag) => match tag {
                    TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link => {
                        out.push_str(RESET)
                    }
                    _ => {}
                },
                Event::Text(t) => out.push_str(&t),
                Event::Code(t) => {
                    out.push_str(REVERSE);
                    out.push_str(&t);
                    out.push_str(RESET);
                }
                Event::SoftBreak | Event::HardBreak => out.push('\n'),
                _ => {}
            }
        }
        out
    }

    /// Stateful, incremental markdown renderer. Feed text chunks and it returns
    /// the ANSI for every *complete* line; a partial tail is held until
    /// `finish`. Block state (fenced code, table, pending paragraph) is tracked
    /// across lines so code blocks and table headers render correctly when
    /// streamed.
pub(crate) struct StreamingMarkdown {
        hl: Option<Arc<Highlighter>>,
        /// Open fenced code block: (language, accumulated code lines).
        code: Option<(Option<String>, Vec<String>)>,
        /// True once a table separator has been seen (following rows are data).
        in_table: bool,
        /// A buffered table-candidate line (waits to see if a separator follows).
        pending: Option<String>,
        /// Partial current line (no trailing newline yet).
        tail: String,
    }

    impl StreamingMarkdown {
        pub(crate) fn new(hl: Option<Arc<Highlighter>>) -> Self {
            Self {
                hl,
                code: None,
                in_table: false,
                pending: None,
                tail: String::new(),
            }
        }

        /// Feed a chunk; returns the ANSI for lines that completed inside it.
        pub(crate) fn feed(&mut self, chunk: &str) -> String {
            let mut out = String::new();
            self.tail.push_str(chunk);
            while let Some(pos) = self.tail.find('\n') {
                let line = self.tail[..pos].to_string();
                self.tail.drain(..pos + 1);
                self.render_line(&line, &mut out);
            }
            out
        }

        /// Flush the partial tail, the pending line and any open code block.
        pub(crate) fn finish(&mut self) -> String {
            let mut out = String::new();
            if !self.tail.is_empty() {
                let line = std::mem::take(&mut self.tail);
                self.render_line(&line, &mut out);
            }
            self.flush_pending(&mut out);
            if let Some((lang, lines)) = self.code.take() {
                out.push_str(&highlight_code(
                    &lines.join("\n"),
                    lang.as_deref(),
                    self.hl.as_deref(),
                ));
                out.push('\n');
            }
            out
        }

        fn flush_pending(&mut self, out: &mut String) {
            if let Some(p) = self.pending.take() {
                out.push_str(&table_row_ansi(&p));
                out.push('\n');
            }
        }

        fn render_line(&mut self, line: &str, out: &mut String) {
            if self.code.is_some() {
                self.code_line(line, out);
                return;
            }
            let trimmed = line.trim();
            if let Some(lang) = fence_lang(trimmed) {
                self.flush_pending(out);
                self.in_table = false;
                self.code = Some((lang, Vec::new()));
                return;
            }
            if trimmed.is_empty() {
                self.flush_pending(out);
                self.in_table = false;
                out.push('\n');
                return;
            }
            if let Some((level, rest)) = atx_heading(line) {
                self.flush_pending(out);
                self.in_table = false;
                out.push_str(&heading_ansi(level, rest));
                out.push('\n');
                return;
            }
            if is_table_separator(trimmed) {
                if let Some(p) = self.pending.take() {
                    out.push_str(&table_header_ansi(&p));
                    out.push('\n');
                } else {
                    out.push_str(&format!("{DIM}{trimmed}{RESET}\n"));
                }
                out.push_str(&format!("{DIM}{trimmed}{RESET}\n"));
                self.in_table = true;
                return;
            }
            if self.in_table && line.contains('|') {
                self.flush_pending(out);
                out.push_str(&table_row_ansi(line));
                out.push('\n');
                return;
            }
            if line.contains('|') {
                self.flush_pending(out);
                self.pending = Some(line.to_string());
                return;
            }
            self.in_table = false;
            if let Some(rest) = trimmed.strip_prefix('>') {
                self.flush_pending(out);
                out.push_str(&format!("{DIM}│ {}{RESET}\n", inline_ansi(rest)));
                return;
            }
            if let Some((marker, rest)) = ul_item(trimmed) {
                self.flush_pending(out);
                out.push_str(&format!("{BOLD}{marker}{RESET} {}\n", inline_ansi(rest)));
                return;
            }
            if let Some((num, rest)) = ol_item(trimmed) {
                self.flush_pending(out);
                out.push_str(&format!("{BOLD}{num}.{RESET} {}\n", inline_ansi(rest)));
                return;
            }
            if line.starts_with("    ") || line.starts_with('\t') {
                self.flush_pending(out);
                out.push_str(&format!("{DIM}{}{RESET}\n", line.trim()));
                return;
            }
            self.flush_pending(out);
            out.push_str(&inline_ansi(line));
            out.push('\n');
        }

        fn code_line(&mut self, line: &str, out: &mut String) {
            if is_closing_fence(line.trim()) {
                let (lang, lines) = self.code.take().unwrap();
                out.push_str(&highlight_code(
                    &lines.join("\n"),
                    lang.as_deref(),
                    self.hl.as_deref(),
                ));
                out.push('\n');
            } else if let Some((_, lines)) = self.code.as_mut() {
                lines.push(line.to_string());
            }
        }
    }

    /// Render a complete markdown document to ANSI. Pure — used by tests (the
    /// streaming `feed` API is what production callers use).
    #[cfg(test)]
    fn render_markdown_ansi(src: &str, hl: Option<&Arc<Highlighter>>) -> String {
        let mut md = StreamingMarkdown::new(hl.cloned());
        let mut out = md.feed(src);
        out.push_str(&md.finish());
        out
    }

    fn fence_lang(trimmed: &str) -> Option<Option<String>> {
        if let Some(rest) = trimmed.strip_prefix("```") {
            let lang = rest.trim();
            return Some(if lang.is_empty() { None } else { Some(lang.to_string()) });
        }
        if let Some(rest) = trimmed.strip_prefix("~~~") {
            let lang = rest.trim();
            return Some(if lang.is_empty() { None } else { Some(lang.to_string()) });
        }
        None
    }

    fn is_closing_fence(trimmed: &str) -> bool {
        let t = trimmed.trim_end();
        if let Some(rest) = t.strip_prefix("```") {
            return rest.trim().is_empty();
        }
        if let Some(rest) = t.strip_prefix("~~~") {
            return rest.trim().is_empty();
        }
        false
    }

    fn atx_heading(line: &str) -> Option<(usize, &str)> {
        let t = line.trim_start();
        let mut level = 0usize;
        for c in t.chars() {
            if c == '#' {
                level += 1;
            } else {
                break;
            }
        }
        if level == 0 || level > 6 {
            return None;
        }
        let rest = &t[level..];
        if !rest.starts_with(' ') {
            return None;
        }
        Some((level, rest.trim()))
    }

    fn heading_ansi(level: usize, rest: &str) -> String {
        let code = match level {
            1 => "\x1b[1;36m",
            2 => "\x1b[1;34m",
            _ => "\x1b[1;33m",
        };
        format!("{code}{}{RESET}", inline_ansi(rest))
    }

    fn is_table_separator(trimmed: &str) -> bool {
        trimmed.contains('-')
            && trimmed.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
    }

    fn table_row_ansi(line: &str) -> String {
        let cells: Vec<&str> =
            line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        let mut out = String::new();
        out.push_str("│ ");
        for (i, cell) in cells.iter().enumerate() {
            if i > 0 {
                out.push_str(" │ ");
            }
            out.push_str(&inline_ansi(cell));
        }
        out.push_str(" │");
        out
    }

    fn table_header_ansi(line: &str) -> String {
        let cells: Vec<&str> =
            line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        let mut out = String::new();
        out.push_str("│ ");
        for (i, cell) in cells.iter().enumerate() {
            if i > 0 {
                out.push_str(" │ ");
            }
            out.push_str(&format!("{BOLD}{}{RESET}", inline_ansi(cell)));
        }
        out.push_str(" │");
        out
    }

    fn ul_item(trimmed: &str) -> Option<(&'static str, &str)> {
        for marker in ["- ", "* ", "+ "] {
            if let Some(rest) = trimmed.strip_prefix(marker) {
                return Some(("•", rest.trim()));
            }
        }
        None
    }

    fn ol_item(trimmed: &str) -> Option<(String, &str)> {
        let bytes = trimmed.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > 0 && bytes.get(i) == Some(&b'.') && bytes.get(i + 1) == Some(&b' ') {
            Some((trimmed[..i].to_string(), trimmed[i + 2..].trim()))
        } else {
            None
        }
    }

    fn highlight_code(code: &str, lang: Option<&str>, hl: Option<&Highlighter>) -> String {
        match hl {
            Some(hl) => hl.highlight(code, lang),
            None => {
                let mut out = String::new();
                for line in code.lines() {
                    out.push_str(&format!("{DIM}{line}{RESET}\n"));
                }
                out
            }
        }
    }

    /// A single thinking line: faint [thinking] prefix + indent (a visually
    /// collapsible-looking block; full fold/unfold is deferred).
pub(crate) fn render_thinking_line(line: &str) -> String {
        format!("{DIM}  [thinking] {line}{RESET}\n")
    }

pub(crate) fn render_tool_call_card(id: &str, name: &str, args: &Value) -> String {
        format!(
            "{CYAN}⚙ {BOLD}{name}{RESET} [{id}]{RESET} {CYAN}运行中…{RESET}\n  args: {}\n",
            args
        )
    }

pub(crate) fn render_tool_result_card(name: &str, out: &ToolOutput) -> String {
        let (status, color) = match (&out.decision, &out.error) {
            (Some(ToolDecision::Deny(reason)), _) => (format!("deny: {reason}"), YELLOW),
            (Some(ToolDecision::Ask(reason)), _) => (format!("ask: {reason}"), YELLOW),
            (_, Some(e)) => (format!("error: {e}"), RED),
            (_, None) => ("成功".to_string(), GREEN),
        };
        let body = out
            .render
            .clone()
            .or_else(|| out.value.as_ref().map(|v| v.to_string()))
            .unwrap_or_default();
        let mut s = format!(
            "{color}⚙ {BOLD}{name}{RESET} [{}]{RESET} {color}{status}{RESET}\n",
            out.call_id
        );
        for line in body.lines() {
            if !line.trim().is_empty() {
                s.push_str(&format!("  {line}\n"));
            }
        }
        s
    }

    /// Mutable state shared between the event sink (called from run_turn) and
    /// the interrupt handler (flush on cancel).
    struct RenderState {
        hl: Option<Arc<Highlighter>>,
        md: StreamingMarkdown,
        thinking_tail: String,
        tool_names: std::collections::HashMap<String, String>,
    }

    impl RenderState {
        fn new(hl: Option<Arc<Highlighter>>) -> Self {
            Self {
                hl: hl.clone(),
                md: StreamingMarkdown::new(hl),
                thinking_tail: String::new(),
                tool_names: std::collections::HashMap::new(),
            }
        }
        fn reset(&mut self) {
            self.md = StreamingMarkdown::new(self.hl.clone());
            self.thinking_tail.clear();
            self.tool_names.clear();
        }
    }

    fn write_stdout(s: &str) {
        let mut w = std::io::stdout();
        let _ = w.write_all(s.as_bytes());
        let _ = w.flush();
    }

    /// The rich rendering sink: an EventSink that styles stream events,
    /// thinking and tool cards for a terminal. Owned by Env.renderer; the sink
    /// closure is handed to DefaultAgentLoop so every LoopEvent is rendered.
    pub struct RichRenderer {
        pub sink: EventSink,
        state: Arc<Mutex<RenderState>>,
    }

    impl RichRenderer {
        pub fn new() -> Self {
            let hl = Some(highlighter());
            let state = Arc::new(Mutex::new(RenderState::new(hl)));
            let sink = {
                let state = state.clone();
                Arc::new(move |ev: LoopEvent| {
                    let mut st = state.lock().unwrap();
                    let mut out = String::new();
                    match ev {
                        LoopEvent::Thinking(delta) => {
                            st.thinking_tail.push_str(&delta);
                            while let Some(pos) = st.thinking_tail.find('\n') {
                                let line = st.thinking_tail[..pos].to_string();
                                st.thinking_tail.drain(..pos + 1);
                                out.push_str(&render_thinking_line(&line));
                            }
                        }
                        LoopEvent::Text(delta) => {
                            out.push_str(&st.md.feed(&delta));
                        }
                        LoopEvent::Done(_msg) => {
                            out.push_str(&st.md.finish());
                            if !st.thinking_tail.is_empty() {
                                let tail = std::mem::take(&mut st.thinking_tail);
                                out.push_str(&render_thinking_line(&tail));
                            }
                        }
                        LoopEvent::ToolCall { id, name, args } => {
                            st.tool_names.insert(id.clone(), name.clone());
                            out.push_str(&render_tool_call_card(&id, &name, &args));
                        }
                        LoopEvent::ToolResult(tr) => {
                            let name = st
                                .tool_names
                                .get(&tr.call_id)
                                .cloned()
                                .unwrap_or_else(|| tr.call_id.clone());
                            out.push_str(&render_tool_result_card(&name, &tr));
                        }
                    }
                    if !out.is_empty() {
                        write_stdout(&out);
                    }
                })
            };
            Self { sink, state }
        }

        /// Flush buffered partial output (used on interrupt so partial output
        /// is kept before printing the interrupt status).
        pub fn flush(&self) {
            let mut st = self.state.lock().unwrap();
            let mut out = st.md.finish();
            if !st.thinking_tail.is_empty() {
                let tail = std::mem::take(&mut st.thinking_tail);
                out.push_str(&render_thinking_line(&tail));
            }
            if !out.is_empty() {
                write_stdout(&out);
            }
        }

        /// Reset per-turn state before a fresh turn.
        pub fn reset(&self) {
            self.state.lock().unwrap().reset();
        }
    }

    /// Best-effort terminal hygiene after an interrupted turn: disable any raw
    /// mode left on, park the cursor at column 0 and clear from there to the
    /// end of the screen so the REPL prompt prints cleanly. The partial output
    /// above is preserved (the renderer flushed it first).
    pub fn restore_after_interrupt() {
        use crossterm::{cursor, terminal, QueueableCommand};
        let _ = terminal::disable_raw_mode();
        let mut w = std::io::stdout();
        let _ = w.queue(cursor::MoveToColumn(0));
        let _ = w.queue(terminal::Clear(terminal::ClearType::FromCursorDown));
        let _ = w.flush();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn md_heading_renders_ansi() {
            let out = render_markdown_ansi("# Title
", None);
            assert!(out.contains("[1;36m"), "h1 bold-cyan missing: {:?}", out);
            assert!(out.contains("Title"));
            assert!(out.contains(RESET));
        }

        #[test]
        fn md_bold_italic_and_inline_code() {
            let out = render_markdown_ansi("**hi** and `code`
", None);
            assert!(out.contains(&format!("{BOLD}hi{RESET}")));
            assert!(out.contains(&format!("{REVERSE}code{RESET}")));
        }

        #[test]
        fn md_list_bullet_and_ordered() {
            let out = render_markdown_ansi("- item
1. step
", None);
            assert!(out.contains("•"));
            assert!(out.contains("1."));
        }

        #[test]
        fn md_fenced_code_plain_without_highlighter() {
            let out = render_markdown_ansi("```rs
let x = 1;
```
", None);
            assert!(out.contains("let x = 1;"));
            assert!(out.contains(DIM));
        }

        #[test]
        fn md_fenced_code_highlights_with_syntect() {
            let hl = Some(highlighter());
            let out = render_markdown_ansi("```rs
fn main() {}
```
", hl.as_ref());
            assert!(out.contains("[38;2;"), "expected syntect true-color escapes");
            // Tokens are wrapped in their own color escapes, so assert on the
            // code tokens separately rather than the contiguous source line.
            assert!(out.contains("fn"));
            assert!(out.contains("main"));
        }

        #[test]
        fn md_table_renders_header_and_rows() {
            let out = render_markdown_ansi("a | b
--- | ---
1 | 2
", None);
            assert!(out.contains("│"));
            assert!(out.contains("a"));
            assert!(out.contains("b"));
        }

        #[test]
        fn thinking_line_has_dim_prefix() {
            let out = render_thinking_line("ponder");
            assert!(out.starts_with(DIM));
            assert!(out.contains("[thinking]"));
            assert!(out.contains("ponder"));
        }

        #[test]
        fn tool_result_card_colors_status() {
            let tr = ToolOutput {
                call_id: "c1".into(),
                value: Some(serde_json::json!("ok")),
                render: Some("done".into()),
                error: None,
                decision: Some(ToolDecision::Allow),
            };
            let ok = render_tool_result_card("ls", &tr);
            assert!(ok.contains(GREEN), "success card should be green");
            let mut err = tr.clone();
            err.error = Some("boom".into());
            let e = render_tool_result_card("ls", &err);
            assert!(e.contains(RED), "error card should be red");
            let mut deny = tr.clone();
            deny.decision = Some(ToolDecision::Deny("no".into()));
            let d = render_tool_result_card("ls", &deny);
            assert!(d.contains(YELLOW), "deny card should be yellow");
        }

        #[test]
        fn streaming_feed_is_incremental_and_flushes() {
            let mut md = StreamingMarkdown::new(None);
            // A partial line is held, not emitted.
            assert_eq!(md.feed("Hello **wo"), "");
            let out = md.feed("rld**
");
            assert!(out.contains("Hello"));
            assert!(out.contains(BOLD));
            // The held tail is flushed by finish().
            md.feed("tail");
            let fin = md.finish();
            assert!(fin.contains("tail"));
        }
    }
}
// ============================================================================
// mod tui - fullscreen ratatui chat (W195). Reuses rich's markdown renderers
// (StreamingMarkdown + thinking/tool card ANSI) and converts the emitted ANSI
// into ratatui spans. Non-TTY / --json stay on the P1 streamed-line renderer.
// ============================================================================
mod tui {
    use super::*;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use crossterm::event::{self, Event as TermEvent, KeyCode, KeyModifiers};
    use ratatui::layout::{Constraint, Layout, Margin, Rect};
    use ratatui::style::{Color, Modifier, Style};
    use ratatui::text::{Line, Span, Text};
    use ratatui::widgets::{Block, Paragraph, Wrap};
    use ratatui::Frame;
    use tokio::sync::{mpsc, watch};

    /// Min redraw interval when stream events are trickling in (throttle).
    const DRAW_INTERVAL: Duration = Duration::from_millis(20);
    /// Blank pad line(s) inserted after each finished turn.
    const TURN_GAP: usize = 1;


    // ------------------------------------------------------------------------
    // Pure, unit-testable helpers
    // ------------------------------------------------------------------------

    /// Split a chunk of ANSI text (each line terminated by newline) into
    /// individual ANSI line strings (newline stripped). Pushes into the output
    /// Vec, returns how many were pushed. A tail without newline is pushed too.
    pub(crate) fn split_ansi_lines(ansi: &str, out: &mut Vec<String>) -> usize {
        let mut start = 0usize;
        let mut pushed = 0usize;
        let bytes = ansi.as_bytes();
        for i in 0..bytes.len() {
            if bytes[i] == b'\n' {
                out.push(ansi[start..i].to_string());
                pushed += 1;
                start = i + 1;
            }
        }
        if start < bytes.len() {
            out.push(ansi[start..].to_string());
            pushed += 1;
        }
        pushed
    }

    /// The buffer that accumulates one streaming assistant message. It owns the
    /// incremental markdown streamer plus the ANSI lines completed so far.
    pub(crate) struct MessageBuf {
        pub lines: Vec<String>,
        pub finished: bool,
    }

    impl MessageBuf {
        pub fn new() -> Self {
            Self { lines: Vec::new(), finished: false }
        }
        /// Feed a text delta through the rich streamer; returns how many lines
        /// completed in this chunk (0 while a line is still partial).
        pub fn push_stream(&mut self, md: &mut rich::StreamingMarkdown, delta: &str) -> usize {
            if self.finished {
                return 0;
            }
            split_ansi_lines(&md.feed(delta), &mut self.lines)
        }
        /// Flush the partial tail / open code block; returns lines appended.
        pub fn finish_stream(&mut self, md: &mut rich::StreamingMarkdown) -> usize {
            if self.finished {
                return 0;
            }
            let n = split_ansi_lines(&md.finish(), &mut self.lines);
            self.finished = true;
            n
        }
        #[allow(dead_code)] // kept for unit tests
        pub fn is_finished(&self) -> bool {
            self.finished
        }
    }

    /// A tool's live status in the right-hand status pane.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) enum ToolStatus {
        Running,
        Success,
        Error(String),
        Denied(String),
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct ToolCard {
        pub id: String,
        pub name: String,
        pub status: ToolStatus,
    }

    impl ToolCard {
        pub fn new_call(id: String, name: String) -> Self {
            Self { id, name, status: ToolStatus::Running }
        }
        /// Resolve a running card from the call's ToolOutput.
        pub fn resolve(&mut self, out: &ToolOutput) {
            match &out.decision {
                Some(ToolDecision::Deny(reason)) | Some(ToolDecision::Ask(reason)) => {
                    self.status = ToolStatus::Denied(reason.clone())
                }
                _ => match &out.error {
                    Some(e) => self.status = ToolStatus::Error(e.clone()),
                    None => self.status = ToolStatus::Success,
                },
            }
        }
    }

    /// Dispatch decision for the chat subcommand. Pure - unit tested.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum ChatMode {
        /// stdout is a terminal: fullscreen ratatui TUI.
        Tui,
        /// stdout not a terminal but stdin interactive: legacy rustyline REPL.
        Repl,
        /// stdin non-terminal: read all of stdin as one shot (P1 back-compat).
        OneShot,
    }

    /// Choose the chat interaction based on stdin/stdout terminal-ness.
    pub(crate) fn chat_mode(stdin_tty: bool, stdout_tty: bool) -> ChatMode {
        if !stdin_tty {
            ChatMode::OneShot
        } else if stdout_tty {
            ChatMode::Tui
        } else {
            ChatMode::Repl
        }
    }

    /// Horizontal pane split: left (conversation) vs right (tools/status).
    /// No right pane on narrow terminals. Pure - unit tested.
    pub(crate) fn split_widths(total: u16) -> (u16, u16) {
        if total < 40 {
            return (total, 0);
        }
        let left = ((total as f32) * 0.62) as u16;
        (left, total - left)
    }

    /// Pure throttle gate: redraw only if now is at least interval past the
    /// last draw (or never drawn). Unit tested.
    pub(crate) fn should_redraw(last: Option<Instant>, now: Instant, interval: Duration) -> bool {
        match last {
            None => true,
            Some(t) => now.duration_since(t) >= interval,
        }
    }


    /// Convert one rich ANSI-styled line into a ratatui Line of styled spans.
    /// Parses the SGR codes the rich module emits (bold/dim/italic/underline/
    /// reverse, 16-colour, indexed 256, true-colour). Pure - unit tested.
    fn ansi_line_to_spans(line: &str) -> Line<'static> {
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut style = Style::new();
        let mut text = String::new();
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if c == '' && i + 1 < chars.len() && chars[i + 1] == '[' {
                // Reached an SGR code: flush the pending text with the style it
                // was accrued under, then apply the new attributes.
                if !text.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut text), style));
                }
                let mut j = i + 2;
                while j < chars.len() && chars[j] != 'm' && chars[j] != 'n' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == 'm' {
                    let seq: String = chars[i + 2..j].iter().collect();
                    style = apply_sgr(style, &seq);
                    i = j + 1;
                } else {
                    i += 1;
                }
                continue;
            }
            text.push(c);
            i += 1;
        }
        if !text.is_empty() {
            spans.push(Span::styled(text, style));
        }
        Line::from(spans)
    }

    /// Apply one SGR parameter list (digits split by ';') to a Style.
    fn apply_sgr(mut style: Style, seq: &str) -> Style {
        let params: Vec<u8> = seq
            .split(';')
            .filter_map(|p| p.trim().parse::<u8>().ok())
            .collect();
        let mut i = 0usize;
        while i < params.len() {
            match params[i] {
                0 => style = Style::new(),
                1 => style.add_modifier = style.add_modifier | Modifier::BOLD,
                2 => style.add_modifier = style.add_modifier | Modifier::DIM,
                3 => style.add_modifier = style.add_modifier | Modifier::ITALIC,
                4 => style.add_modifier = style.add_modifier | Modifier::UNDERLINED,
                7 => style.add_modifier = style.add_modifier | Modifier::REVERSED,
                30..=37 => {
                    let color = match params[i] {
                        30 => Color::Black,
                        31 => Color::Red,
                        32 => Color::Green,
                        33 => Color::Yellow,
                        34 => Color::Blue,
                        35 => Color::Magenta,
                        36 => Color::Cyan,
                        _ => Color::Gray,
                    };
                    style = style.fg(color);
                }
                38 => {
                    i += 1;
                    if i < params.len() && params[i] == 5 && i + 1 < params.len() {
                        style = style.fg(Color::Indexed(params[i + 1]));
                        i += 2;
                        continue;
                    }
                    if i < params.len() && params[i] == 2 && i + 3 < params.len() {
                        style = style.fg(Color::Rgb(params[i + 1], params[i + 2], params[i + 3]));
                        i += 4;
                        continue;
                    }
                    break;
                }
                39 => style = style.fg(Color::Reset),
                _ => {}
            }
            i += 1;
        }
        style
    }


    // ------------------------------------------------------------------------
    // Shared state: mutated by the event sink, read each frame
    // ------------------------------------------------------------------------

    pub(crate) struct TuiState {
        pub model: String,
        /// Permanent conversation lines (user / tool / thinking / finished assistant).
        pub conv: Vec<String>,
        /// Live tool cards for the right-hand status pane.
        pub tools: Vec<ToolCard>,
        pub steps: usize,
        pub running: bool,
        pub interrupted: bool,
        pub input: String,
        /// Active streaming assistant buffer + its markdown streamer.
        pub buf: MessageBuf,
        pub md: rich::StreamingMarkdown,
        /// Tail of an incomplete thinking line.
        pub thinking_tail: String,
        pub tool_names: HashMap<String, String>,
    }

    impl TuiState {
        pub fn new(model: String) -> Self {
            Self {
                model,
                conv: Vec::new(),
                tools: Vec::new(),
                steps: 0,
                running: false,
                interrupted: false,
                input: String::new(),
                buf: MessageBuf::new(),
                md: rich::StreamingMarkdown::new(None),
                thinking_tail: String::new(),
                tool_names: HashMap::new(),
            }
        }

        /// Begin a fresh turn: clear per-turn state, mark running.
        pub fn reset_turn(&mut self) {
            self.conv.push(String::from("---"));
            self.tools.clear();
            self.steps = 0;
            self.buf = MessageBuf::new();
            self.md = rich::StreamingMarkdown::new(None);
            self.thinking_tail.clear();
            self.tool_names.clear();
            self.running = true;
            self.interrupted = false;
        }

        /// Feed a thinking delta; completed lines are pushed to conv.
        pub fn push_thinking(&mut self, delta: &str) {
            self.thinking_tail.push_str(delta);
            let mut rendered = Vec::new();
            while let Some(pos) = self.thinking_tail.find('\n') {
                let line = self.thinking_tail[..pos].to_string();
                self.thinking_tail.drain(..pos + 1);
                rendered.push(rich::render_thinking_line(&line));
            }
            for r in rendered {
                split_ansi_lines(&r, &mut self.conv);
            }
        }

        /// Apply one LoopEvent into the shared state. The caller pings the
        /// redraw notifier afterwards.
        pub fn apply_event(&mut self, ev: &LoopEvent) {
            match ev {
                LoopEvent::Text(delta) => {
                    self.buf.push_stream(&mut self.md, delta);
                }
                LoopEvent::Thinking(delta) => self.push_thinking(delta),
                LoopEvent::Done(_msg) => {
                    if !self.buf.finished {
                        self.buf.finish_stream(&mut self.md);
                    }
                    if !self.thinking_tail.is_empty() {
                        let tail = std::mem::take(&mut self.thinking_tail);
                        let r = rich::render_thinking_line(&tail);
                        split_ansi_lines(&r, &mut self.conv);
                    }
                    self.conv.append(&mut self.buf.lines);
                    self.buf.finished = true;
                    self.running = false;
                }
                LoopEvent::ToolCall { id, name, args } => {
                    self.steps += 1;
                    self.tool_names.insert(id.clone(), name.clone());
                    self.tools.push(ToolCard::new_call(id.clone(), name.clone()));
                    let r = rich::render_tool_call_card(id, name, args);
                    split_ansi_lines(&r, &mut self.conv);
                }
                LoopEvent::ToolResult(out) => {
                    let name = self
                        .tool_names
                        .get(&out.call_id)
                        .cloned()
                        .unwrap_or_else(|| out.call_id.clone());
                    if let Some(card) = self.tools.iter_mut().find(|c| c.id == out.call_id) {
                        card.resolve(out);
                    }
                    let r = rich::render_tool_result_card(&name, out);
                    split_ansi_lines(&r, &mut self.conv);
                }
            }
        }
    }


    // ------------------------------------------------------------------------
    // Renderer
    // ------------------------------------------------------------------------

    /// Vertical layout: main area, one-line status bar, three-line input box.
    fn draw(frame: &mut Frame, state: &TuiState, scroll: &mut usize) {
        let area = frame.area();
        let [main, status, input] = Layout::vertical([
            Constraint::Min(0),
            Constraint::Length(1),
            Constraint::Length(3),
        ])
        .areas::<3>(area);
        let (lw, rw) = split_widths(main.width);
        let [left, right] = Layout::horizontal([Constraint::Length(lw), Constraint::Length(rw)])
            .areas::<2>(main);

        draw_conversation(frame, left, state, scroll);
        draw_tools(frame, right, state);
        draw_statusbar(frame, status, state);
        draw_inputbar(frame, input, state);
    }
    fn draw_conversation(frame: &mut Frame, area: Rect, state: &TuiState, scroll: &mut usize) {
        let mut text: Vec<Line<'static>> = Vec::new();
        for line in &state.conv {
            text.push(ansi_line_to_spans(line));
        }
        for line in &state.buf.lines {
            text.push(ansi_line_to_spans(line));
        }

        // Auto-follow the tail unless the user has scrolled up or was interrupted.
        let count = text.len();
        let inner_h = area.height.saturating_sub(2).max(1) as usize;
        let max_scroll = count.saturating_sub(inner_h);
        if !state.interrupted && *scroll == 0 && count > inner_h {
            *scroll = max_scroll;
        }
        if *scroll > max_scroll {
            *scroll = max_scroll;
        }

        let (title, title_color) = if state.running {
            ("● running", Color::Cyan)
        } else {
            ("conversation", Color::Gray)
        };
        let block = Block::bordered()
            .title(title)
            .title_style(Style::new().fg(title_color));
        let para = Paragraph::new(Text::from(text))
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((*scroll as u16, 0));
        frame.render_widget(para, area);
    }

    fn draw_tools(frame: &mut Frame, area: Rect, state: &TuiState) {
        if area.width < 4 {
            return;
        }
        let mut lines: Vec<Line<'static>> = Vec::new();
        for card in &state.tools {
            let (icon, color) = match &card.status {
                ToolStatus::Running => ("⚙", Color::Cyan),
                ToolStatus::Success => ("✓", Color::Green),
                ToolStatus::Error(_) => ("✗", Color::Red),
                ToolStatus::Denied(_) => ("⊘", Color::Yellow),
            };
            let status_txt = match &card.status {
                ToolStatus::Running => String::from("running"),
                ToolStatus::Success => String::from("ok"),
                ToolStatus::Error(e) => format!("err: {e}"),
                ToolStatus::Denied(r) => format!("deny: {r}"),
            };
            lines.push(Line::from(vec![
                Span::styled(format!("{icon} "), Style::new().fg(color)),
                Span::styled(
                    card.name.clone(),
                    Style::new().fg(Color::LightCyan).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!(" [{}]", card.id), Style::new().fg(Color::DarkGray)),
                Span::styled(status_txt, Style::new().fg(color)),
            ]));
            lines.push(Line::raw(""));
        }
        if lines.is_empty() {
            lines.push(Line::styled("no tools yet", Style::new().fg(Color::DarkGray)));
        }
        let block = Block::bordered()
            .title("tools / status")
            .title_style(Style::new().fg(Color::Gray));
        frame.render_widget(Paragraph::new(Text::from(lines)).block(block), area);
    }

    fn draw_statusbar(frame: &mut Frame, area: Rect, state: &TuiState) {
        let mut segs: Vec<Span<'static>> = vec![
            Span::styled(format!("model: {}", state.model), Style::new().fg(Color::Cyan)),
            Span::raw("   "),
            Span::styled(format!("steps: {}", state.steps), Style::new().fg(Color::Gray)),
        ];
        if state.running {
            segs.push(Span::styled("   ● streaming", Style::new().fg(Color::Cyan)));
        }
        if state.interrupted {
            segs.push(Span::styled("   ⏹ 已中断", Style::new().fg(Color::Yellow)));
        }
        frame.render_widget(
            Paragraph::new(Line::from(segs)).style(Style::new().bg(Color::DarkGray)),
            area,
        );
    }

    fn draw_inputbar(frame: &mut Frame, area: Rect, state: &TuiState) {
        let prompt = if state.running {
            " (running: Ctrl-C cancel / Ctrl-Cx2 quit) "
        } else {
            " > "
        };
        let mut segs = vec![
            Span::styled(prompt, Style::new().fg(Color::Cyan)),
            Span::styled(state.input.clone(), Style::new()),
        ];
        if state.running {
            segs.push(Span::styled(" ▌", Style::new().fg(Color::Cyan)));
        }
        let block = Block::bordered().title("input").title_style(Style::new().fg(Color::DarkGray));
        frame.render_widget(Paragraph::new(Line::from(segs)).block(block), area);
        // put the terminal cursor inside the input box after the typed text
        let inner = area.inner(Margin { horizontal: 1, vertical: 1 });
        let x = inner.x + (prompt.chars().count() + state.input.chars().count()) as u16;
        frame.set_cursor_position((x, inner.y));
    }


    // ------------------------------------------------------------------------
    // The fullscreen chat loop
    // ------------------------------------------------------------------------

    /// Build an EventSink that applies every LoopEvent into the shared state
    /// and pings the redraw notifier so the draw loop wakes up.
    fn make_sink(state: Arc<Mutex<TuiState>>, tx: mpsc::UnboundedSender<()>) -> EventSink {
        Arc::new(move |ev: LoopEvent| {
            let mut st = state.lock().unwrap();
            st.apply_event(&ev);
            let _ = tx.send(());
        })
    }

    /// Read the next terminal event asynchronously by running crossterm's
    /// blocking read on a helper thread and forwarding over a tokio mpsc.
    async fn next_term_event() -> Option<TermEvent> {
        let (tx, mut rx) = mpsc::unbounded_channel::<TermEvent>();
        std::thread::spawn(move || loop {
            match event::read() {
                Ok(ev) => {
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        });
        rx.recv().await
    }

    type Backend = ratatui::backend::CrosstermBackend<std::io::Stdout>;
    type Term = ratatui::Terminal<Backend>;


    /// Run one turn in the fullscreen TUI with Ctrl-C integrated into the raw
    /// mode key stream (tokio::signal would not fire in raw mode). First Ctrl-C
    /// cancels gracefully; a second force-quits.
    async fn run_tui_turn(
        env: &Env,
        term: &mut Term,
        state: &Arc<Mutex<TuiState>>,
        input: &str,
    ) -> (Result<(), AgentError>, InterruptKind) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut st = state.lock().unwrap();
            st.reset_turn();
            st.conv.push(format!("You: {input}"));
        }

        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<()>();
        let sink = make_sink(state.clone(), notify_tx);
        let agent = DefaultAgentLoop::with_cancel_sink(env.config.clone(), cancel_rx, sink);
        let turn = agent.run_turn(&env.ctx, input);
        tokio::pin!(turn);

        let mut cancelled = false;
        let mut last_draw: Option<Instant> = None;
        let mut scroll: usize = 0;

        loop {
            // Throttled live redraw so rapid tokens do not overwhelm the term.
            let now = Instant::now();
            if should_redraw(last_draw, now, DRAW_INTERVAL) {
                let st = state.lock().unwrap();
                let _ = term.draw(|f| draw(f, &st, &mut scroll));
                last_draw = Some(now);
            }

            let event = tokio::select! {
                _ = notify_rx.recv() => continue,
                ev = next_term_event() => ev,
                r = &mut turn => {
                    return if cancelled {
                        (r, InterruptKind::Cancelled)
                    } else {
                        (r, InterruptKind::None)
                    };
                }
            };

            if let Some(TermEvent::Key(k)) = event {
                let ctrl_c =
                    k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    if !cancelled {
                        cancelled = true;
                        let _ = cancel_tx.send(true);
                        state.lock().unwrap().interrupted = true;
                    } else {
                        // Second Ctrl-C: force-quit the fullscreen TUI.
                        state.lock().unwrap().interrupted = true;
                        let st = state.lock().unwrap();
                        let _ = term.draw(|f| draw(f, &st, &mut scroll));
                        return (Ok(()), InterruptKind::ForceQuit);
                    }
                }
            }
        }
    }


    /// Fullscreen chat REPL. Returns the ExitKind accumulated on quit.
    pub(crate) async fn run_chat_tui(env: &Env, profile: &Profile) -> ExitKind {
        let history_path = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".celestea_history");
        let mut history: Vec<String> = match std::fs::read_to_string(&history_path) {
            Ok(s) => s.lines().map(|l| l.to_string()).collect(),
            Err(_) => Vec::new(),
        };
        let mut history_idx: Option<usize> = None;

        let mut term = ratatui::init();
        let state = Arc::new(Mutex::new(TuiState::new(profile.model.clone())));
        let mut code = ExitKind::Ok;

        'outer: loop {
            {
                let st = state.lock().unwrap();
                let mut scroll = 0usize;
                let _ = term.draw(|f| draw(f, &st, &mut scroll));
            }

            let ev = next_term_event().await;

            // Ctrl-D (raw-mode char 'd' + CONTROL) quits the fullscreen TUI.
            if let Some(TermEvent::Key(k)) = ev.as_ref() {
                if k.code == KeyCode::Char('d') && k.modifiers.contains(KeyModifiers::CONTROL) {
                    break 'outer;
                }
            }


            let mut submitted: Option<String> = None;
            if let Some(TermEvent::Key(k)) = ev {
                let ctrl_c =
                    k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    // At the prompt Ctrl-C clears the current input line.
                    let mut st = state.lock().unwrap();
                    st.input.clear();
                    continue;
                }
                match k.code {
                    KeyCode::Enter => {
                        let mut st = state.lock().unwrap();
                        submitted = Some(std::mem::take(&mut st.input));
                    }
                    KeyCode::Backspace => {
                        let mut st = state.lock().unwrap();
                        st.input.pop();
                    }
                    KeyCode::Char(c) => {
                        let mut st = state.lock().unwrap();
                        st.input.push(c);
                    }
                    KeyCode::Esc => {
                        let mut st = state.lock().unwrap();
                        st.input.clear();
                    }
                    KeyCode::Up => {
                        if !history.is_empty() {
                            let idx = history_idx.unwrap_or(history.len()).saturating_sub(1);
                            history_idx = Some(idx);
                            let mut st = state.lock().unwrap();
                            st.input = history.get(idx).cloned().unwrap_or_default();
                        }
                    }
                    KeyCode::Down => {
                        if let Some(idx) = history_idx {
                            let ni = idx + 1;
                            let mut st = state.lock().unwrap();
                            if ni < history.len() {
                                history_idx = Some(ni);
                                st.input = history[ni].clone();
                            } else {
                                history_idx = None;
                                st.input.clear();
                            }
                        }
                    }
                    _ => {}
                }
            }

            let line: String = match submitted {
                Some(s) => s.trim().to_string(),
                None => continue,
            };
            if line.is_empty() {
                continue;
            }


            if line == "exit" || line == "quit" {
                break 'outer;
            }
            if let Some(cmd) = parse_repl_command(&line) {
                match cmd {
                    ReplCommand::Exit => break 'outer,
                    ReplCommand::Clear => {
                        state.lock().unwrap().conv.clear();
                    }
                    ReplCommand::Tools => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(String::from("tools:"));
                        for t in env.registry.schemas() {
                            st.conv.push(format!("  {} - {}", t.name, t.description));
                        }
                    }
                    ReplCommand::Model => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("model: {}", profile.model));
                    }
                    ReplCommand::Profile => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("profile: {}", format_profile(profile)));
                    }
                    ReplCommand::Unknown(name) => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("unknown /{name}"));
                    }
                }
                continue;
            }

            history.push(line.clone());
            history_idx = None;
            let (result, interrupt) = run_tui_turn(env, &mut term, &state, &line).await;
            match interrupt {
                InterruptKind::ForceQuit => {
                    code = ExitKind::Interrupted;
                    break 'outer;
                }
                InterruptKind::Cancelled => {
                    let mut st = state.lock().unwrap();
                    let mut md = std::mem::replace(&mut st.md, rich::StreamingMarkdown::new(None));
                    st.buf.finish_stream(&mut md);
                    st.md = md;
                    let done = std::mem::take(&mut st.buf.lines);
                    st.conv.extend(done);
                    st.conv.push(String::from("⏹ 已中断 (turn cancelled)"));
                    st.buf = MessageBuf::new();
                    st.running = false;
                    st.interrupted = true;
                }
                InterruptKind::None => {
                    let mut st = state.lock().unwrap();
                    if let Err(e) = result {
                        st.conv.push(format!("error: {e}"));
                        code.merge(ExitKind::Turn);
                    }
                    for _ in 0..TURN_GAP {
                        st.conv.push(String::new());
                    }
                }
            }
        }

        // Persist the history file (best effort).
        if let Ok(mut f) = std::fs::File::create(&history_path) {
            let joined = history.join("\n");
            let _ = std::io::Write::write_all(&mut f, joined.as_bytes());
        }

        ratatui::restore();
        let _ = std::io::stdout().flush();
        code
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn split_lines_keeps_empties_and_tail() {
            let mut out = Vec::new();
            let n = split_ansi_lines("a\n\nb", &mut out);
            assert_eq!(n, 3);
            assert_eq!(out, ["a", "", "b"]);
            out.clear();
            let n2 = split_ansi_lines("x\n", &mut out);
            assert_eq!(n2, 1);
            assert_eq!(out, ["x"]);
        }

        #[test]
        fn message_buf_incremental_and_finish() {
            let mut buf = MessageBuf::new();
            let mut md = rich::StreamingMarkdown::new(None);
            // A partial line is held, not emitted.
            assert_eq!(buf.push_stream(&mut md, "Hello **wo"), 0);
            assert!(buf.lines.is_empty());
            // Completion of the line (with a trailing newline) emits one line.
            let n = buf.push_stream(&mut md, "rld**\n");
            assert_eq!(n, 1);
            assert_eq!(buf.lines.len(), 1);
            // rich renders the bold markers away into ANSI.
            assert!(buf.lines[0].contains("Hello"));
            assert!(buf.lines[0].contains("[1mworld[0m"));
            assert!(!buf.is_finished());
            // A trailing partial line is flushed by finish.
            buf.push_stream(&mut md, "tail");
            let nf = buf.finish_stream(&mut md);
            assert_eq!(nf, 1);
            assert_eq!(buf.lines.len(), 2);
            assert_eq!(buf.lines[1], "tail");
            assert!(buf.is_finished());
            // No double-finish.
            assert_eq!(buf.finish_stream(&mut md), 0);
        }


        #[test]
        fn tool_card_resolve_transitions() {
            let ok = |o: ToolOutput| {
                let mut c = ToolCard::new_call("c".into(), "t".into());
                c.resolve(&o);
                c.status
            };
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: Some(serde_json::json!("x")), render: None, error: None, decision: Some(ToolDecision::Allow) }), ToolStatus::Success);
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: None, render: None, error: Some("boom".into()), decision: None }), ToolStatus::Error("boom".into()));
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: None, render: None, error: None, decision: Some(ToolDecision::Deny("no".into())) }), ToolStatus::Denied("no".into()));
        }


        #[test]
        fn chat_mode_dispatches() {
            assert_eq!(chat_mode(true, true), ChatMode::Tui);
            assert_eq!(chat_mode(true, false), ChatMode::Repl);
            assert_eq!(chat_mode(false, true), ChatMode::OneShot);
            assert_eq!(chat_mode(false, false), ChatMode::OneShot);
        }

        #[test]
        fn split_widths_reserves_right_pane_but_drops_on_narrow() {
            assert_eq!(split_widths(120), (74, 46));
            assert_eq!(split_widths(39), (39, 0));
            let (l, r) = split_widths(100);
            assert!(l > 0 && r > 0 && l + r == 100);
        }

        #[test]
        fn throttle_redraw_gate() {
            let t0 = Instant::now();
            assert!(should_redraw(None, t0, std::time::Duration::from_millis(20)));
            let soon = t0 + std::time::Duration::from_millis(5);
            assert!(!should_redraw(Some(t0), soon, std::time::Duration::from_millis(20)));
            let later = t0 + std::time::Duration::from_millis(25);
            assert!(should_redraw(Some(t0), later, std::time::Duration::from_millis(20)));
        }

        #[test]
        fn ansi_to_spans_maps_styles() {
            let line = ansi_line_to_spans("[1;36mhi[0m");
            let spans = line.spans;
            assert_eq!(spans.len(), 1);
            assert_eq!(spans[0].content, "hi");
            assert!(spans[0].style.add_modifier.contains(Modifier::BOLD));
            assert_eq!(spans[0].style.fg, Some(Color::Cyan));
        }


    }

}

// ============================================================================
// Compose + run
// ============================================================================

/// The resolved agent environment handed to the run paths.
struct Env {
    ctx: Context,
    session: Arc<dyn SessionLog>,
    registry: Arc<dyn ToolRegistry>,
    /// The AgentConfig derived from the profile; run paths rebuild a loop
    /// per turn (with cancel + optional sink) via make_loop.
    config: AgentConfig,
    /// Rich renderer (None when output is plain/JSON). Its sink is injected
    /// into the per-turn loop so stream events are styled instead of printed.
    renderer: Option<rich::RichRenderer>,
}

impl Env {
    /// The injected sink, if rich rendering is active.
    fn sink(&self) -> Option<EventSink> {
        self.renderer.as_ref().map(|r| r.sink.clone())
    }

    /// Build a per-turn DefaultAgentLoop from the profile config, an optional
    /// cooperative cancel signal and the optional sink.
    fn make_loop(&self, cancel: Option<watch::Receiver<bool>>) -> Arc<dyn AgentLoop> {
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
fn resolve_base_url(profile_base: Option<&str>, env_base: Option<&str>) -> String {
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
fn validate_model(model: &str) -> Result<()> {
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
fn load_dotenv_at(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    dotenvy::from_path(path).is_ok()
}

/// Load `.env` from the current directory at startup (best-effort).
fn load_dotenv() {
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
fn resolve_api_key(profile: &Profile) -> Result<String> {
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
fn compose(profile: &Profile) -> Result<Env> {
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

/// Read all of stdin into one string (piped / one-shot input).
async fn read_all_stdin() -> std::io::Result<String> {
    let mut stdin = tokio::io::stdin();
    let mut buf = String::new();
    stdin.read_to_string(&mut buf).await?;
    Ok(buf)
}

#[tokio::main]
async fn main() {
    // Best-effort `.env` loading from the current directory (silent if absent).
    load_dotenv();
    tracing_subscriber::fmt().init();
    let args = Args::parse();
    let kind = run(&args).await;
    let _ = std::io::stdout().flush();
    std::process::exit(kind.code());
}

async fn run(args: &Args) -> ExitKind {
    // `tools` needs no profile / LLM: list builtin tools and exit.
    if matches!(&args.command, Some(Command::Tools)) {
        let mut registry = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            registry.register(tool);
        }
        print!("{}", format_tool_list(&registry.schemas()));
        let _ = std::io::stdout().flush();
        return ExitKind::Ok;
    }

    let profile = match resolve_profile(
        args.profile.as_deref(),
        args.strict,
        Path::new(DEFAULT_CONFIG),
        Path::new(LEGACY_CONFIG),
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e:#}");
            return ExitKind::Config;
        }
    };

    let mut env = match compose(&profile) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("error: {e:#}");
            return ExitKind::Config;
        }
    };

    // P1 rich line-renderer powers the legacy REPL, one-shot runs and piped
    // output. The fullscreen ratatui TUI (W195) installs its own sink, so the
    // RichRenderer is only wired up when we are NOT entering the TUI.
    let stdout_tty = std::io::stdout().is_terminal();
    let stdin_tty = std::io::stdin().is_terminal();
    let want_tui = matches!(&args.command, None | Some(Command::Chat)) && stdin_tty && stdout_tty;
    let rich = stdout_tty
        && !matches!(&args.command, Some(Command::Run { json: true, .. }))
        && !want_tui;
    if rich {
        env.renderer = Some(rich::RichRenderer::new());
    }

    match &args.command {
        None | Some(Command::Chat) => match tui::chat_mode(stdin_tty, stdout_tty) {
            tui::ChatMode::Tui => tui::run_chat_tui(&env, &profile).await,
            tui::ChatMode::Repl => run_repl(&env, &profile).await,
            tui::ChatMode::OneShot => match read_all_stdin().await {
                Ok(text) => run_one_shot(&env, &text, false).await,
                Err(e) => {
                    eprintln!("error reading stdin: {e}");
                    ExitKind::Runtime
                },
            },
        },
        Some(Command::Run { input, json }) => {
            let text = match input {
                Some(t) => t.clone(),
                None => match read_all_stdin().await {
                    Ok(t) => t,
                    Err(e) => {
                        eprintln!("error reading stdin: {e}");
                        return ExitKind::Runtime;
                    }
                },
            };
            run_one_shot(&env, &text, *json).await
        }
        Some(Command::Tools) => unreachable!("handled above"),
    }
}

/// What happened to a turn raced against Ctrl-C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InterruptKind {
    /// The turn completed on its own.
    None,
    /// A single Ctrl-C cancelled the turn gracefully.
    Cancelled,
    /// A second Ctrl-C force-quit the turn (partial output kept).
    ForceQuit,
}

/// Run one turn with cooperative Ctrl-C handling: the first SIGINT cancels
/// the turn gracefully (watch::Sender fed to DefaultAgentLoop::with_cancel_
/// sink); a second SIGINT force-quits. Returns the turn result and which
/// interrupt path (if any) fired.
async fn run_turn_interruptible(
    env: &Env,
    input: &str,
) -> (Result<(), AgentError>, InterruptKind) {
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let agent = env.make_loop(Some(cancel_rx));
    let turn = agent.run_turn(&env.ctx, input);
    tokio::pin!(turn);
    let mut cancelled = false;
    let mut sigint = Box::pin(tokio::signal::ctrl_c());
    loop {
        tokio::select! {
            r = &mut turn => {
                return if cancelled {
                    (r, InterruptKind::Cancelled)
                } else {
                    (r, InterruptKind::None)
                };
            }
            _ = &mut sigint => {
                if !cancelled {
                    cancelled = true;
                    let _ = cancel_tx.send(true);
                    // Re-arm for a possible second Ctrl-C (force quit).
                    sigint = Box::pin(tokio::signal::ctrl_c());
                } else {
                    return (Ok(()), InterruptKind::ForceQuit);
                }
            }
        }
    }
}

/// One-shot: run a single turn (optionally silent + JSON) and exit. Ctrl-C
/// cancels the turn gracefully and exits with code 130 (128+SIGINT); a
/// second Ctrl-C force-quits (also 130).
async fn run_one_shot(env: &Env, input: &str, json: bool) -> ExitKind {
    let input = input.trim();
    if input.is_empty() {
        // Nothing to run: exit cleanly, still emitting a well-formed document
        // in --json mode so a piped consumer always gets valid JSON.
        if json {
            println!("{}", serde_json::json!({
                "turn": "", "assistant_text": "", "tool_calls": [], "results": []
            }));
        }
        return ExitKind::Ok;
    }

    if let Some(r) = &env.renderer {
        r.reset();
    }
    // In --json mode stdout must carry only the JSON document, so streaming
    // output is silenced (and no rich sink is installed).
    let silencer = if json { stdout_redirect::silencer() } else { None };
    let (result, interrupt) = run_turn_interruptible(env, input).await;
    drop(silencer);

    match interrupt {
        InterruptKind::ForceQuit | InterruptKind::Cancelled => {
            // Keep whatever partial output was already rendered, then print a
            // clean status and exit 130 (the conventional SIGINT code).
            if let Some(r) = &env.renderer {
                r.flush();
            }
            rich::restore_after_interrupt();
            eprintln!("⏹ 已中断");
            ExitKind::Interrupted
        }
        InterruptKind::None => {
            let mut kind = ExitKind::Ok;
            let error = match result {
                Ok(()) => None,
                Err(e) => {
                    eprintln!("error: {e}");
                    kind = ExitKind::Turn;
                    Some(e.to_string())
                }
            };
            if json {
                let summary = summarize_turn(&env.session.events());
                println!("{}", summary.to_json(error.as_deref()));
            }
            kind
        }
    }
}

/// Interactive REPL (rustyline). Ctrl-C cancels the current line and continues;
/// Ctrl-D / exit / /exit stop; a failing turn sets the accumulated exit code,
/// returned when the REPL ends.
async fn run_repl(env: &Env, profile: &Profile) -> ExitKind {
    let mut rl = match DefaultEditor::new() {
        Ok(rl) => rl,
        Err(e) => {
            eprintln!("failed to init line editor: {e}");
            return ExitKind::Runtime;
        }
    };

    // Best-effort history persistence across sessions.
    let history_path = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".celestea_history");
    let _ = rl.load_history(&history_path);

    let mut code = ExitKind::Ok;
    loop {
        match rl.readline("> ") {
            Ok(line) => {
                let _ = rl.add_history_entry(line.as_str());
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match parse_repl_command(line) {
                    Some(cmd) => {
                        if let Some(exit_kind) =
                            handle_repl_command(&cmd, &env.registry, &env.session, profile)
                        {
                            code.merge(exit_kind);
                            break;
                        }
                    }
                    None => {
                        if line == "exit" || line == "quit" {
                            break;
                        }
                        if let Some(r) = &env.renderer {
                            r.reset();
                        }
                        let (result, interrupt) = run_turn_interruptible(env, line).await;
                        match interrupt {
                            // Second Ctrl-C: force-quit the whole REPL.
                            InterruptKind::ForceQuit => return ExitKind::Interrupted,
                            // First Ctrl-C: cancel the turn, keep partial output,
                            // restore a clean terminal and return to the prompt.
                            InterruptKind::Cancelled => {
                                if let Some(r) = &env.renderer {
                                    r.flush();
                                }
                                rich::restore_after_interrupt();
                                println!("⏹ 已中断");
                            }
                            InterruptKind::None => {
                                if let Err(e) = result {
                                    eprintln!("error: {e}");
                                    code.merge(ExitKind::Turn);
                                }
                            }
                        }
                    }
                }
            }
            Err(ReadlineError::Interrupted) => continue, // Ctrl-C: fresh line
            Err(ReadlineError::Eof) => break,             // Ctrl-D: exit
            Err(e) => {
                eprintln!("readline error: {e}");
                code.merge(ExitKind::Runtime);
                break;
            }
        }
    }

    let _ = rl.save_history(&history_path);
    code
}

/// Execute one REPL `/` command. Returns Some(ExitKind) only when the command
/// requests exit (the REPL then breaks with the accumulated code).
fn handle_repl_command(
    cmd: &ReplCommand,
    registry: &Arc<dyn ToolRegistry>,
    session: &Arc<dyn SessionLog>,
    profile: &Profile,
) -> Option<ExitKind> {
    match cmd {
        ReplCommand::Tools => {
            print!("{}", format_tool_list(&registry.schemas()));
            let _ = std::io::stdout().flush();
        }
        ReplCommand::Model => {
            println!("model: {}", profile.model);
        }
        ReplCommand::Clear => {
            session.clear();
            println!("session cleared");
        }
        ReplCommand::Profile => {
            println!("{}", format_profile(profile));
        }
        ReplCommand::Exit => return Some(ExitKind::Ok),
        ReplCommand::Unknown(name) => {
            eprintln!("unknown command '/{name}' (try /tools /model /clear /profile /exit)");
        }
    }
    None
}
// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A unique scratch path under the system temp dir (no tempfile dep).
    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("celestea-cli-test-{}-{}", std::process::id(), name))
    }

    /// Write a profile file, returning its path. Caller cleans up.
    fn write_profile(name: &str, content: &str) -> PathBuf {
        let path = scratch(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    // ---- exit-code contract ------------------------------------------------
    #[test]
    fn exit_kind_mapping() {
        assert_eq!(ExitKind::Ok.code(), 0);
        assert_eq!(ExitKind::Config.code(), 1);
        assert_eq!(ExitKind::Turn.code(), 2);
        assert_eq!(ExitKind::Runtime.code(), 3);
        assert_eq!(ExitKind::Interrupted.code(), 130);
    }

    #[test]
    fn exit_kind_merge_keeps_max() {
        let mut code = ExitKind::Ok;
        code.merge(ExitKind::Turn);
        assert_eq!(code, ExitKind::Turn);
        code.merge(ExitKind::Runtime);
        assert_eq!(code, ExitKind::Runtime);
        code.merge(ExitKind::Ok);
        assert_eq!(code, ExitKind::Runtime);
    }

    #[test]
    fn interrupted_exit_code_is_130() {
        // Ctrl-C on one-shot runs exits with the conventional 128+SIGINT code.
        assert_eq!(ExitKind::Interrupted.code(), 130);
        assert_eq!(InterruptKind::None as i32, 0);
        assert_ne!(InterruptKind::Cancelled, InterruptKind::ForceQuit);
    }

    #[test]
    fn default_profile_uses_celestea_identity() {
        // D: the CLI default system prompt is the celestea agent identity,
        // matching celestea_core::AgentConfig::default (not a generic assistant).
        let p = Profile::default();
        assert_eq!(
            p.system_prompt,
            "You are celestea, an AI agent. You are concise, accurate and direct."
        );
        assert!(!p.system_prompt.contains("helpful assistant"));
    }

    #[test]
    fn compose_carries_identity_into_loop_config() {
        let key_env = "W194_IDENTITY_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let env = compose(&profile).unwrap();
        assert!(env.config.system_prompt.contains("celestea"));
        assert!(env.config.system_prompt.contains("concise"));
        std::env::remove_var(key_env);
    }

    // ---- clap subcommand parsing -------------------------------------------
    #[test]
    fn default_subcommand_is_none() {
        let args = Args::try_parse_from(["celestea"]).unwrap();
        assert!(args.command.is_none());
        assert!(!args.strict);
        assert!(args.profile.is_none());
    }

    #[test]
    fn chat_subcommand_parses() {
        let args = Args::try_parse_from(["celestea", "chat"]).unwrap();
        assert!(matches!(args.command, Some(Command::Chat)));
    }

    #[test]
    fn run_subcommand_parses_input() {
        let args = Args::try_parse_from(["celestea", "run", "-e", "hi"]).unwrap();
        assert!(matches!(
            args.command,
            Some(Command::Run { input: Some(ref s), json: false }) if s == "hi"
        ));
    }

    #[test]
    fn run_subcommand_parses_long_input_and_json() {
        let args = Args::try_parse_from(["celestea", "run", "--input", "x", "--json"]).unwrap();
        assert!(matches!(
            args.command,
            Some(Command::Run { input: Some(ref s), json: true }) if s == "x"
        ));
    }

    #[test]
    fn run_without_input_allowed() {
        let args = Args::try_parse_from(["celestea", "run"]).unwrap();
        assert!(matches!(args.command, Some(Command::Run { input: None, json: false })));
    }

    #[test]
    fn tools_subcommand_parses() {
        let args = Args::try_parse_from(["celestea", "tools"]).unwrap();
        assert!(matches!(args.command, Some(Command::Tools)));
    }

    #[test]
    fn global_strict_and_profile_before_or_after_subcommand() {
        let a = Args::try_parse_from(["celestea", "--strict", "run", "-e", "hi"]).unwrap();
        assert!(a.strict);
        let b = Args::try_parse_from(["celestea", "run", "--profile", "x.json", "-e", "hi"]).unwrap();
        assert_eq!(b.profile, Some(PathBuf::from("x.json")));
    }

    #[test]
    fn unknown_subcommand_is_an_error() {
        assert!(Args::try_parse_from(["celestea", "frobnicate"]).is_err());
    }

    // ---- REPL command parsing ------------------------------------------------
    #[test]
    fn slash_commands_parse() {
        assert_eq!(parse_repl_command("/tools"), Some(ReplCommand::Tools));
        assert_eq!(parse_repl_command("/model"), Some(ReplCommand::Model));
        assert_eq!(parse_repl_command("/clear"), Some(ReplCommand::Clear));
        assert_eq!(parse_repl_command("/profile"), Some(ReplCommand::Profile));
        assert_eq!(parse_repl_command("/exit"), Some(ReplCommand::Exit));
        assert_eq!(parse_repl_command("/quit"), Some(ReplCommand::Exit));
    }

    #[test]
    fn slash_commands_allow_leading_whitespace() {
        assert_eq!(parse_repl_command("  /tools"), Some(ReplCommand::Tools));
    }

    #[test]
    fn unknown_slash_command_is_reported() {
        assert_eq!(parse_repl_command("/bogus"), Some(ReplCommand::Unknown("bogus".into())));
        assert_eq!(parse_repl_command("/"), Some(ReplCommand::Unknown(String::new())));
    }

    #[test]
    fn plain_input_is_not_a_command() {
        assert_eq!(parse_repl_command("hello"), None);
        assert_eq!(parse_repl_command(""), None);
        // legacy bare-word exit stays in the REPL loop, not a slash command
        assert_eq!(parse_repl_command("exit"), None);
    }

    // ---- --strict -----------------------------------------------------------
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

    // ---- turn summary (--json extraction) -----------------------------------
    #[test]
    fn summarize_turn_extracts_text_calls_results() {
        let events = vec![
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
        ];
        let s = summarize_turn(&events);
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

    // ---- tool listing formatting ---------------------------------------------
    #[test]
    fn format_tool_list_lists_name_and_description() {
        let specs = vec![
            ToolSpec {
                name: "read_file".into(),
                description: "Read a file.".into(),
                parameters: json!({}),
            },
            ToolSpec {
                name: "run_shell".into(),
                description: "Run a shell command.".into(),
                parameters: json!({}),
            },
        ];
        let out = format_tool_list(&specs);
        assert!(out.contains("read_file"));
        assert!(out.contains("Read a file."));
        assert!(out.contains("run_shell"));
        assert!(out.contains("Run a shell command."));
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

    // ---- W189: LLM adapter registry in compose --------------------------------
    #[test]
    fn compose_registers_deepseek_and_keeps_llm_service() {
        // A dedicated env var name so the test never touches a real key.
        let key_env = "W189_TEST_API_KEY";
        std::env::set_var(key_env, "sk-test");
        let profile = Profile { api_key_env: key_env.into(), ..Profile::default() };
        let env = compose(&profile).unwrap();

        // The registry seam: deepseek registered and resolvable by name.
        let reg = env.ctx.get::<LlmRegistryService>().unwrap();
        assert_eq!(reg.list(), vec!["deepseek".to_string()]);
        assert!(reg.resolve("deepseek").is_some());
        assert!(reg.resolve("unknown").is_none());

        // Back-compat: the single-adapter LlmService is still provided.
        assert!(env.ctx.get::<LlmService>().is_some());

        std::env::remove_var(key_env);
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
}
