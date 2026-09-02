
//! celestea-session — append-only session log (W102) + multi-session seams (W184).
//!
//! InMemorySessionLog is the single source of truth for a conversation:
//! it records SessionEvents in insertion order and derives the
//! model-visible history on demand via SessionLog::derive_messages.
//!
//! W184 adds two thread-safe seams for the built-in capabilities (worker
//! dispatch / inter-session messaging):
//!
//! - [SessionRegistry] — multi-session registry: create child sessions
//!   (each backed by an InMemorySessionLog), register / get / list them,
//!   and resolve a target (session id directly, or an exact title/workspace
//!   match — unique hit, candidate list on ambiguity, NotFound otherwise).
//! - [SessionMailbox] — per-session FIFO queues with a tokio wake-up
//!   signal: send(session_id, content, from_label) enqueues and wakes
//!   waiting consumers via tokio::sync::Notify; recv awaits the next
//!   message, poll / try_recv drain non-blockingly.

mod log;
mod mailbox;
mod registry;

pub use log::*;
pub use mailbox::*;
pub use registry::*;
