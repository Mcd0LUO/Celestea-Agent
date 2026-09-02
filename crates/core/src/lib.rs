//! # celestea-core
//!
//! The "everything is a plugin" spine. This crate pins the seams (service
//! definitions): a TypeId-keyed service container, a plugin trait, a typed
//! event bus (broadcast on/emit, intercept bail/run_bail, transform
//! waterfall/run_waterfall), and the Llm / SessionLog / Tool / AgentLoop traits. Concrete
//! providers live in sibling crates and are plugged in at compose time.
//!
//! Organization: each seam lives in its own module; this crate root only
//! re-exports the public API (`pub use`). See the individual modules for how
//! each service definition crosses crates.

mod context;
mod plugin;
mod registry;
mod event_bus;
mod message;
mod llm;
mod session_log;
mod tool;
mod agent;

pub use context::Context;
pub use plugin::Plugin;
pub use registry::NamedRegistry;
pub use event_bus::EventBus;
pub use message::{Content, LlmError, LlmStream, Message, ModelRequest, Role, StreamEvent, ToolCall, ToolSpec};
pub use llm::{Llm, LlmRegistry, LlmRegistryService, LlmService};
pub use session_log::{SessionEvent, SessionLog, SessionService};
pub use tool::{Tool, ToolDecision, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolRegistryService};
pub use agent::{AgentConfig, AgentError, AgentLoop, AgentLoopService};
