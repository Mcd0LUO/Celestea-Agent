//! celestea-session v1 persistence — append-only JSONL session log (W210).
//!
//! [PersistentSessionLog] is a drop-in [SessionLog] implementation: every
//! appended event is mirrored to disk as one JSON line in a per-session
//! append-only file (<dir>/<sanitized-session-id>.jsonl, e.g.
//! ~/.celestea/sessions/session-0.jsonl) while the exact in-memory semantics
//! of [crate::InMemorySessionLog] (insertion order + the shared
//! derive_messages projection) are preserved.
//!
//! # Crash safety (v1)
//! - one record == one JSON line (serde_json tagged SessionEvent), buffered
//!   append write;
//! - on open the file is replayed and validated: the longest valid prefix is
//!   kept and everything from the first unparsable record (typically a torn
//!   tail left by a crash mid-write) is truncated away — a half record is
//!   never replayed;
//! - [PersistentSessionLog::flush] / [PersistentSessionLog::sync] are explicit
//!   durability points (process-crash vs power-loss); Drop flushes best-effort
//!   ("关闭时 flush");
//! - default flush_each_append = true: no record is lost on a process crash.
//!
//! # Failure model
//! The log stays usable if a disk write fails: the event remains in the
//! in-memory view (derive_messages keeps working), the failure is counted
//! ([PersistentSessionLog::write_error_count]) and warned on stderr. Only
//! open / replay / flush / sync surface errors to the caller.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use celestea_core::{Message, SessionEvent, SessionLog};

use crate::log::derive_messages_from;

/// Control knobs for [PersistentSessionLog].
#[derive(Debug, Clone, Copy)]
pub struct PersistentOptions {
    /// Flush buffered bytes to the OS after every appended record (default:
    /// true) so a process crash cannot lose a record. Set to false to batch
    /// writes and call [PersistentSessionLog::flush] periodically instead
    /// ("定期 flush").
    pub flush_each_append: bool,
    /// sync_data after every appended record (default: false). Enable when
    /// records must survive power loss too, not just a process crash.
    pub sync_each_append: bool,
}

impl Default for PersistentOptions {
    fn default() -> Self {
        Self { flush_each_append: true, sync_each_append: false }
    }
}

/// Errors surfaced by the persistence paths that can fail (open / replay /
/// flush / sync).
///
/// Append-path failures are deliberately NOT an error: [SessionLog::append]
/// has no result channel, and the log degrades gracefully (the in-memory view
/// stays consistent, the failure is counted via
/// [PersistentSessionLog::write_error_count]).
#[derive(Debug)]
pub enum PersistError {
    /// Underlying filesystem error.
    Io(std::io::Error),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistError::Io(e) => write!(f, "session persistence IO error: {e}"),
        }
    }
}

impl std::error::Error for PersistError {}

impl From<std::io::Error> for PersistError {
    fn from(e: std::io::Error) -> Self {
        PersistError::Io(e)
    }
}

/// An append-only, crash-safe session log backed by a per-session JSONL file.
///
/// open / open_with create the directory (if needed) and REPLAY any existing
/// records into the in-memory view, so a restart reconstructs the same
/// [SessionLog::derive_messages] history. session_id names the file
/// (sanitized: only [A-Za-z0-9._-] survive, so no path traversal).
///
/// Thread-safe (Send + Sync): appends take the event write lock, so the
/// on-disk order always equals the in-memory order, and readers see events
/// only after they are durably queued (lock order: events, then writer).
#[derive(Debug)]
pub struct PersistentSessionLog {
    events: RwLock<Vec<SessionEvent>>,
    writer: RwLock<Option<BufWriter<File>>>,
    path: PathBuf,
    opts: PersistentOptions,
    write_errors: AtomicU64,
}

impl PersistentSessionLog {
    /// Open the append-only log for session_id under dir (default options).
    pub fn open(dir: impl AsRef<Path>, session_id: &str) -> Result<Self, PersistError> {
        Self::open_with(dir, session_id, PersistentOptions::default())
    }

    /// Open with explicit [PersistentOptions].
    pub fn open_with(
        dir: impl AsRef<Path>,
        session_id: &str,
        opts: PersistentOptions,
    ) -> Result<Self, PersistError> {
        let dir = dir.as_ref();
        fs::create_dir_all(dir)?;
        let path = file_path(dir, session_id);

        // Replay + validate. The longest valid prefix wins; everything from
        // the first unparsable record (torn tail after a crash) is truncated.
        let (events, valid_bytes, truncated) = replay(&path)?;
        if truncated {
            let f = OpenOptions::new().write(true).open(&path)?;
            f.set_len(valid_bytes)?;
            let _ = f.sync_all();
        }

        // Repair a missing final newline BEFORE appending: the writer always
        // terminates records, so only hand-crafted/corrupt files end without
        // one — and without this separator the next record would merge with
        // the last one into a single (unparsable) line.
        let lacks_final_newline = file_lacks_final_newline(&path);
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        if lacks_final_newline {
            // O_APPEND writes at EOF regardless of the cursor position.
            file.write_all(b"\n")?;
        }
        Ok(Self {
            events: RwLock::new(events),
            writer: RwLock::new(Some(BufWriter::new(file))),
            path,
            opts,
            write_errors: AtomicU64::new(0),
        })
    }

    /// The JSONL file backing this log.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Flush buffered records to the OS (no-op when nothing is pending).
    /// Returns an error instead of degrading, so the caller can decide.
    pub fn flush(&self) -> Result<(), PersistError> {
        let mut guard = self.writer.write().unwrap_or_else(|p| p.into_inner());
        if let Some(w) = guard.as_mut() {
            w.flush()?;
        }
        Ok(())
    }

    /// Flush and sync_data so buffered records survive power loss.
    pub fn sync(&self) -> Result<(), PersistError> {
        let mut guard = self.writer.write().unwrap_or_else(|p| p.into_inner());
        if let Some(w) = guard.as_mut() {
            w.flush()?;
            w.get_ref().sync_data()?;
        }
        Ok(())
    }

    /// How many append-path write failures were recorded (degraded mode: the
    /// event stayed usable in memory but was not durably written).
    pub fn write_error_count(&self) -> u64 {
        self.write_errors.load(Ordering::Relaxed)
    }
}

impl SessionLog for PersistentSessionLog {
    fn append(&self, event: SessionEvent) {
        // Lock order (events -> writer) is the same in append and clear, so
        // no deadlock is possible. The event write lock is held across the
        // disk write: readers never see an event before it is durably queued.
        let mut events_guard = self.events.write().unwrap_or_else(|p| p.into_inner());

        let mut persisted = false;
        match serde_json::to_string(&event) {
            Ok(line) => {
                let mut writer_guard = self.writer.write().unwrap_or_else(|p| p.into_inner());
                if let Some(w) = writer_guard.as_mut() {
                    let res = w.write_all(line.as_bytes()).and_then(|_| w.write_all(b"\n"));
                    let res = if self.opts.flush_each_append {
                        res.and_then(|_| w.flush())
                    } else {
                        res
                    };
                    let res = if self.opts.sync_each_append {
                        res.and_then(|_| w.get_ref().sync_data())
                    } else {
                        res
                    };
                    persisted = res.is_ok();
                }
            }
            Err(e) => {
                // SessionEvent is always serializable in practice; guard anyway.
                eprintln!(
                    "[celestea-session] cannot serialize event ({e}) for {}",
                    self.path.display()
                );
            }
        }
        if !persisted {
            self.write_errors.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "[celestea-session] append not persisted to {} (write_error_count={}); kept in memory only",
                self.path.display(),
                self.write_error_count()
            );
        }
        // The in-memory view is the source of truth for derive_messages: keep
        // the event even when the disk path failed (graceful degradation).
        events_guard.push(event);
    }

    fn events(&self) -> Vec<SessionEvent> {
        self.events.read().map(|g| g.clone()).unwrap_or_default()
    }

    fn derive_messages(&self) -> Vec<Message> {
        derive_messages_from(&self.events())
    }

    fn clear(&self) {
        let mut events_guard = self.events.write().unwrap_or_else(|p| p.into_inner());
        let mut writer_guard = self.writer.write().unwrap_or_else(|p| p.into_inner());
        // Dropping the BufWriter flushes pending bytes BEFORE truncation, so
        // stale buffered records can never be rewritten after set_len(0).
        let old = writer_guard.take();
        drop(old);
        match File::create(&self.path) {
            Ok(f) => *writer_guard = Some(BufWriter::new(f)),
            Err(e) => {
                self.write_errors.fetch_add(1, Ordering::Relaxed);
                eprintln!("[celestea-session] clear failed for {}: {e}", self.path.display());
            }
        }
        events_guard.clear();
    }
}

impl Drop for PersistentSessionLog {
    fn drop(&mut self) {
        // "关闭时 flush": best-effort — the last handle's drop flushes any
        // buffered records to the OS.
        if let Ok(writer) = self.writer.get_mut() {
            if let Some(w) = writer.as_mut() {
                let _ = w.flush();
            }
        }
    }
}

/// Map a session id to a safe file name. Every character outside
/// [A-Za-z0-9._-] is replaced with an underscore, so a caller-supplied id
/// can never escape dir (no path traversal); the result is never empty and
/// always ends in .jsonl.
pub fn file_name_for(session_id: &str) -> String {
    let mut name: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }
        })
        .collect();
    if name.is_empty() {
        name.push_str("session");
    }
    name.push_str(".jsonl");
    name
}

/// The JSONL path that open / open_with use for session_id under dir.
pub fn file_path(dir: impl AsRef<Path>, session_id: &str) -> PathBuf {
    dir.as_ref().join(file_name_for(session_id))
}

/// True when path exists, is non-empty and its last byte is not a newline —
/// i.e. the final record is not terminated and the next append would merge
/// with it. Only hand-crafted/corrupt files can be in this state.
fn file_lacks_final_newline(path: &Path) -> bool {
    let Ok(mut f) = File::open(path) else { return false };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return false };
    if len == 0 {
        return false;
    }
    if f.seek(std::io::SeekFrom::End(-1)).is_err() {
        return false;
    }
    let mut last = [0u8; 1];
    f.read_exact(&mut last).is_ok() && last[0] != b'\n'
}

/// Replay path line by line.
///
/// Returns (events, valid_bytes, truncated): events are the valid records of
/// the longest valid prefix, valid_bytes is the byte length of that prefix,
/// and truncated is true when an unparsable record was found right after it
/// (torn tail / corruption) and the caller should truncate the file.
fn replay(path: &Path) -> Result<(Vec<SessionEvent>, u64, bool), PersistError> {
    let mut events: Vec<SessionEvent> = Vec::new();
    if !path.exists() {
        return Ok((events, 0, false));
    }
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut offset: u64 = 0;
    let mut valid_bytes: u64 = 0;
    let mut truncated = false;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        let start = offset;
        offset += n as u64;
        let record = trim_line_end(&line);
        if record.is_empty() {
            // Blank line: harmless padding; part of the valid region.
            valid_bytes = offset;
            continue;
        }
        match serde_json::from_slice::<SessionEvent>(record) {
            Ok(event) => {
                events.push(event);
                valid_bytes = offset;
            }
            Err(e) => {
                truncated = true;
                eprintln!(
                    "[celestea-session] replay: unparsable record at {start}-{offset} in {} ({e}); truncating to {valid_bytes} bytes",
                    path.display()
                );
                break;
            }
        }
    }
    Ok((events, valid_bytes, truncated))
}

/// Strip a trailing newline and optional carriage return from a raw line.
fn trim_line_end(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    if end > 0 && line[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && line[end - 1] == b'\r' {
        end -= 1;
    }
    &line[..end]
}

#[cfg(test)]
mod persistent_tests {
    use super::*;
    use crate::log::InMemorySessionLog;
    use celestea_core::{Message, Role};
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering as AtomOrdering};
    use std::sync::Arc;

    static DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    /// Unique temp dir per test instance; removed on drop. (No tempfile
    /// dependency: hand-rolled for one test crate.)
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = DIR_SEQ.fetch_add(1, AtomOrdering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "celestea-session-{tag}-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&p).expect("create temp dir");
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Compact JSON view of a message (Message itself is not Serialize;
    /// Role/Content are), used to compare projected histories exactly.
    fn msg_value(m: &Message) -> serde_json::Value {
        serde_json::json!({
            "role": serde_json::to_value(m.role).expect("role serializes"),
            "content": serde_json::to_value(&m.content).expect("content serializes"),
            "tool_call_id": m.tool_call_id,
        })
    }

    fn msg_values(msgs: &[Message]) -> Vec<serde_json::Value> {
        msgs.iter().map(msg_value).collect()
    }

    /// A conversation covering every event kind plus the tool-call merge path.
    fn sample_events() -> Vec<SessionEvent> {
        vec![
            SessionEvent::TurnStart { id: "t1".into() },
            SessionEvent::UserMessage { text: "hello".into() },
            SessionEvent::AssistantMessage { text: "hi there".into() },
            SessionEvent::ToolCall { id: "c1".into(), name: "read_file".into(), args: json!({ "path": "/tmp/x" }) },
            SessionEvent::ToolCall { id: "c2".into(), name: "write_file".into(), args: json!({ "path": "/tmp/y", "content": "z" }) },
            SessionEvent::ToolResult { id: "c1".into(), value: Some(json!({ "ok": true })), error: None },
            SessionEvent::ToolResult { id: "c2".into(), value: None, error: Some("boom".into()) },
            SessionEvent::TurnEnd { id: "t1".into() },
        ]
    }

    #[test]
    fn persistent_open_creates_file_and_is_empty() {
        let dir = TempDir::new("empty");
        let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open");
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
        assert_eq!(log.path().file_name().and_then(|n| n.to_str()), Some("s1.jsonl"));
        assert!(log.path().is_file());
        assert_eq!(log.write_error_count(), 0);
        log.flush().expect("flush on empty");
        log.sync().expect("sync on empty");
        // Reopening an existing (empty) file is a no-op replay.
        drop(log);
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert!(log2.events().is_empty());
        assert_eq!(log2.write_error_count(), 0);
    }

    #[test]
    fn persistent_append_persists_and_reload_replays_same_history() {
        let dir = TempDir::new("roundtrip");
        let path;
        let before_msgs;
        let before_events_json;
        {
            let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open");
            for e in sample_events() {
                log.append(e);
            }
            assert_eq!(log.write_error_count(), 0);
            assert_eq!(log.events().len(), 8);
            // TurnStart/TurnEnd skipped + 2 consecutive ToolCalls merged -> 5.
            before_msgs = msg_values(&log.derive_messages());
            before_events_json = serde_json::to_string(&log.events()).expect("events json");
            assert_eq!(before_msgs.len(), 5);
            path = log.path().to_path_buf();
        } // drop => close-time flush (already flushed per append anyway)

        // One parseable JSON line per event, in append order.
        let text = fs::read_to_string(&path).expect("read back");
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 8, "one line per event: {text}");
        for l in &lines {
            serde_json::from_str::<SessionEvent>(l).expect("each line is a valid record");
        }
        // Restart: replay reconstructs the same events and the SAME projection.
        let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log.events().len(), 8);
        assert_eq!(serde_json::to_string(&log.events()).unwrap(), before_events_json);
        assert_eq!(msg_values(&log.derive_messages()), before_msgs);
        assert_eq!(log.write_error_count(), 0);
        // derive_messages correctness spot check (same semantics as W102).
        let msgs = log.derive_messages();
        assert_eq!(msgs[0].role, Role::User);
        assert_eq!(msgs[2].content.len(), 2, "two tool calls merged");
    }

    #[test]
    fn persistent_recovery_truncates_torn_tail() {
        let dir = TempDir::new("torn");
        let path;
        {
            let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open");
            log.append(SessionEvent::UserMessage { text: "good".into() });
            path = log.path().to_path_buf();
        }
        // Simulate a crash mid-write: a torn record (truncated JSON + newline).
        {
            let mut f = OpenOptions::new().append(true).open(&path).expect("append");
            f.write_all(br#"{"type":"user_message","tex"#).expect("torn write");
            f.write_all(b"\n").expect("torn newline");
            f.sync_all().expect("sync");
        }
        let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("recover");
        assert_eq!(log.events().len(), 1, "torn record must not be replayed");
        match &log.events()[0] {
            SessionEvent::UserMessage { text } => assert_eq!(text, "good"),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(log.write_error_count(), 0);
        // The file was truncated back to exactly the last valid record.
        let good = serde_json::to_string(&SessionEvent::UserMessage { text: "good".into() }).unwrap();
        let rest = fs::read_to_string(&path).expect("file");
        assert_eq!(rest, format!("{good}\n"), "exactly the valid record survives, torn bytes removed");
        // The log keeps working after recovery.
        log.append(SessionEvent::AssistantMessage { text: "after".into() });
        drop(log);
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log2.derive_messages().len(), 2);
    }

    #[test]
    fn persistent_recovery_keeps_longest_valid_prefix_on_middle_corruption() {
        let dir = TempDir::new("prefix");
        let path = file_path(dir.0.as_path(), "x");
        {
            let mut f = fs::File::create(&path).expect("create");
            f.write_all(br#"{"type":"user_message","text":"one"}"#).unwrap();
            f.write_all(b"\n").unwrap();
            f.write_all(br#"{"type":"user_message","tex"#).unwrap(); // corrupt middle record
            f.write_all(b"\n").unwrap();
            f.write_all(br#"{"type":"user_message","text":"three"}"#).unwrap();
            f.write_all(b"\n").unwrap();
            f.sync_all().unwrap();
        }
        let log = PersistentSessionLog::open(dir.0.as_path(), "x").expect("recover");
        assert_eq!(log.events().len(), 1, "only the longest valid prefix is kept");
        // File truncated at the first bad record.
        let rest = fs::read_to_string(&path).expect("file");
        assert_eq!(rest.lines().filter(|l| !l.is_empty()).count(), 1, "file truncated: {rest}");
        assert!(!rest.contains("three"), "corruption beyond the prefix removed");
    }

    #[test]
    fn persistent_clear_truncates_file_and_restarts_clean() {
        let dir = TempDir::new("clear");
        let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open");
        log.append(SessionEvent::UserMessage { text: "x".into() });
        log.append(SessionEvent::AssistantMessage { text: "y".into() });
        assert_eq!(log.events().len(), 2);
        log.clear();
        assert!(log.events().is_empty());
        assert!(log.derive_messages().is_empty());
        assert_eq!(fs::metadata(log.path()).expect("meta").len(), 0, "file truncated");
        // Clear must not break future persistence.
        log.append(SessionEvent::UserMessage { text: "post".into() });
        assert_eq!(log.write_error_count(), 0);
        drop(log);
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log2.events().len(), 1);
        let msgs = log2.derive_messages();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].role, Role::User);
    }

    #[test]
    fn persistent_batched_appends_visible_after_flush() {
        let dir = TempDir::new("batch");
        let opts = PersistentOptions { flush_each_append: false, sync_each_append: false };
        let log = PersistentSessionLog::open_with(dir.0.as_path(), "s1", opts).expect("open");
        log.append(SessionEvent::UserMessage { text: "buffered".into() });
        // Everything is in-memory immediately...
        assert_eq!(log.events().len(), 1);
        // ...and on disk after an explicit flush (periodic-flush contract).
        log.flush().expect("flush");
        let text = fs::read_to_string(log.path()).expect("file");
        assert!(text.contains("\"buffered\""), "flushed record on disk: {text}");
        // A reload sees it too.
        drop(log);
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log2.derive_messages().len(), 1);
    }

    #[test]
    fn persistent_derive_messages_matches_in_memory_log() {
        let dir = TempDir::new("parity");
        let mem = InMemorySessionLog::new();
        let per = PersistentSessionLog::open(dir.0.as_path(), "p").expect("open");
        for e in sample_events() {
            mem.append(e.clone());
            per.append(e);
        }
        assert_eq!(msg_values(&mem.derive_messages()), msg_values(&per.derive_messages()));
        // A recovered persistent log derives identically as well.
        drop(per);
        let recovered = PersistentSessionLog::open(dir.0.as_path(), "p").expect("reopen");
        assert_eq!(msg_values(&mem.derive_messages()), msg_values(&recovered.derive_messages()));
        // Tool-call merge parity for a bare tool-call burst.
        let mem2 = InMemorySessionLog::new();
        let per2 = PersistentSessionLog::open(dir.0.as_path(), "p2").expect("open");
        for i in 0..3 {
            let ev = SessionEvent::ToolCall {
                id: format!("c{i}"),
                name: "f".into(),
                args: json!(i),
            };
            mem2.append(ev.clone());
            per2.append(ev);
        }
        assert_eq!(msg_values(&mem2.derive_messages()), msg_values(&per2.derive_messages()));
    }

    #[test]
    fn persistent_blank_lines_and_missing_final_newline_tolerated() {
        let dir = TempDir::new("blank");
        let path = file_path(dir.0.as_path(), "s1");
        {
            let mut f = fs::File::create(&path).expect("create");
            f.write_all(br#"{"type":"user_message","text":"a"}"#).unwrap();
            f.write_all(b"\n\n").unwrap(); // blank line
            f.write_all(br#"{"type":"user_message","text":"b"}"#).unwrap(); // no trailing newline
            f.sync_all().unwrap();
        }
        let log = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open");
        assert_eq!(log.events().len(), 2);
        assert_eq!(log.write_error_count(), 0);
        assert_eq!(log.derive_messages().len(), 2);
        // Appends continue cleanly after a no-newline tail.
        log.append(SessionEvent::AssistantMessage { text: "c".into() });
        drop(log);
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log2.events().len(), 3);
    }

    #[test]
    fn persistent_session_id_sanitized_to_safe_filename() {
        assert_eq!(file_name_for("session-0"), "session-0.jsonl");
        // Path separators can never survive the mapping.
        let weird = file_name_for("../etc/passwd");
        assert!(!weird.contains('/') && !weird.contains('\\'), "name: {weird}");
        assert!(weird.ends_with(".jsonl"));
        let dir = TempDir::new("names");
        let p = file_path(dir.0.as_path(), "../etc/passwd");
        assert_eq!(p.parent(), Some(dir.0.as_path()));
        // Opening with a hostile id still lands inside the dir and works.
        let log = PersistentSessionLog::open(dir.0.as_path(), "../etc/passwd").expect("open");
        assert_eq!(log.path().parent(), Some(dir.0.as_path()));
        log.append(SessionEvent::UserMessage { text: "ok".into() });
        assert_eq!(log.events().len(), 1);
        // Empty id falls back to a usable name.
        assert_eq!(file_name_for(""), "session.jsonl");
    }

    #[test]
    fn persistent_concurrent_appends_all_persisted_in_order() {
        let dir = TempDir::new("conc");
        let log = Arc::new(PersistentSessionLog::open(dir.0.as_path(), "s1").expect("open"));
        let mut handles = Vec::new();
        for t in 0..8u32 {
            let log = Arc::clone(&log);
            handles.push(std::thread::spawn(move || {
                for i in 0..50u32 {
                    log.append(SessionEvent::UserMessage { text: format!("t{t}-{i}") });
                }
            }));
        }
        for h in handles {
            h.join().expect("sender joins");
        }
        assert_eq!(log.events().len(), 400);
        assert_eq!(log.write_error_count(), 0);
        let before = serde_json::to_string(&log.events()).expect("events json");
        drop(log);
        // Replay order == append order (same locks guard mirror and writer).
        let log2 = PersistentSessionLog::open(dir.0.as_path(), "s1").expect("reopen");
        assert_eq!(log2.events().len(), 400, "all 400 records survive a reload");
        assert_eq!(serde_json::to_string(&log2.events()).unwrap(), before);
    }

    #[test]
    fn persistent_log_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<PersistentSessionLog>();
        assert_send_sync::<PersistentOptions>();
        assert_send_sync::<PersistError>();
    }
}
