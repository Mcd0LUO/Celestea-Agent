//! celestea-cli — entry point, compose, profile loading, chat/run/tools (W105/W176/W182).
//!
//! Parses --profile (a TOML file, with legacy JSON fallback), builds the shared
//! celestea_core::Context, plugs in the concrete providers (DeepSeek llm,
//! in-memory session, tool registry, default agent loop) as the *Service
//! newtypes, then runs one of:
//!
//! - `chat` (default): interactive REPL on a terminal stdin, backed by
//!   rustyline (history / line editing / Ctrl-C / Ctrl-D); when stdin is NOT
//!   a terminal (piped/redirected) it reads all of stdin as one turn instead.
//! - `run -e|--input <text> [--json]`: one-shot — run a single turn and exit.
//! - `tools`: list the built-in tool names + descriptions (no LLM needed).
//!
//! Exit-code contract: 0 success; 1 config/init error; 2 turn execution error;
//! 3 runtime I/O or internal error. See --help for precedence rules.

mod config;
mod interrupt;
mod redirect;
mod render;
mod repl;
mod rich;
mod tui;

use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

use celestea_core::ToolRegistry;
use celestea_tools::{builtin_tools, ToolRegistryImpl};
use clap::{Parser, Subcommand};

use crate::config::{
    compose, load_dotenv, resolve_profile, DEFAULT_CONFIG, LEGACY_CONFIG,
};
use crate::repl::{read_all_stdin, run_one_shot, run_repl};
use crate::render::format_tool_list;
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
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serde_json::Value;
    use std::path::PathBuf;

    use celestea_core::{LlmRegistryService, LlmService, SessionEvent, ToolSpec};
    use celestea_llm::ReasoningEffort;

    use crate::config::{
        compose, load_dotenv_at, load_profile, merge_profile, merge_profile_strict,
        resolve_api_key, resolve_base_url, resolve_profile, validate_model, Profile,
    };
    use crate::interrupt::InterruptKind;
    use crate::render::{
        format_tool_list, parse_repl_command, summarize_turn, ReplCommand, ToolCallRec,
        ToolResultRec, TurnSummary,
    };

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
