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
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()), next_handle: AtomicU64::new(0) }
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
        }));
        let h = ChildHandle { handle: handle.clone(), pid, state: state.clone() };
        self.map.lock().unwrap_or_else(|p| p.into_inner()).insert(handle.clone(), h.clone());
        spawn_reaper(Arc::downgrade(self), handle, child, stdout, stderr, state);
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
        h.state.lock().unwrap_or_else(|p| p.into_inner()).stdin.take();
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
}

/// Runtime drop: kill every still-registered child (SIGKILL the whole group on
/// unix; start_kill via the reaper flag elsewhere). Best effort — the reaper
/// tasks finish on their own once the children are dead.
impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        let map = self.map.get_mut().unwrap_or_else(|p| p.into_inner());
        for (_k, h) in map.drain() {
            let mut st = h.state.lock().unwrap_or_else(|p| p.into_inner());
            st.stdin.take();
            st.kill_requested = true;
            drop(st);
            signal(&h, Signal::Kill);
        }
    }
}

fn unknown_handle(handle: &str) -> Value {
    json!({ "ok": false, "error": format!("unknown handle: {handle}") })
}

fn tail_str(buf: &[u8]) -> String {
    let tail = &buf[buf.len().saturating_sub(TAIL_BYTES)..];
    String::from_utf8_lossy(tail).into_owned()
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
        {
            let mut st = state.lock().unwrap_or_else(|p| p.into_inner());
            st.exited = true;
            st.exit_code = code;
            st.stdin.take();
        }
        if let Some(reg) = weak.upgrade() {
            reg.remove(&handle);
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
