//! Cooperative Ctrl-C handling for one-shot turns and the REPL/one-shot paths.

use anyhow::Result;
use celestea_core::AgentError;
use tokio::sync::watch;

use crate::config::Env;

/// What happened to a turn raced against Ctrl-C.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InterruptKind {
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
pub(crate) async fn run_turn_interruptible(
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
