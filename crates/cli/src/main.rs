//! celestea-cli — entry point, compose, profile loading, REPL (W105).
//!
//! Parses --profile (a JSON file), builds the shared celestea_core::Context,
//! plugs in the concrete providers (DeepSeek llm, in-memory session, tool
//! registry, default agent loop) as the *Service newtypes, then runs a stdin
//! REPL that calls agent.run_turn for every non-empty line.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use celestea_agent_loop::DefaultAgentLoop;
use celestea_core::{
    AgentConfig, AgentLoop, AgentLoopService, Context, LlmService, SessionService,
    ToolRegistry, ToolRegistryService,
};
use celestea_llm::DeepSeekLlm;
use celestea_session::InMemorySessionLog;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use clap::Parser;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Command-line arguments for the celestea REPL.
#[derive(Debug, Parser)]
#[command(name = "celestea", version, about = "celestea_harness agent REPL (W105)")]
struct Args {
    /// Path to the JSON profile file. Missing files fall back to defaults.
    #[arg(long, default_value = "profile.json")]
    profile: PathBuf,
}

/// Runtime configuration loaded from profile.json (or defaults).
#[derive(Debug, Clone)]
struct Profile {
    model: String,
    system_prompt: String,
    max_steps: usize,
    max_parallel_tool_calls: usize,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            model: "deepseek-chat".into(),
            system_prompt: "You are a helpful assistant.".into(),
            max_steps: 16,
            max_parallel_tool_calls: 4,
        }
    }
}

/// Load a profile from JSON, falling back to defaults when the file is absent.
/// Only the four documented keys are read; anything else is ignored. Invalid
/// JSON (or a file that exists but cannot be read) is a hard error.
fn load_profile(path: &Path) -> Result<Profile> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("profile '{}' not found; using defaults", path.display());
            return Ok(Profile::default());
        }
        Err(e) => return Err(e.into()),
    };

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| anyhow!("invalid JSON in profile '{}': {}", path.display(), e))?;

    let mut profile = Profile::default();
    if let Some(v) = json.get("model").and_then(|v| v.as_str()) {
        profile.model = v.to_string();
    }
    if let Some(v) = json.get("system_prompt").and_then(|v| v.as_str()) {
        profile.system_prompt = v.to_string();
    }
    if let Some(v) = json.get("max_steps").and_then(|v| v.as_u64()) {
        profile.max_steps = v as usize;
    }
    if let Some(v) = json.get("max_parallel_tool_calls").and_then(|v| v.as_u64()) {
        profile.max_parallel_tool_calls = v as usize;
    }
    Ok(profile)
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();

    let args = Args::parse();
    let profile = load_profile(&args.profile)?;

    // Compose: build every concrete provider and register it as a service.
    let llm = DeepSeekLlm::from_env()
        .map_err(|e| anyhow!("failed to initialize DeepSeek llm: {}", e))?
        .with_model(profile.model.clone());

    let session = Arc::new(InMemorySessionLog::new());

    let mut registry = ToolRegistryImpl::new();
    for tool in builtin_tools() {
        registry.register(tool);
    }

    let agent = Arc::new(DefaultAgentLoop::new(AgentConfig {
        model: profile.model.clone(),
        system_prompt: profile.system_prompt.clone(),
        max_steps: profile.max_steps,
        max_parallel_tool_calls: profile.max_parallel_tool_calls,
    }));

    let mut ctx = Context::new();
    ctx.provide(LlmService(Arc::new(llm)));
    ctx.provide(SessionService(session));
    ctx.provide(ToolRegistryService(Arc::new(registry)));
    ctx.provide(AgentLoopService(agent.clone()));

    // REPL: read stdin line by line. Blank lines are skipped; exit/quit stop.
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();

    loop {
        print!("> ");
        let _ = std::io::stdout().flush();

        let Some(line) = lines.next_line().await? else {
            break; // EOF
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "exit" || line == "quit" {
            break;
        }

        if let Err(e) = agent.run_turn(&ctx, line).await {
            eprintln!("error: {e}");
        }
    }

    Ok(())
}
