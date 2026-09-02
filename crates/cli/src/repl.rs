//! One-shot run, interactive rustyline REPL, /command dispatch, and reading
//! piped stdin.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use celestea_core::{SessionLog, ToolRegistry};
use rustyline::completion::Completer;
use rustyline::error::ReadlineError;
use rustyline::highlight::Highlighter;
use rustyline::hint::Hinter;
use rustyline::history::DefaultHistory;
use rustyline::validate::Validator;
use rustyline::{Context, Editor, Helper};
use tokio::io::AsyncReadExt;

use crate::config::{Env, Profile};
use crate::interrupt::{run_turn_interruptible, InterruptKind};
use crate::redirect::stdout_redirect;
use crate::render::{complete_repl_command, format_profile, format_tool_list, parse_repl_command, summarize_turn, ReplCommand};
use crate::rich;
use crate::ExitKind;

/// rustyline helper that tab-completes and hints leading-/ REPL commands
/// (/tools /model /clear /profile /exit /quit; quit is the alias of exit
/// and is offered for completion too). Non-/ lines are never touched.
#[derive(Debug, Clone, Default)]
pub(crate) struct ReplHelper;

impl Completer for ReplHelper {
    type Candidate = String;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        _ctx: &Context<'_>,
    ) -> rustyline::Result<(usize, Vec<String>)> {
        // Only complete a /-command token whose end the cursor sits at.
        if pos < line.len() {
            return Ok((pos, Vec::new()));
        }
        let head = &line[..pos];
        let trimmed = head.trim_start();
        let Some(prefix) = trimmed.strip_prefix('/') else {
            return Ok((pos, Vec::new()));
        };
        // A space after the command word ends the token: stop completing.
        if prefix.contains(char::is_whitespace) {
            return Ok((pos, Vec::new()));
        }
        let cands = complete_repl_command(head);
        if cands.is_empty() {
            return Ok((pos, Vec::new()));
        }
        let start = head.len() - prefix.len() - 1; // byte offset of '/'
        Ok((start, cands))
    }
}

impl Hinter for ReplHelper {
    type Hint = String;

    fn hint(&self, line: &str, pos: usize, _ctx: &Context<'_>) -> Option<String> {
        if pos < line.len() {
            return None;
        }
        let head = &line[..pos];
        let trimmed = head.trim_start();
        let Some(prefix) = trimmed.strip_prefix('/') else {
            return None;
        };
        if prefix.is_empty() || prefix.contains(char::is_whitespace) {
            return None;
        }
        let cands = complete_repl_command(head);
        if cands.len() == 1 {
            let c = &cands[0];
            if c.len() > head.len() {
                return Some(c[head.len()..].to_string());
            }
        }
        None
    }
}

impl Highlighter for ReplHelper {}
impl Validator for ReplHelper {}
impl Helper for ReplHelper {}

pub(crate) async fn read_all_stdin() -> std::io::Result<String> {
    let mut stdin = tokio::io::stdin();
    let mut buf = String::new();
    stdin.read_to_string(&mut buf).await?;
    Ok(buf)
}
/// One-shot: run a single turn (optionally silent + JSON) and exit. Ctrl-C
/// cancels the turn gracefully and exits with code 130 (128+SIGINT); a
/// second Ctrl-C force-quits (also 130).
pub(crate) async fn run_one_shot(env: &Env, input: &str, json: bool) -> ExitKind {
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
pub(crate) async fn run_repl(env: &Env, profile: &Profile) -> ExitKind {
    let mut rl = match Editor::<ReplHelper, DefaultHistory>::new() {
        Ok(mut rl) => {
            rl.set_helper(Some(ReplHelper));
            rl
        }
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
pub(crate) fn handle_repl_command(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_ctx() -> Context<'static> {
        let history: &'static _ = Box::leak(Box::new(rustyline::history::DefaultHistory::new()));
        Context::new(history)
    }

    #[test]
    fn repl_helper_completes_slash_commands() {
        let h = ReplHelper;
        let ctx = empty_ctx();
        let (start, cands) = h.complete("/t", 2, &ctx).unwrap();
        assert_eq!(start, 0);
        assert_eq!(cands, vec!["/tools".to_string()]);
        let (_, cands) = h.complete("/", 1, &ctx).unwrap();
        assert_eq!(cands.len(), 6);
        // Non-slash input is not completed.
        let (start, cands) = h.complete("hello", 5, &ctx).unwrap();
        assert_eq!(start, 5);
        assert!(cands.is_empty());
        // No match -> no candidates.
        let (start, cands) = h.complete("/x", 2, &ctx).unwrap();
        assert_eq!(start, 2);
        assert!(cands.is_empty());
        // Cursor not at end of line -> no completion.
        let (start, cands) = h.complete("/t", 1, &ctx).unwrap();
        assert_eq!(start, 1);
        assert!(cands.is_empty());
    }

    #[test]
    fn repl_helper_hints_single_candidate() {
        let h = ReplHelper;
        let ctx = empty_ctx();
        assert_eq!(h.hint("/t", 2, &ctx).as_deref(), Some("ools"));
        // Already complete -> no hint.
        assert_eq!(h.hint("/tools", 6, &ctx), None);
        // Non-slash -> no hint.
        assert_eq!(h.hint("hello", 5, &ctx), None);
    }
}

