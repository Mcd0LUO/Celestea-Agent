//! celestea-session — append-only session log (W102) + multi-session seams (W184)
//! + v1 persistence (W210).
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
//!
//! W210 adds v1 persistence without touching the existing API:
//!
//! - [PersistentSessionLog] — drop-in SessionLog implementation backed by an
//!   append-only per-session JSONL event log (crash-safe: replay + validate +
//!   truncate torn tail; flush per append or batched; optional fsync).
//!   Recovery replays the file into the exact same derive_messages history.

mod log;
mod mailbox;
mod persistent;
mod registry;

pub use log::*;
pub use mailbox::*;
pub use persistent::*;
pub use registry::*;
