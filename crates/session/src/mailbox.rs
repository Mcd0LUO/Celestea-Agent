
//! celestea-session mailbox — per-session FIFO queues + wake notification
//! (W184, B2 seam).
//!
//! [SessionMailbox] provides per-session FIFO queues with a tokio wake-up
//! signal: send(session_id, content, from_label) enqueues and wakes waiting
//! consumers via tokio::sync::Notify; recv awaits the next message, poll /
//! try_recv drain non-blockingly.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use crate::registry::SessionId;
use tokio::sync::Notify;

// ============================================================================
// SessionMailbox — per-session FIFO queues + wake notification (W184, B2 seam)
// ============================================================================

/// One message in a session's mailbox queue.
#[derive(Debug, Clone)]
pub struct MailboxMessage {
    /// Monotonically increasing mailbox-wide message id (ordering aid).
    pub id: u64,
    /// The message body; a target session consumes it as a user turn.
    pub content: String,
    /// Human/agent label of the sender (attached for provenance).
    pub from_label: String,
    /// When the message was enqueued.
    pub sent_at: SystemTime,
}

/// A thread-safe, per-session FIFO mailbox with a tokio wake-up signal.
///
/// send(session_id, content, from_label) enqueues a message into that
/// session's queue and wakes waiting consumers via tokio::sync::Notify
/// (notify_waiters — every registered waiter re-checks its own queue, so a
/// message for session A can never be swallowed by a waiter of session B).
/// recv awaits the next message (blocking), try_recv / poll drain
/// non-blockingly.
///
/// Queues are created lazily on first send; sending to a session that has
/// no consumer is allowed and the message stays queued (enqueued, delivery
/// not guaranteed — the B2 design's "入队不保证被消费"). Cloning shares the
/// same queues, notify and id counter.
#[derive(Debug)]
pub struct SessionMailbox {
    inner: Arc<MailboxInner>,
}

#[derive(Debug)]
struct MailboxInner {
    queues: RwLock<HashMap<SessionId, VecDeque<MailboxMessage>>>,
    notify: Notify,
    next_msg_id: AtomicU64,
}

impl Clone for SessionMailbox {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

impl SessionMailbox {
    /// Create an empty mailbox.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MailboxInner {
                queues: RwLock::new(HashMap::new()),
                notify: Notify::new(),
                next_msg_id: AtomicU64::new(0),
            }),
        }
    }

    /// Enqueue a message for session_id and wake any waiting consumers.
    /// Returns the enqueued message (with its id) for the caller's reference.
    pub fn send(
        &self,
        session_id: impl Into<String>,
        content: impl Into<String>,
        from_label: impl Into<String>,
    ) -> MailboxMessage {
        let msg = MailboxMessage {
            id: self.inner.next_msg_id.fetch_add(1, Ordering::Relaxed),
            content: content.into(),
            from_label: from_label.into(),
            sent_at: SystemTime::now(),
        };
        let session_id = session_id.into();
        let mut guard = self.inner.queues.write().unwrap_or_else(|p| p.into_inner());
        guard.entry(session_id).or_default().push_back(msg.clone());
        drop(guard);
        self.inner.notify.notify_waiters();
        msg
    }

    /// Wait for the next message for session_id (FIFO order).
    ///
    /// Race-free against send: the wake future is created before the queue
    /// is re-checked, so an enqueue that lands between the check and the
    /// wait is never lost.
    pub async fn recv(&self, session_id: &str) -> MailboxMessage {
        loop {
            let notified = self.inner.notify.notified();
            if let Some(msg) = self.try_recv(session_id) {
                return msg;
            }
            notified.await;
        }
    }

    /// Non-blocking pop of the next queued message for session_id.
    pub fn try_recv(&self, session_id: &str) -> Option<MailboxMessage> {
        let mut guard = self.inner.queues.write().unwrap_or_else(|p| p.into_inner());
        guard.get_mut(session_id).and_then(|q| q.pop_front())
    }

    /// Non-blocking drain of every currently queued message for session_id,
    /// in FIFO order.
    pub fn poll(&self, session_id: &str) -> Vec<MailboxMessage> {
        let mut guard = self.inner.queues.write().unwrap_or_else(|p| p.into_inner());
        guard.get_mut(session_id).map(|q| q.drain(..).collect()).unwrap_or_default()
    }

    /// Drop the queue entry for session_id entirely, discarding any still-queued
    /// messages and the (possibly empty) key. Used so that removing a session
    /// from the [SessionRegistry] can also release its mailbox state instead of
    /// leaving the queue key behind (W188).
    pub fn purge(&self, session_id: &str) {
        let mut guard = self.inner.queues.write().unwrap_or_else(|p| p.into_inner());
        guard.remove(session_id);
    }

    /// Number of messages currently queued for session_id.
    pub fn pending(&self, session_id: &str) -> usize {
        let guard = self.inner.queues.read().unwrap_or_else(|p| p.into_inner());
        guard.get(session_id).map(|q| q.len()).unwrap_or(0)
    }

    /// Number of messages queued across all sessions.
    pub fn pending_total(&self) -> usize {
        let guard = self.inner.queues.read().unwrap_or_else(|p| p.into_inner());
        guard.values().map(|q| q.len()).sum()
    }
}
