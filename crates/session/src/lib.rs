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

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use celestea_core::{Content, Message, Role, SessionEvent, SessionLog, ToolCall};
use tokio::sync::Notify;

/// An in-memory, append-only session log.
///
/// Thread-safe via interior mutability (RwLock<Vec<SessionEvent>>):
/// append/clear take the write lock, events/derive_messages take the read
/// lock. The log is the single source of truth; model history is always
/// derived from it, never stored separately.
#[derive(Debug, Default)]
pub struct InMemorySessionLog {
    events: RwLock<Vec<SessionEvent>>,
}

impl InMemorySessionLog {
    /// Create an empty session log.
    pub fn new() -> Self {
        Self { events: RwLock::new(Vec::new()) }
    }
}

impl SessionLog for InMemorySessionLog {
    fn append(&self, event: SessionEvent) {
        // A poisoned lock only happens after a panic while holding the write
        // lock; degrade gracefully by ignoring the append rather than
        // propagating the poison to the caller.
        if let Ok(mut events) = self.events.write() {
            events.push(event);
        }
    }

    fn events(&self) -> Vec<SessionEvent> {
        self.events.read().map(|g| g.clone()).unwrap_or_default()
    }

    fn derive_messages(&self) -> Vec<Message> {
        let mut messages = Vec::new();
        let mut pending: Vec<ToolCall> = Vec::new();

        for event in self.events() {
            match event {
                SessionEvent::ToolCall { id, name, args } => {
                    pending.push(ToolCall { id, name, args });
                }
                other => {
                    flush_tool_calls(&mut messages, &mut pending);
                    if let Some(msg) = project(other) {
                        messages.push(msg);
                    }
                }
            }
        }

        // Trailing tool calls (no following event) still need flushing.
        flush_tool_calls(&mut messages, &mut pending);
        messages
    }

    fn clear(&self) {
        if let Ok(mut events) = self.events.write() {
            events.clear();
        }
    }
}

/// Flush any accumulated tool calls as a single assistant message whose
/// content holds one Content::ToolCall per call. LLM protocols require all
/// tool_calls of a turn to ride in one assistant message, followed by the
/// individual tool results.
fn flush_tool_calls(messages: &mut Vec<Message>, pending: &mut Vec<ToolCall>) {
    if pending.is_empty() {
        return;
    }
    let calls = std::mem::take(pending);
    messages.push(Message {
        role: Role::Assistant,
        content: calls.into_iter().map(Content::ToolCall).collect(),
        tool_call_id: None,
    });
}

/// Project a single non-tool-call SessionEvent into its model-visible
/// Message form.
///
/// - UserMessage -> Message::user
/// - AssistantMessage -> Message::assistant_text
/// - ToolResult -> Message::tool_result: a non-empty error becomes
///   "Error: {error}", otherwise the value is JSON-serialized.
/// - TurnStart / TurnEnd -> skipped (structural markers, not model input).
///
/// ToolCall events never reach this function; they are accumulated and merged
/// by derive_messages, so the ToolCall arm is unreachable.
fn project(event: SessionEvent) -> Option<Message> {
    match event {
        SessionEvent::UserMessage { text } => Some(Message::user(text)),
        SessionEvent::AssistantMessage { text } => Some(Message::assistant_text(text)),
        SessionEvent::ToolResult { id, value, error } => {
            let text = match error {
                Some(err) if !err.is_empty() => format!("Error: {err}"),
                _ => serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string()),
            };
            Some(Message::tool_result(id, text))
        }
        SessionEvent::TurnStart { .. } | SessionEvent::TurnEnd { .. } => None,
        SessionEvent::ToolCall { .. } => {
            unreachable!("ToolCall must be accumulated by derive_messages, not projected")
        }
    }
}

// ============================================================================
// SessionRegistry — multi-session registry (W184, B1 seam)
// ============================================================================

/// A stable, unique session id. SessionRegistry::create generates ids of
/// the form session-<n>; register keeps whatever id the caller built.
pub type SessionId = String;

/// Public metadata describing a registered session. This is what list and
/// the candidate list of resolve expose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeta {
    pub id: SessionId,
    pub title: String,
    pub workspace: Option<String>,
    pub model: Option<String>,
}

/// A registered session: immutable metadata plus the session's append-only
/// log. log is shared (Arc) so the agent loop can drive it while the
/// registry keeps the authoritative handle.
#[derive(Debug)]
pub struct Session {
    pub meta: SessionMeta,
    pub log: Arc<InMemorySessionLog>,
    pub created_at: SystemTime,
}

impl Session {
    /// Build a session around an existing id/metadata. Used by register
    /// for externally constructed sessions.
    pub fn new(meta: SessionMeta) -> Self {
        Self { meta, log: Arc::new(InMemorySessionLog::new()), created_at: SystemTime::now() }
    }
}

/// Creation parameters for SessionRegistry::create. All fields optional
/// except title (callers may default it with ..Default::default()).
#[derive(Debug, Clone, Default)]
pub struct SessionSpec {
    pub title: String,
    pub workspace: Option<String>,
    pub model: Option<String>,
}

/// Error returned by SessionRegistry::register.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// A session with this id is already registered.
    DuplicateId(SessionId),
}

/// Error returned by SessionRegistry::resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// No session matches the target (neither an id nor a title/workspace).
    NotFound(String),
    /// More than one session matches the target by name; candidates carries
    /// the full metadata so the caller can pick one and retry by id.
    Ambiguous { target: String, candidates: Vec<SessionMeta> },
}

/// A thread-safe registry of sessions, keyed by session id.
///
/// Safe to share across threads and tasks (Send + Sync): all state lives
/// behind a RwLock, and id generation uses an atomic counter. Mirrors the
/// InMemorySessionLog robustness style: a poisoned lock is recovered with
/// into_inner rather than propagated.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: RwLock<HashMap<SessionId, Arc<Session>>>,
    next_id: AtomicU64,
}

impl SessionRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a child session with the given spec and register it. Returns a
    /// unique session id (session-<n>). The session's log is a fresh
    /// InMemorySessionLog.
    pub fn create(&self, spec: SessionSpec) -> SessionId {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("session-{n}");
        let session = Arc::new(Session::new(SessionMeta {
            id: id.clone(),
            title: spec.title,
            workspace: spec.workspace,
            model: spec.model,
        }));
        let mut guard = self.sessions.write().unwrap_or_else(|p| p.into_inner());
        guard.insert(id.clone(), session);
        id
    }

    /// Register an externally built session (e.g. one constructed with a
    /// caller-chosen id). Fails if the id is already taken.
    pub fn register(&self, session: Arc<Session>) -> Result<SessionId, RegistryError> {
        let id = session.meta.id.clone();
        let mut guard = self.sessions.write().unwrap_or_else(|p| p.into_inner());
        if guard.contains_key(&id) {
            return Err(RegistryError::DuplicateId(id));
        }
        guard.insert(id.clone(), session);
        Ok(id)
    }

    /// Look a session up by its exact id.
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        let guard = self.sessions.read().unwrap_or_else(|p| p.into_inner());
        guard.get(id).cloned()
    }

    /// Remove a session from the registry by id. Returns true if a session was
    /// actually present and removed. Dropping the caller-aliased [Arc<Session>]
    /// afterwards (if any) frees the session and its log; the registry holds no
    /// further reference, so repeated create+remove cycles do not grow memory
    /// (W188).
    pub fn remove(&self, id: &str) -> bool {
        let mut guard = self.sessions.write().unwrap_or_else(|p| p.into_inner());
        guard.remove(id).is_some()
    }

    /// Number of registered sessions.
    pub fn len(&self) -> usize {
        let guard = self.sessions.read().unwrap_or_else(|p| p.into_inner());
        guard.len()
    }

    /// Whether the registry has no sessions.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// All registered session metadata, sorted by id for determinism.
    pub fn list(&self) -> Vec<SessionMeta> {
        let guard = self.sessions.read().unwrap_or_else(|p| p.into_inner());
        let mut metas: Vec<SessionMeta> = guard.values().map(|s| s.meta.clone()).collect();
        metas.sort_by(|a, b| a.id.cmp(&b.id));
        metas
    }

    /// Resolve a target to a session.
    ///
    /// 1. If the target equals a registered session id, that session wins.
    /// 2. Otherwise the target is treated as a name: exact matches against
    ///    title and workspace. Exactly one match -> that session.
    ///    Multiple matches -> ResolveError::Ambiguous with the candidate
    ///    list. No match -> ResolveError::NotFound.
    pub fn resolve(&self, target: &str) -> Result<Arc<Session>, ResolveError> {
        let guard = self.sessions.read().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = guard.get(target) {
            return Ok(s.clone());
        }
        let matches: Vec<SessionMeta> = guard
            .values()
            .filter(|s| s.meta.title == target || s.meta.workspace.as_deref() == Some(target))
            .map(|s| s.meta.clone())
            .collect();
        match matches.len() {
            0 => Err(ResolveError::NotFound(target.to_string())),
            1 => {
                let id = &matches[0].id;
                Ok(guard.get(id).expect("candidate came from the registry").clone())
            }
            _ => Err(ResolveError::Ambiguous { target: target.to_string(), candidates: matches }),
        }
    }
}

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


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Extract the single text content of a message, panicking otherwise.
    fn text_of(msg: &Message) -> &str {
        match msg.content.as_slice() {
            [Content::Text(t)] => t,
            other => panic!("expected single text content, got {other:?}"),
        }
    }

    #[test]
    fn new_is_empty() {
        let log = InMemorySessionLog::new();
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
    }

    #[test]
    fn append_events_preserves_order() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "a".into() });
        log.append(SessionEvent::UserMessage { text: "b".into() });

        let events = log.events();
        assert_eq!(events.len(), 2);
        match &events[0] {
            SessionEvent::UserMessage { text } => assert_eq!(text, "a"),
            other => panic!("unexpected event {other:?}"),
        }
        match &events[1] {
            SessionEvent::UserMessage { text } => assert_eq!(text, "b"),
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[test]
    fn derive_messages_roundtrip() {
        let log = InMemorySessionLog::new();

        log.append(SessionEvent::TurnStart { id: "t1".into() });
        log.append(SessionEvent::UserMessage { text: "hello".into() });
        log.append(SessionEvent::AssistantMessage { text: "hi there".into() });
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/tmp/x" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "write_file".into(),
            args: json!({ "path": "/tmp/y", "content": "z" }),
        });
        log.append(SessionEvent::ToolResult {
            id: "c1".into(),
            value: Some(json!({ "ok": true })),
            error: None,
        });
        log.append(SessionEvent::ToolResult {
            id: "c2".into(),
            value: None,
            error: Some("boom".into()),
        });
        log.append(SessionEvent::TurnEnd { id: "t1".into() });

        let msgs = log.derive_messages();

        // TurnStart/TurnEnd skipped; two consecutive ToolCalls merge into one
        // assistant message, so: user, assistant, merged tool-calls, 2 results.
        assert_eq!(msgs.len(), 5);

        // UserMessage -> Message::user
        assert_eq!(msgs[0].role, Role::User);
        assert_eq!(text_of(&msgs[0]), "hello");
        assert!(msgs[0].tool_call_id.is_none());

        // AssistantMessage -> Message::assistant_text
        assert_eq!(msgs[1].role, Role::Assistant);
        assert_eq!(text_of(&msgs[1]), "hi there");
        assert!(msgs[1].tool_call_id.is_none());

        // Two ToolCalls -> ONE assistant message with two Content::ToolCall.
        assert_eq!(msgs[2].role, Role::Assistant);
        assert!(msgs[2].tool_call_id.is_none());
        assert_eq!(msgs[2].content.len(), 2);
        match &msgs[2].content[0] {
            Content::ToolCall(tc) => {
                assert_eq!(tc.id, "c1");
                assert_eq!(tc.name, "read_file");
                assert_eq!(tc.args, json!({ "path": "/tmp/x" }));
            }
            other => panic!("expected tool-call content, got {other:?}"),
        }
        match &msgs[2].content[1] {
            Content::ToolCall(tc) => {
                assert_eq!(tc.id, "c2");
                assert_eq!(tc.name, "write_file");
                assert_eq!(tc.args, json!({ "path": "/tmp/y", "content": "z" }));
            }
            other => panic!("expected tool-call content, got {other:?}"),
        }

        // ToolResult (value) -> JSON-serialized value text
        assert_eq!(msgs[3].role, Role::Tool);
        assert_eq!(msgs[3].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(text_of(&msgs[3]), r#"{"ok":true}"#);

        // ToolResult (error) -> "Error: {error}"
        assert_eq!(msgs[4].role, Role::Tool);
        assert_eq!(msgs[4].tool_call_id.as_deref(), Some("c2"));
        assert_eq!(text_of(&msgs[4]), "Error: boom");
    }

    #[test]
    fn consecutive_tool_calls_merge_into_single_message() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c1".into(),
            name: "read_file".into(),
            args: json!({ "path": "/a" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c2".into(),
            name: "read_file".into(),
            args: json!({ "path": "/b" }),
        });
        log.append(SessionEvent::ToolCall {
            id: "c3".into(),
            name: "read_file".into(),
            args: json!({ "path": "/c" }),
        });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 3);
        for (i, expected_id) in ["c1", "c2", "c3"].iter().enumerate() {
            match &msgs[0].content[i] {
                Content::ToolCall(tc) => assert_eq!(tc.id, *expected_id),
                other => panic!("expected tool-call content, got {other:?}"),
            }
        }
    }

    #[test]
    fn tool_calls_flush_before_following_non_tool_event() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolCall {
            id: "c9".into(),
            name: "list_dir".into(),
            args: json!({ "path": "/tmp" }),
        });
        log.append(SessionEvent::UserMessage { text: "after".into() });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::Assistant);
        assert_eq!(msgs[0].content.len(), 1);
        match &msgs[0].content[0] {
            Content::ToolCall(tc) => assert_eq!(tc.id, "c9"),
            other => panic!("expected tool-call content, got {other:?}"),
        }
        assert_eq!(msgs[1].role, Role::User);
        assert_eq!(text_of(&msgs[1]), "after");
    }

    #[test]
    fn tool_result_with_empty_error_falls_back_to_value() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::ToolResult {
            id: "c3".into(),
            value: Some(json!("fallback")),
            error: Some(String::new()),
        });

        let msgs = log.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(text_of(&msgs[0]), r#""fallback""#);
    }

    #[test]
    fn clear_empties_log() {
        let log = InMemorySessionLog::new();
        log.append(SessionEvent::UserMessage { text: "hello".into() });
        assert_eq!(log.events().len(), 1);

        log.clear();
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
    }

    #[test]
    fn log_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<InMemorySessionLog>();
    }
}
#[cfg(test)]
mod multi_session_tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    // --- SessionRegistry ---

    #[test]
    fn registry_create_get_roundtrip() {
        let reg = SessionRegistry::new();
        assert!(reg.is_empty());
        let id = reg.create(SessionSpec {
            title: "w101".into(),
            workspace: Some("/ws/proj".into()),
            model: Some("deepseek-chat".into()),
        });
        assert!(id.starts_with("session-"), "id {id} should have session- prefix");
        assert_eq!(reg.len(), 1);

        let s = reg.get(&id).expect("get by id returns the session");
        assert_eq!(s.meta.id, id);
        assert_eq!(s.meta.title, "w101");
        assert_eq!(s.meta.workspace.as_deref(), Some("/ws/proj"));
        assert_eq!(s.meta.model.as_deref(), Some("deepseek-chat"));

        assert!(reg.get("session-999999").is_none(), "unknown id -> None");
    }

    #[test]
    fn registry_create_generates_unique_ids() {
        let reg = SessionRegistry::new();
        let ids: Vec<String> = (0..50)
            .map(|i| reg.create(SessionSpec { title: format!("t{i}"), ..Default::default() }))
            .collect();
        let unique: HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), 50, "all generated ids must be unique");
    }

    #[test]
    fn registry_register_and_reject_duplicate() {
        let reg = SessionRegistry::new();
        let a = Arc::new(Session::new(SessionMeta {
            id: "custom-1".into(),
            title: "x".into(),
            workspace: None,
            model: None,
        }));
        assert_eq!(reg.register(Arc::clone(&a)).as_deref(), Ok("custom-1"));
        assert!(matches!(reg.register(a), Err(RegistryError::DuplicateId(_))));
        assert_eq!(reg.get("custom-1").expect("registered").meta.title, "x");
    }

    #[test]
    fn registry_resolve_by_id_direct() {
        let reg = SessionRegistry::new();
        let id = reg.create(SessionSpec { title: "unique".into(), ..Default::default() });
        let s = reg.resolve(&id).expect("id resolves directly");
        assert_eq!(s.meta.id, id);
    }

    #[test]
    fn registry_resolve_by_title_unique() {
        let reg = SessionRegistry::new();
        reg.create(SessionSpec { title: "alpha".into(), ..Default::default() });
        reg.create(SessionSpec { title: "beta".into(), ..Default::default() });
        let s = reg.resolve("alpha").expect("unique title resolves");
        assert_eq!(s.meta.title, "alpha");
    }

    #[test]
    fn registry_resolve_by_workspace() {
        let reg = SessionRegistry::new();
        reg.create(SessionSpec { title: "x".into(), workspace: Some("proj-a".into()), ..Default::default() });
        let s = reg.resolve("proj-a").expect("workspace resolves");
        assert_eq!(s.meta.workspace.as_deref(), Some("proj-a"));
    }

    #[test]
    fn registry_resolve_ambiguous_returns_candidates() {
        let reg = SessionRegistry::new();
        let id1 = reg.create(SessionSpec { title: "dup".into(), ..Default::default() });
        let id2 = reg.create(SessionSpec { title: "dup".into(), ..Default::default() });
        match reg.resolve("dup") {
            Err(ResolveError::Ambiguous { target, candidates }) => {
                assert_eq!(target, "dup");
                assert_eq!(candidates.len(), 2, "both sessions must be listed");
                let cand_ids: Vec<&String> = candidates.iter().map(|m| &m.id).collect();
                assert!(cand_ids.iter().any(|c| *c == &id1) && cand_ids.iter().any(|c| *c == &id2));
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn registry_resolve_miss_is_not_found() {
        let reg = SessionRegistry::new();
        reg.create(SessionSpec { title: "alpha".into(), ..Default::default() });
        assert!(matches!(reg.resolve("ghost"), Err(ResolveError::NotFound(t)) if t == "ghost"));
    }

    #[test]
    fn registry_list_returns_all_metas() {
        let reg = SessionRegistry::new();
        reg.create(SessionSpec { title: "b".into(), ..Default::default() });
        reg.create(SessionSpec { title: "a".into(), ..Default::default() });
        let metas = reg.list();
        assert_eq!(metas.len(), 2);
        assert!(metas.iter().any(|m| m.title == "a"));
        assert!(metas.iter().any(|m| m.title == "b"));
    }

    // --- SessionMailbox ---

    #[tokio::test]
    async fn mailbox_send_recv_fifo() {
        let mb = SessionMailbox::new();
        mb.send("s1", "first", "alice");
        mb.send("s1", "second", "bob");
        mb.send("s1", "third", "carol");
        assert_eq!(mb.pending("s1"), 3);

        let m1 = mb.recv("s1").await;
        assert_eq!(m1.content, "first");
        assert_eq!(m1.from_label, "alice");
        let m2 = mb.recv("s1").await;
        assert_eq!(m2.content, "second");
        let m3 = mb.recv("s1").await;
        assert_eq!(m3.content, "third");
        assert_eq!(mb.pending("s1"), 0);
        assert_eq!(mb.pending_total(), 0);
    }

    #[tokio::test]
    async fn mailbox_recv_wakes_on_send() {
        let mb = SessionMailbox::new();
        let mb2 = mb.clone();
        let task = tokio::spawn(async move { mb2.recv("s-wake").await });
        // Let the consumer register its waiter before we send.
        tokio::task::yield_now().await;
        let sent = mb.send("s-wake", "hello", "coordinator");
        let got = task.await.expect("consumer task must finish");
        assert_eq!(got.id, sent.id);
        assert_eq!(got.content, "hello");
        assert_eq!(got.from_label, "coordinator");
    }

    #[test]
    fn mailbox_try_recv_and_poll_non_blocking() {
        let mb = SessionMailbox::new();
        assert!(mb.try_recv("s1").is_none(), "empty queue -> None");
        assert!(mb.poll("s1").is_empty(), "empty queue -> no drain");

        mb.send("s1", "a", "x");
        mb.send("s1", "b", "y");
        assert_eq!(mb.try_recv("s1").expect("one queued").content, "a");
        let drained = mb.poll("s1");
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].content, "b");
        assert_eq!(mb.pending("s1"), 0);
        assert_eq!(mb.pending_total(), 0);
    }

    #[test]
    fn mailbox_unknown_session_send_stays_queued() {
        let mb = SessionMailbox::new();
        mb.send("ghost", "ping", "anyone");
        // Enqueued for a session with no consumer: still queued ("入队不保证被消费").
        assert_eq!(mb.pending("ghost"), 1);
        assert_eq!(mb.pending_total(), 1);
    }

    #[test]
    fn mailbox_concurrent_sends_from_threads() {
        let mb = SessionMailbox::new();
        let mut handles = Vec::new();
        for t in 0..8 {
            let mb = mb.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..100 {
                    mb.send("s-conc", format!("t{t}-{i}"), "thread");
                }
            }));
        }
        for h in handles {
            h.join().expect("sender thread joins");
        }
        assert_eq!(mb.pending("s-conc"), 800, "all 800 sends must be queued");
    }

    // --- Send + Sync compile-time assertions ---

    #[test]
    fn multi_session_types_are_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SessionRegistry>();
        assert_send_sync::<Session>();
        assert_send_sync::<SessionMeta>();
        assert_send_sync::<SessionMailbox>();
        assert_send_sync::<MailboxMessage>();
        // Coexistence: the existing single-session type remains Send + Sync.
        assert_send_sync::<InMemorySessionLog>();
    }

    // --- Coexistence with the existing InMemorySessionLog ---

    #[test]
    fn registered_session_log_works_within_registry() {
        let reg = SessionRegistry::new();
        let id = reg.create(SessionSpec { title: "child".into(), ..Default::default() });
        let s = reg.get(&id).unwrap();
        s.log.append(SessionEvent::UserMessage { text: "ping".into() });
        let msgs = s.log.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::User);
    }

    // --- W188: 压力 / 无泄漏 测试 ----------------------------------------

    #[test]
    fn stress_registry_mass_create_remove_returns_to_zero() {
        let reg = SessionRegistry::new();
        const N: usize = 20_000;
        for i in 0..N {
            reg.create(SessionSpec { title: format!("s{i}"), ..Default::default() });
        }
        assert_eq!(reg.len(), N, "all sessions registered");
        for i in 0..N {
            assert!(reg.remove(&format!("session-{i}")), "remove session-{i}");
        }
        assert_eq!(reg.len(), 0, "registry fully drained after mass removal");
        assert!(reg.is_empty());
    }

    #[test]
    fn stress_registry_no_arc_cycle_left_behind() {
        // Every session must become fully droppable once removed from the
        // registry: hold a Weak, remove the strong Arc out of the registry, drop
        // the last strong handle, and verify the Weak is dead -> no cycle.
        let reg = SessionRegistry::new();
        let mut weaks = Vec::new();
        const N: usize = 5_000;
        for i in 0..N {
            let id = reg.create(SessionSpec { title: format!("c{i}"), ..Default::default() });
            let arc = reg.get(&id).expect("present");
            weaks.push(Arc::downgrade(&arc));
            drop(arc);
        }
        // All sessions still registered -> strong refs kept alive by registry.
        for w in &weaks {
            assert!(w.upgrade().is_some(), "still registered, Weak must be alive");
        }
        // Remove all -> drop the registry's strong handles.
        for i in 0..N {
            assert!(reg.remove(&format!("session-{i}")));
        }
        // No external strong refs remain; every Weak must be dead -> no cycle.
        for (i, w) in weaks.iter().enumerate() {
            assert!(w.upgrade().is_none(), "session session-{i} leaked (Arc cycle)");
        }
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn stress_mailbox_send_recv_all_consumed_pending_zero() {
        let mb = SessionMailbox::new();
        const N: usize = 20_000;
        for i in 0..N {
            mb.send("sig", format!("m{i}"), "gen");
        }
        assert_eq!(mb.pending("sig"), N);
        assert_eq!(mb.pending_total(), N);
        for i in 0..N {
            let m = mb.try_recv("sig").expect("msg present");
            assert_eq!(m.content, format!("m{i}"));
        }
        assert_eq!(mb.pending("sig"), 0);
        assert_eq!(mb.pending_total(), 0, "all messages consumed -> count back to zero");
    }

    #[test]
    fn stress_mailbox_distinct_sessions_purge_clears_keys() {
        let mb = SessionMailbox::new();
        const N: usize = 5_000;
        for i in 0..N {
            mb.send(format!("s-{i}"), "hi", "gen");
            mb.purge(&format!("s-{i}"));
        }
        // purge removes the queue key entirely (not just empties the deque).
        assert_eq!(mb.pending_total(), 0);
        // Sending again to a purged session starts fresh and is consumable.
        mb.send("s-0", "again", "gen");
        assert_eq!(mb.pending("s-0"), 1);
        assert_eq!(mb.try_recv("s-0").expect("fresh").content, "again");
        assert_eq!(mb.pending_total(), 0);
    }

    // --- W188: 简单基准 (std::time::Instant, 输出到测试日志) ---------------

    #[test]
    fn bench_derive_messages_throughput() {
        let log = InMemorySessionLog::new();
        for i in 0..200 {
            log.append(SessionEvent::UserMessage { text: format!("user line {i}") });
            log.append(SessionEvent::AssistantMessage { text: format!("assistant reply {i}") });
        }
        // Warm up, then measure.
        let _ = log.derive_messages();
        const ITERS: usize = 2_000;
        let t0 = std::time::Instant::now();
        let mut total_msgs = 0usize;
        for _ in 0..ITERS {
            total_msgs += log.derive_messages().len();
        }
        let dur = t0.elapsed();
        let log_size = log.events().len();
        let per_sec = (ITERS as f64 / dur.as_secs_f64()).round();
        eprintln!(
            "[bench] derive_messages: log_size={log_size} iters={ITERS} {:?} -> {per_sec}/s (msgs/turn avg {})",
            dur, if ITERS > 0 { total_msgs / ITERS } else { 0 }
        );
        assert!(dur.as_secs_f64() < 30.0, "benchmark must not stall the suite");
    }

    #[test]
    fn bench_registry_resolve_throughput() {
        let reg = SessionRegistry::new();
        for i in 0..500 {
            reg.create(SessionSpec { title: format!("w{i}"), ..Default::default() });
        }
        // Warm, then measure resolve-by-id.
        let _ = reg.resolve("session-499");
        const ITERS: usize = 20_000;
        let tp = format!("session-{}", 250);
        let t0 = std::time::Instant::now();
        for _ in 0..ITERS {
            assert!(reg.resolve(&tp).is_ok());
        }
        let dur = t0.elapsed();
        let per_sec = (ITERS as f64 / dur.as_secs_f64()).round();
        eprintln!(
            "[bench] registry.resolve(id): sessions=500 iters={ITERS} {:?} -> {per_sec}/s",
            dur
        );
        assert!(dur.as_secs_f64() < 30.0, "benchmark must not stall the suite");
    }
}

