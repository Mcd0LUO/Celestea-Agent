//! W242 A: session-scoped registry of background sandbox processes +
//! the `process_control` builtin tool (poll / kill / stdin).
//!
//! A background `run_shell(background: true)` spawn registers its detached
//! child here. Entries survive across turns (that is the point: long-running
//! servers / listeners started in one turn stay controllable from later
//! turns); the [ProcessRegistry] is mounted into the engine [celestea_core::Context]
//! by the runtime compose and shared by the run_shell / process_control tools.
//! Every child gets a reaper task that drains its stdout/stderr into capped
//! ring buffers and removes the handle from the registry as soon as the
//! process exits; dropping the registry kills every remaining child.
//!
//! W251: a completion sink seam — `set_completion_sink` installs one callback
//! per registry. The reaper invokes it exactly once per handle when a process
//! exits *naturally* (kill / shutdown paths are suppressed, and notify=false
//! opts out), so runtimes can push a "[process] ... exited ..." message into
//! the session mailbox instead of polling.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use celestea_core::{Tool, ToolSpec};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, ChildStderr};

use crate::builtin::fn_tool;

/// Bytes kept per stream in the registry's ring buffer (last N bytes win).
const MAX_STREAM_BUFFER: usize = 512 * 1024;
/// Bytes returned by `poll` as `stdout_tail` / `stderr_tail`.
const TAIL_BYTES: usize = 4 * 1024;
/// Grace between SIGTERM and SIGKILL in `kill`.
const KILL_GRACE: Duration = Duration::from_secs(1);
/// Upper bound for a single stdin line write.
const STDIN_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Bytes kept per stream tail in a [ProcessCompletion] (<= 1KB).
const COMPLETION_TAIL_BYTES: usize = 1024;

/// W251: one natural-exit completion record handed to the completion sink.
/// `stdout_tail` / `stderr_tail` are the last [COMPLETION_TAIL_BYTES] bytes of
/// each stream, newline runs folded.
#[derive(Clone, Debug)]
pub struct ProcessCompletion {
    pub handle: String,
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub elapsed_ms: u64,
}

/// Shared, mutable state of one background process. The reaper task owns the
/// [Child] itself and mirrors exit status + capped stream tails in here, so
/// poll / stdin / kill never need the [Child] handle.
struct ProcState {
    exited: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    stdin: Option<ChildStdin>,
    /// Non-unix kill: the reaper notices the flag and start_kill()s the child.
    kill_requested: bool,
    /// W251: kill/shutdown path (process_control kill or kill_all) — the
    /// reaper records the exit but must NOT fire the completion sink.
    kill_path: bool,
    /// W251: completion message enabled (run_shell `notify`, default true).
    notify: bool,
    /// W251: spawn time for `elapsed_ms` in the completion record.
    spawned_at: std::time::Instant,
}

/// Registry entry handed back to tools and tests: stable handle + pid plus the
/// shared state.
#[derive(Clone)]
pub struct ChildHandle {
    pub handle: String,
    pub pid: u32,
    state: Arc<Mutex<ProcState>>,
}

/// Session-scoped registry of background sandbox processes (W242 A). Provided
/// into the engine Context as [ProcessRegistryService]; `run_shell` inserts,
/// `process_control` polls / writes / kills, the per-child reaper removes the
/// entry when the process exits, and [Drop] kills whatever is still running.
pub struct ProcessRegistry {
    map: Mutex<HashMap<String, ChildHandle>>,
    next_handle: AtomicU64,
    /// W251: completion sink fired by reapers on natural exit (see module doc).
    completion_sink: Mutex<Option<Arc<dyn Fn(ProcessCompletion) + Send + Sync>>>,
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            next_handle: AtomicU64::new(0),
            completion_sink: Mutex::new(None),
        }
    }

    /// W251: install the natural-exit completion sink (one per registry; the
    /// last install wins). The reaper calls it at most once per handle, on
    /// natural exit only — never on the kill / shutdown paths — and only when
    /// the entry was spawned with notify enabled.
    pub fn set_completion_sink(&self, sink: Arc<dyn Fn(ProcessCompletion) + Send + Sync>) {
        *self.completion_sink.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink);
    }

    fn completion_sink(&self) -> Option<Arc<dyn Fn(ProcessCompletion) + Send + Sync>> {
        self.completion_sink.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Register a freshly spawned background child: takes ownership of the
    /// pipes, spawns the reaper task, returns the handle. Must be called on an
    /// `Arc<Self>` so the reaper can hold a [Weak] (dropping the last strong
    /// ref runs [Drop], which kills the children; the reaper then just winds
    /// down instead of pinning the registry alive).
    pub fn insert(
        self: &Arc<Self>,
        child: Child,
        stdin: Option<ChildStdin>,
        stdout: ChildStdout,
        stderr: ChildStderr,
        notify: bool,
    ) -> ChildHandle {
        let pid = child.id().unwrap_or(0);
        let handle = format!("proc-{}", self.next_handle.fetch_add(1, Ordering::Relaxed));
        let state = Arc::new(Mutex::new(ProcState {
            exited: false,
            exit_code: None,
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            stdin,
            kill_requested: false,
            kill_path: false,
            notify,
            spawned_at: std::time::Instant::now(),
        }));
        let h = ChildHandle { handle: handle.clone(), pid, state: state.clone() };
        self.map.lock().unwrap_or_else(|p| p.into_inner()).insert(handle.clone(), h.clone());
        spawn_reaper(Arc::downgrade(self), handle, pid, child, stdout, stderr, state);
        h
    }

    pub fn get(&self, handle: &str) -> Option<ChildHandle> {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).get(handle).cloned()
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn remove(&self, handle: &str) {
        self.map.lock().unwrap_or_else(|p| p.into_inner()).remove(handle);
    }

    /// `process_control(action=poll)`: running flag, capped stream tails and
    /// the exit code once the process is gone.
    pub fn poll(&self, handle: &str) -> Value {
        let Some(h) = self.get(handle) else {
            return unknown_handle(handle);
        };
        let st = h.state.lock().unwrap_or_else(|p| p.into_inner());
        json!({
            "ok": true,
            "handle": h.handle,
            "pid": h.pid,
            "running": !st.exited,
            "stdout_tail": tail_str(&st.stdout),
            "stderr_tail": tail_str(&st.stderr),
            "stdout_truncated": st.stdout_truncated,
            "stderr_truncated": st.stderr_truncated,
            "exit_code": st.exited.then_some(st.exit_code).flatten(),
        })
    }

    /// `process_control(action=kill)`: close stdin, SIGTERM the process group,
    /// grace, then SIGKILL the group. Returns once the reaper has recorded the
    /// exit (or the escalation window elapsed).
    pub async fn kill(&self, handle: &str) -> Value {
        let Some(h) = self.get(handle) else {
            return unknown_handle(handle);
        };
        // EOF on stdin nudges line-reading children toward a natural exit.
        // W251: mark the kill path so the reaper records the exit without
        // firing the completion sink (kill() already returns {killed:true}).
        {
            let mut st = h.state.lock().unwrap_or_else(|p| p.into_inner());
            st.stdin.take();
            st.kill_path = true;
        }
        signal(&h, Signal::Term);
        // Grace window: wait for the reaper to observe the exit.
        let exited = wait_exited(&h, KILL_GRACE).await;
        if !exited {
            signal(&h, Signal::Kill);
            let _ = wait_exited(&h, Duration::from_secs(2)).await;
        }
        json!({ "ok": true, "killed": true, "handle": h.handle })
    }

    /// `process_control(action=stdin)`: write one line (content + '\n') to the
    /// child's stdin. The pipe is taken during the write so the reaper never
    /// blocks on the state lock.
    pub async fn stdin_line(&self, handle: &str, line: &str) -> Value {
        let Some(h) = self.get(handle) else {
            return unknown_handle(handle);
        };
        let stdin = {
            let mut st = h.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.exited {
                return json!({ "ok": false, "error": format!("process {handle} already exited") });
            }
            st.stdin.take()
        };
        let Some(mut stdin) = stdin else {
            return json!({ "ok": false, "error": format!("process {handle} stdin unavailable") });
        };
        let mut payload = line.as_bytes().to_vec();
        payload.push(b'\n');
        let written = match tokio::time::timeout(STDIN_WRITE_TIMEOUT, stdin.write_all(&payload)).await {
            Ok(Ok(())) => payload.len(),
            Ok(Err(e)) => return json!({ "ok": false, "error": format!("stdin write failed: {e}") }),
            Err(_) => return json!({ "ok": false, "error": "stdin write timed out (5s)" }),
        };
        // Hand the pipe back so later stdin actions keep working.
        let mut st = h.state.lock().unwrap_or_else(|p| p.into_inner());
        if !st.exited {
            st.stdin = Some(stdin);
        }
        json!({ "ok": true, "handle": h.handle, "written": written })
    }

    /// W248 shutdown path: kill every still-registered child (SIGKILL the whole
    /// group on unix; start_kill via the reaper flag elsewhere) and drain the map.
    /// This is the exact path [Drop] uses — surfaced as a public method so
    /// Runtime::shutdown can guarantee cleanup while the registry is still shared.
    /// Idempotent: a second call finds an empty map. Best effort — the reaper
    /// tasks finish on their own once the children are dead.
    pub fn kill_all(&self) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        for (_k, h) in map.drain() {
            let mut st = h.state.lock().unwrap_or_else(|p| p.into_inner());
            st.stdin.take();
            st.kill_requested = true;
            // W251: shutdown kills are not "natural exits" — no sink callback.
            st.kill_path = true;
            drop(st);
            signal(&h, Signal::Kill);
        }
    }
}

/// Runtime drop: kill every still-registered child via [ProcessRegistry::kill_all]
/// (W248: explicit shutdown calls the same path; Drop stays the last-resort
/// guarantee when a Runtime is dropped without shutdown).
impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn unknown_handle(handle: &str) -> Value {
    json!({ "ok": false, "error": format!("unknown handle: {handle}") })
}

fn tail_str(buf: &[u8]) -> String {
    let tail = &buf[buf.len().saturating_sub(TAIL_BYTES)..];
    String::from_utf8_lossy(tail).into_owned()
}

/// W251: completion-record tail — last [COMPLETION_TAIL_BYTES] bytes, newline
/// runs folded into a single newline so mailbox messages stay compact.
fn completion_tail(buf: &[u8]) -> String {
    let tail = &buf[buf.len().saturating_sub(COMPLETION_TAIL_BYTES)..];
    let text = String::from_utf8_lossy(tail).into_owned();
    let mut out = String::with_capacity(text.len());
    let mut prev_nl = false;
    for ch in text.chars() {
        if ch == '\n' {
            if !prev_nl {
                out.push(ch);
                prev_nl = true;
            }
        } else {
            out.push(ch);
            prev_nl = false;
        }
    }
    out
}

async fn wait_exited(h: &ChildHandle, window: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    while tokio::time::Instant::now() < deadline {
        if h.state.lock().unwrap_or_else(|p| p.into_inner()).exited {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    h.state.lock().unwrap_or_else(|p| p.into_inner()).exited
}

#[derive(Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

fn signal(h: &ChildHandle, s: Signal) {
    if h.pid == 0 {
        return; // never signal pid 0: that would target our own process group
    }
    #[cfg(unix)]
    {
        // SAFETY: the pid belongs to a child we spawned with process_group(0);
        // a negative pid targets the whole process group (bwrap outer included).
        let sig = match s {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        unsafe { libc::kill(-(h.pid as i32), sig) };
    }
    #[cfg(not(unix))]
    {
        // No process-group signals here: ask the reaper to start_kill the child.
        h.state.lock().unwrap_or_else(|p| p.into_inner()).kill_requested = true;
        let _ = s;
    }
}

/// Drain a child pipe into the state's capped ring buffer (oldest bytes
/// dropped past the cap). Runs to EOF — i.e. until the child (and any wrapper)
/// closes the pipe.
async fn drain_stream<R: AsyncReadExt + Unpin>(
    mut r: R,
    state: Arc<Mutex<ProcState>>,
    is_stdout: bool,
) {
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
                // Deref the guard once so the two field borrows below are
                // disjoint (the borrow checker cannot split them through DerefMut).
                let st = &mut *st;
                if is_stdout {
                    append_capped(&mut st.stdout, &mut st.stdout_truncated, &chunk[..n]);
                } else {
                    append_capped(&mut st.stderr, &mut st.stderr_truncated, &chunk[..n]);
                }
            }
        }
    }
}

/// Append `data` to the capped ring buffer, dropping the oldest bytes past
/// [MAX_STREAM_BUFFER] and flagging truncation.
fn append_capped(buf: &mut Vec<u8>, truncated: &mut bool, data: &[u8]) {
    if buf.len() + data.len() > MAX_STREAM_BUFFER {
        buf.drain(..(buf.len() + data.len() - MAX_STREAM_BUFFER));
        *truncated = true;
    }
    buf.extend_from_slice(data);
}

/// Per-child reaper: drains both pipes, polls the child to completion (so the
/// kill flag works on non-unix too), mirrors the exit status into the shared
/// state, then removes the handle — a finished process never lingers in the
/// registry. Holds only a [Weak] registry ref: when the registry is dropped,
/// [Drop] kills the child and this task winds down without pinning anything.
fn spawn_reaper(
    weak: Weak<ProcessRegistry>,
    handle: String,
    pid: u32,
    mut child: Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
    state: Arc<Mutex<ProcState>>,
) {
    tokio::spawn(async move {
        let out_fut = drain_stream(stdout, state.clone(), true);
        let err_fut = drain_stream(stderr, state.clone(), false);
        let wait_fut = async {
            loop {
                let kill_requested = state.lock().unwrap_or_else(|p| p.into_inner()).kill_requested;
                if kill_requested {
                    let _ = child.start_kill();
                }
                match child.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) => {}
                    Err(_) => return None,
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let (_, _, code) = tokio::join!(out_fut, err_fut, wait_fut);
        // W251: record the exit once (dedup via the exited flag — the reaper
        // is the only writer) and decide whether the sink fires: natural exit
        // only (no kill_path), notify enabled, first observation.
        let (fire, stdout_tail, stderr_tail, elapsed_ms) = {
            let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
            let first_exit = !st.exited;
            st.exited = true;
            st.exit_code = code;
            st.stdin.take();
            let fire = first_exit && st.notify && !st.kill_path;
            let elapsed_ms = st.spawned_at.elapsed().as_millis() as u64;
            (fire, completion_tail(&st.stdout), completion_tail(&st.stderr), elapsed_ms)
        };
        if let Some(reg) = weak.upgrade() {
            reg.remove(&handle);
            if fire {
                if let Some(sink) = reg.completion_sink() {
                    sink(ProcessCompletion {
                        handle,
                        pid,
                        exit_code: code,
                        stdout_tail,
                        stderr_tail,
                        elapsed_ms,
                    });
                }
            }
        }
    });
}

// ---- process_control tool -----------------------------------------------------

/// Service newtype so an `Arc<ProcessRegistry>` can live in the Context
/// TypeId map (same pattern as LlmService / ToolRegistryService).
pub struct ProcessRegistryService(pub Arc<ProcessRegistry>);

impl std::ops::Deref for ProcessRegistryService {
    type Target = ProcessRegistry;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

fn process_control_spec() -> ToolSpec {
    ToolSpec {
        name: "process_control".into(),
        description: "Control a background process started by run_shell(background=true). Handles live in the session-scoped process registry and survive across turns; a process that exits is removed from the registry automatically. action=poll returns {running, stdout_tail(<=4KB), stderr_tail, exit_code?}; action=kill sends SIGTERM, waits a grace period, then SIGKILL and returns {killed:true}; action=stdin writes one line (content + newline) to the process stdin.".into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "handle": { "type": "string", "description": "Process handle returned by run_shell(background=true)." },
                "action": { "type": "string", "enum": ["poll", "kill", "stdin"], "description": "poll | kill | stdin (see tool description)." },
                "content": { "type": "string", "description": "Line to write to the process stdin (action=stdin only)." }
            },
            "required": ["handle", "action"],
            "additionalProperties": false
        }),
    }
}

pub(crate) fn process_control_tool(reg: Arc<ProcessRegistry>) -> Box<dyn Tool> {
    fn_tool(process_control_spec(), move |args| {
        let reg = reg.clone();
        Box::pin(async move {
            let handle = match args.get("handle").and_then(Value::as_str) {
                Some(h) if !h.trim().is_empty() => h.trim().to_string(),
                _ => return Ok(json!({ "ok": false, "error": "handle required" })),
            };
            let action = args.get("action").and_then(Value::as_str).unwrap_or("");
            match action {
                "poll" => Ok(reg.poll(&handle)),
                "kill" => Ok(reg.kill(&handle).await),
                "stdin" => {
                    let line = match args.get("content").and_then(Value::as_str) {
                        Some(c) => c.to_string(),
                        None => return Ok(json!({ "ok": false, "error": "content required for action=stdin" })),
                    };
                    Ok(reg.stdin_line(&handle, &line).await)
                }
                other => Ok(json!({ "ok": false, "error": format!("unknown action: {other}") })),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::process::Stdio;
    use tokio::process::Command;

    /// W248: kill_all 必须杀掉仍在运行的子进程并排空 map（Drop 同一路径），
    /// 重复调用幂等。
    #[tokio::test]
    async fn kill_all_kills_registered_children_and_drains_map() {
        let reg = Arc::new(ProcessRegistry::new());
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sleep");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("child stdout");
        let stderr = child.stderr.take().expect("child stderr");
        reg.insert(child, stdin, stdout, stderr, true);
        assert_eq!(reg.len(), 1, "child registered");

        reg.kill_all();
        assert_eq!(reg.len(), 0, "map drained by kill_all");
        reg.kill_all(); // idempotent: empty map no-op
        assert!(reg.is_empty());
    }

    // ---- W251: completion sink (natural exit / kill / notify) -----------------

    async fn wait_until<F: Fn() -> bool>(cond: F, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if cond() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        cond()
    }

    /// 自然退出：sink 恰好收到一次，exit_code / stdout tail / elapsed 正确；
    /// 再等一段时间也不重复回调（退出标记去重）。
    #[tokio::test]
    async fn natural_exit_fires_completion_sink_exactly_once() {
        let reg = Arc::new(ProcessRegistry::new());
        let seen: Arc<Mutex<Vec<ProcessCompletion>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        reg.set_completion_sink(Arc::new(move |c| {
            sink_seen.lock().unwrap_or_else(|p| p.into_inner()).push(c);
        }));

        let mut child = Command::new("sh")
            .args(["-c", "echo out; echo err >&2; sleep 0.2; exit 3"])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("child stdout");
        let stderr = child.stderr.take().expect("child stderr");
        let h = reg.insert(child, stdin, stdout, stderr, true);
        let handle = h.handle.clone();

        let got = wait_until(
            || !seen.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            Duration::from_secs(5),
        )
        .await;
        assert!(got, "completion sink never fired");

        // 重复退出不重复回调：reaper 每 handle 只发一次。
        tokio::time::sleep(Duration::from_millis(300)).await;
        let completions = seen.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(completions.len(), 1, "exactly one completion: {completions:?}");
        let c = &completions[0];
        assert_eq!(c.handle, handle);
        assert_eq!(c.exit_code, Some(3));
        assert!(c.stdout_tail.contains("out"), "stdout_tail: {:?}", c.stdout_tail);
        assert!(c.stderr_tail.contains("err"), "stderr_tail: {:?}", c.stderr_tail);
        assert!(c.elapsed_ms > 0, "elapsed_ms: {}", c.elapsed_ms);
        assert_eq!(reg.len(), 0, "reaper removed the exited handle");
    }

    /// kill 路径不触发 sink：process_control kill 已同步返回 {killed:true}，
    /// 完成回传必须静默。
    #[tokio::test]
    async fn kill_does_not_fire_completion_sink() {
        let reg = Arc::new(ProcessRegistry::new());
        let seen: Arc<Mutex<Vec<ProcessCompletion>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        reg.set_completion_sink(Arc::new(move |c| {
            sink_seen.lock().unwrap_or_else(|p| p.into_inner()).push(c);
        }));

        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sleep");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("child stdout");
        let stderr = child.stderr.take().expect("child stderr");
        let h = reg.insert(child, stdin, stdout, stderr, true);

        let out = reg.kill(&h.handle).await;
        assert_eq!(out["killed"], json!(true));
        assert_eq!(reg.len(), 0, "kill removed the handle");

        // 给 reaper 收尾时间：kill 路径必须静默。
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            seen.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "kill path must not fire the completion sink"
        );
    }

    /// notify:false 的 spawn 自然退出也不触发 sink。
    #[tokio::test]
    async fn notify_false_suppresses_completion_sink() {
        let reg = Arc::new(ProcessRegistry::new());
        let seen: Arc<Mutex<Vec<ProcessCompletion>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = seen.clone();
        reg.set_completion_sink(Arc::new(move |c| {
            sink_seen.lock().unwrap_or_else(|p| p.into_inner()).push(c);
        }));

        let mut child = Command::new("sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("child stdout");
        let stderr = child.stderr.take().expect("child stderr");
        reg.insert(child, stdin, stdout, stderr, false);

        let exited = wait_until(|| reg.is_empty(), Duration::from_secs(5)).await;
        assert!(exited, "process never exited");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            seen.lock().unwrap_or_else(|p| p.into_inner()).is_empty(),
            "notify:false must not fire the completion sink"
        );
    }
}
