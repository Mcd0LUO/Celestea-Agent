//! celestea-cli — entry point, compose, profile loading, chat/run/tools (W105/W176/W182).
//!
//! Parses --profile (a JSON file), builds the shared celestea_core::Context,
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
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use celestea_agent_loop::DefaultAgentLoop;
use celestea_core::{
    AgentConfig, AgentLoop, AgentLoopService, Context, LlmRegistryService, LlmService,
    SessionEvent, SessionLog, SessionService, ToolRegistry, ToolRegistryService, ToolSpec,
};
use celestea_llm::{deepseek_registry, DeepSeekConfig, DeepSeekLlm, ReasoningEffort};
use celestea_session::InMemorySessionLog;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use clap::{Parser, Subcommand};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use serde_json::Value;
use tokio::io::AsyncReadExt;

// ============================================================================
// CLI args + help
// ============================================================================

/// Command-line arguments for the celestea agent.
#[derive(Debug, Parser)]
#[command(
    name = "celestea",
    version,
    about = "celestea_harness agent CLI (chat / run / tools)",
    long_about = "celestea_harness agent CLI: compose a Context from a JSON profile, then run \
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
    /// Path to the JSON profile file. Missing files fall back to defaults.
    #[arg(long, default_value = "profile.json", global = true)]
    profile: PathBuf,

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
/// error; 3 runtime I/O or internal error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
enum ExitKind {
    Ok = 0,
    Config = 1,
    Turn = 2,
    Runtime = 3,
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

/// Runtime configuration loaded from profile.json (or defaults).
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
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            system_prompt: "You are a helpful assistant.".into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
            base_url: None,
            reasoning_effort: None,
            max_output_tokens: None,
            api_key_env: "DEEPSEEK_API_KEY".into(),
        }
    }
}

/// The documented profile keys the CLI understands today. W178 extends this
/// list with model-config keys; `--strict` unknown-key rejection keys off it.
const PROFILE_KEYS: [&str; 8] = [
    "model",
    "system_prompt",
    "max_steps",
    "max_parallel_tool_calls",
    "base_url",
    "reasoning_effort",
    "max_output_tokens",
    "api_key_env",
];

/// Merge a parsed profile JSON over the defaults (lenient). The root must be
/// an object; only the documented keys are read; unknown keys are ignored and
/// wrong-type fields fall back to the default (backwards compatible).
///
/// Only referenced from tests; production calls `load_profile` (which routes
/// through `merge_profile_mode`), so this stays behind `#[cfg(test)]`.
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

/// Load a profile from a JSON file, falling back to defaults when the file is
/// absent. Only the documented keys are read. Invalid JSON, a non-object root,
/// or a file that exists but cannot be read is a hard error. In `strict` mode
/// unknown keys / wrong-type fields are also hard errors.
fn load_profile(path: &Path, strict: bool) -> Result<Profile> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("profile '{}' not found; using defaults", path.display());
            return Ok(Profile::default());
        }
        Err(e) => return Err(e.into()),
    };

    let json: Value = serde_json::from_str(&content)
        .map_err(|e| anyhow!("invalid JSON in profile '{}': {}", path.display(), e))?;

    merge_profile_mode(&json, strict)
        .map_err(|e| anyhow!("invalid profile '{}': {:#}", path.display(), e))
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
// Compose + run
// ============================================================================

/// The resolved agent environment handed to the run paths.
struct Env {
    ctx: Context,
    agent: Arc<dyn AgentLoop>,
    session: Arc<dyn SessionLog>,
    registry: Arc<dyn ToolRegistry>,
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

/// Compose the shared Context from the profile: LLM adapter registry, session,
/// tool registry, agent loop, each registered as its *Service newtype.
fn compose(profile: &Profile) -> Result<Env> {
    // Model validation first: reject an empty model up front, before any
    // secret or URL resolution.
    validate_model(&profile.model)?;

    // API key always comes from the environment named by api_key_env (default
    // DEEPSEEK_API_KEY); the token value itself never lives in the profile.
    let api_key = std::env::var(&profile.api_key_env).map_err(|_| {
        anyhow!(
            "environment variable '{}' is not set; set it to your DeepSeek API key (or point api_key_env at a different variable)",
            profile.api_key_env
        )
    })?;

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

    let agent: Arc<dyn AgentLoop> = Arc::new(DefaultAgentLoop::new(AgentConfig {
        model: profile.model.clone(),
        system_prompt: profile.system_prompt.clone(),
        max_steps: profile.max_steps,
        max_parallel_tool_calls: profile.max_parallel_tool_calls,
    }));

    let mut ctx = Context::new();
    ctx.provide(LlmService(resolved));
    ctx.provide(LlmRegistryService(Arc::new(llm_registry)));
    ctx.provide(SessionService(session.clone()));
    ctx.provide(ToolRegistryService(registry.clone()));
    ctx.provide(AgentLoopService(agent.clone()));
    Ok(Env { ctx, agent, session, registry })
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

    let profile = match load_profile(&args.profile, args.strict) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e:#}");
            return ExitKind::Config;
        }
    };

    let env = match compose(&profile) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("error: {e:#}");
            return ExitKind::Config;
        }
    };

    let is_tty = std::io::stdin().is_terminal();
    match &args.command {
        None | Some(Command::Chat) => {
            if is_tty {
                run_repl(&env, &profile).await
            } else {
                // Non-terminal stdin: auto one-shot over all of stdin.
                match read_all_stdin().await {
                    Ok(text) => run_one_shot(&env, &text, false).await,
                    Err(e) => {
                        eprintln!("error reading stdin: {e}");
                        ExitKind::Runtime
                    }
                }
            }
        }
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

/// One-shot: run a single turn (optionally silent + JSON) and exit.
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

    let result = if json {
        // Suppress streaming deltas so stdout carries only the JSON document.
        let _silencer = stdout_redirect::silencer();
        env.agent.run_turn(&env.ctx, input).await
    } else {
        env.agent.run_turn(&env.ctx, input).await
    };

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
                        if let Err(e) = env.agent.run_turn(&env.ctx, line).await {
                            eprintln!("error: {e}");
                            code.merge(ExitKind::Turn);
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

    // ---- clap subcommand parsing -------------------------------------------
    #[test]
    fn default_subcommand_is_none() {
        let args = Args::try_parse_from(["celestea"]).unwrap();
        assert!(args.command.is_none());
        assert!(!args.strict);
        assert_eq!(args.profile, PathBuf::from("profile.json"));
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
        assert_eq!(b.profile, PathBuf::from("x.json"));
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
}
