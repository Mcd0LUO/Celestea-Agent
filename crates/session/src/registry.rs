
//! celestea-session registry — the multi-session registry (W184).
//!
//! [SessionRegistry] creates child sessions (each backed by an
//! [crate::InMemorySessionLog]), registers / gets / lists them, and resolves
//! a target (session id directly, or an exact title/workspace match — unique
//! hit, candidate list on ambiguity, NotFound otherwise).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use crate::log::InMemorySessionLog;

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

#[cfg(test)]
mod multi_session_tests {
    use super::*;
    use crate::log::InMemorySessionLog;
    use crate::mailbox::{MailboxMessage, SessionMailbox};
    use celestea_core::{Role, SessionEvent, SessionLog};
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
