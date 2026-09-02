//! celestea-runtime — the agent runtime engine library (W214).
//!
//! Extracted from the deleted terminal CLI (W105/W176/W182/W178/W189/W192/
//! W194/W206/W210): this crate owns the engine wiring — profile loading,
//! composition of the shared celestea_core::Context (LLM adapter registry,
//! session log, tool registry, agent loop, worker orchestration), and a
//! cancellable, streaming turn runner. All terminal frontends (rustyline REPL /
//! ratatui TUI / rich rendering / clap entry) were deleted with the CLI; there
//! is no stdin/stdout or terminal concept here.
//!
//! # Public surface
//!
//! - [Profile] + [resolve_profile]: 9-key TOML/JSON config with lenient /
//!   strict merge semantics, home-dir fallback, api-key 3-path resolution.
//! - [Runtime::compose]: build the shared [Context] + service registries from
//!   a [Profile] (incl. the CELESTEA_SESSION_DIR persistence switch).
//! - [Runtime::run_turn]: one cancellable, streaming turn — a frontend feeds
//!   an [EventSink] and consumes Text/Thinking/ToolCall/ToolResult/Done events
//!   (see [LoopEvent]) and cancels cooperatively via a tokio::sync::watch
//!   channel.
//! - [TurnSummary] / [summarize_turn]: structured one-turn summary.
//! - [register_all_tools]: builtin file tools + worker-orchestration tools.
//!
//! No terminal dependencies are allowed in this crate (no clap / rustyline /
//! ratatui / crossterm / pulldown-cmark / syntect).

mod compose;
mod config;
mod run;
mod summary;
mod tools;

// Re-exports: engine consumers get a single import path for the loop events
// and the core seams they stream.
pub use celestea_agent_loop::{EventSink, LoopEvent};
pub use celestea_core::{
    AgentConfig, AgentError, AgentLoop, Context, SessionEvent, SessionLog,
    ToolRegistry, ToolSpec,
};
pub use celestea_tools::ToolRegistryImpl;
pub use celestea_workers::{WorkerRegistry, WorkerRegistryService};

pub use compose::Runtime;
pub use config::{
    load_dotenv, load_dotenv_at, load_profile, merge_profile, merge_profile_strict,
    resolve_api_key, resolve_base_url, resolve_profile, validate_model,
    Profile, DEFAULT_CONFIG, LEGACY_CONFIG, PROFILE_KEYS,
};
pub use run::TurnOutcome;
pub use summary::{summarize_turn, ToolCallRec, ToolResultRec, TurnSummary};
pub use tools::register_all_tools;

