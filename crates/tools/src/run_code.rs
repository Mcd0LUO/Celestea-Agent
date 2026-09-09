//! W255 run_code: Python programmatic tool execution with a parent broker.
//!
//! One `run_code` call = one round trip: the program runs inside the same
//! three-layer sandbox as `run_shell` (bwrap/raw/userspace + rlimits, no
//! network) under `python3 -uB`, its tool calls travel as single-line JSON-RPC
//! requests on stdout, and the parent engine (this module) dispatches each
//! sub-call through the **same** `ToolRegistry` pipeline (guards, schema
//! checks, limits) and writes one-line JSON replies back on stdin.
//!
//! Design (see docs/run-code-mode-eval.md §4.1 方案 A):
//! - the assembled program (SDK preamble + user code + runner) is written to
//!   `<sandbox workdir>/.celestea/run_code_<pid>_<n>.py` and spawned with
//!   `python3 -uB <file>`; stdin stays free as the reply channel (a literal
//!   "stdin carries the script" scheme cannot work with CPython, which only
//!   starts executing `python3 -` after stdin EOF);
//! - hard limits, enforced parent-side: ≤20 sub-calls, wall clock ≤120s
//!   (default 120000ms, cap 120000ms), sub-call output ledger ≤256KiB
//!   (truncated with a warning field), program stdout logs ≤64KiB;
//! - every sub-call is appended to the session log as
//!   ToolCall/ToolResult{id:"<parent>:c<n>", parent_id: Some(parent)}; the
//!   model-visible projection (derive_messages) skips nested rows.
//!
//! The SDK whitelist is exactly read_file / write_file / list_dir / run_shell;
//! any other tool name (including run_code itself) is refused.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use celestea_core::{SessionEvent, Tool, ToolExecOutcome, ToolInput, ToolRegistry, ToolSpec};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::builtin::arg_str;
use crate::sandbox::{self, SandboxConfig};

// ---- limits (P0 hard requirements) ------------------------------------------

/// Default whole-run wall clock: 120s.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(120_000);
/// Hard cap for `timeout_ms`: 120s.
pub const MAX_TIMEOUT: Duration = Duration::from_millis(120_000);
/// Hard sub-call budget: the 21st dispatched sub-call is refused.
pub const MAX_SUB_CALLS: u32 = 20;
/// Hard output ledger for sub-call results: 256 KiB (truncate + warn).
pub const MAX_SUB_OUTPUT_BYTES: usize = 256 * 1024;
/// Hard budget for the program's stdout log lines (non-protocol): 64 KiB.
pub const MAX_LOG_BYTES: usize = 64 * 1024;
/// Upper bound for a single stdout line (protocol requests included); longer
/// lines are drained and truncated (logged, never parsed as protocol).
const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Grace period for the child to exit after its final/error line.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// Env var: default whole-run wall clock in ms (clamped to [1, 120000]).
pub const ENV_TIMEOUT_MS: &str = "CELAESTEA_RUN_CODE_TIMEOUT_MS";
/// Stable prefix of every structured infrastructure error.
pub const ERROR_PREFIX: &str = "run_code";
/// The SDK whitelist — the only tool names the parent will dispatch for a
/// sub-call. spawn_worker / session_send_message / process_control /
/// http_request / run_code are deliberately excluded (eval §6.5).
pub const SDK_TOOLS: [&str; 4] = ["read_file", "write_file", "list_dir", "run_shell"];

// ---- tuning ------------------------------------------------------------------

/// Tuning knobs for the run_code broker.
#[derive(Debug, Clone)]
pub struct RunCodeConfig {
    /// The underlying execution sandbox (same layer as run_shell).
    pub(crate) sandbox: SandboxConfig,
    /// Default whole-run wall clock (per-call `timeout_ms` bounded by
    /// [MAX_TIMEOUT]).
    pub(crate) timeout: Duration,
    /// Sub-call budget ([MAX_SUB_CALLS] default; the 21st call is refused).
    pub(crate) max_sub_calls: u32,
    /// Sub-call output ledger in bytes ([MAX_SUB_OUTPUT_BYTES] default).
    pub(crate) max_sub_output_bytes: usize,
    /// Program stdout log budget in bytes ([MAX_LOG_BYTES] default).
    pub(crate) max_log_bytes: usize,
}

impl Default for RunCodeConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl RunCodeConfig {
    /// Defaults: run_shell's env-tuned sandbox, 120s wall clock, 20 sub-calls,
    /// 256KiB sub-call output, 64KiB logs.
    pub fn new() -> Self {
        Self {
            sandbox: SandboxConfig::from_env(),
            timeout: DEFAULT_TIMEOUT,
            max_sub_calls: MAX_SUB_CALLS,
            max_sub_output_bytes: MAX_SUB_OUTPUT_BYTES,
            max_log_bytes: MAX_LOG_BYTES,
        }
    }

    /// [RunCodeConfig::new] after applying `CELAESTEA_RUN_CODE_TIMEOUT_MS`
    /// (clamped to [1ms, 120000ms] — the cap is hard).
    pub fn from_env() -> Self {
        let mut cfg = Self::new();
        if let Some(ms) = std::env::var(ENV_TIMEOUT_MS).ok().and_then(|v| v.parse::<u64>().ok()) {
            cfg = cfg.with_timeout_ms(ms);
        }
        cfg
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Set the default wall clock from milliseconds, clamped to [1, 120000].
    pub fn with_timeout_ms(mut self, ms: u64) -> Self {
        self.timeout = Duration::from_millis(ms.clamp(1, MAX_TIMEOUT.as_millis() as u64));
        self
    }

    /// Pin the sandbox workdir (tests / embeddings).
    pub fn with_workdir(mut self, p: impl AsRef<std::path::Path>) -> Self {
        self.sandbox = self.sandbox.with_workdir(p);
        self
    }

    /// Pin the sandbox root (tests / embeddings).
    pub fn with_root(mut self, p: impl AsRef<std::path::Path>) -> Self {
        self.sandbox = self.sandbox.with_root(p);
        self
    }

    #[allow(dead_code)] // test/embedding knob
    pub fn with_max_sub_calls(mut self, n: u32) -> Self {
        self.max_sub_calls = n;
        self
    }

    #[allow(dead_code)] // test/embedding knob
    pub fn with_max_sub_output_bytes(mut self, n: usize) -> Self {
        self.max_sub_output_bytes = n;
        self
    }

    #[allow(dead_code)] // test/embedding knob
    pub fn with_max_log_bytes(mut self, n: usize) -> Self {
        self.max_log_bytes = n;
        self
    }
}

// ---- the SDK preamble (engine-injected Python constant) ----------------------

/// The Python SDK preamble (W255): standard library only, zero pip. See the
/// file header and the in-text contract for the protocol it speaks.
pub const RUN_CODE_SDK: &str = r##"# =============================================================================
# celestea run_code SDK (W255 P0) - engine-injected preamble. Standard library
# only (zero pip). Runs under `python3 -uB <file>` inside the Celestea
# execution sandbox; the parent engine (the "broker") reads our protocol lines
# from stdout and writes replies to stdin.
#
# Protocol (one JSON object per line, no other framing):
#   child -> parent   {"id": <int>, "tool": "<name>", "args": {...}}
#   parent -> child   {"id": <int>, "ok": true, "value": <json>, "truncated": <bool>}
#                     {"id": <int>, "ok": false, "error": "<message>"}
#   child -> parent   {"__final__": <json>}      (normal end: main()'s return)
#                     {"__error__": "<message>"} (uncaught exception)
#
# Contract:
#   - Write the program as an `async def main():` FUNCTION BODY, or as a
#     complete script that defines main. main()'s return value (lossless JSON)
#     is the final result of the run.
#   - `tools.<name>(**args)` (also `tools.<name>({"path": ...})`) is a
#     SYNCHRONOUS bridge: every sub-call is dispatched by the parent through
#     its normal tool pipeline (guards, schema checks, limits). A failure
#     raises ToolCallError - catch it and continue.
#   - Only print what the model needs (stdout logs are budgeted at 64KiB);
#     intermediate tool results never enter the conversation automatically.
#   - Sub-calls run SERIALLY in P0: Python-side concurrency (the Promise.all
#     equivalent for independent read-only calls) is a documented follow-up.
#   - Exposed tools: read_file / write_file / list_dir / run_shell. Any other
#     name (including run_code itself) is rejected by the parent.
#   - Do not read sys.stdin and do not add an `if __name__ == "__main__"`
#     block: stdin is the protocol reply channel and this harness is the
#     entry point.
# =============================================================================
import sys as _sys
import json as _json
import traceback as _traceback


class ToolCallError(Exception):
    """A bridged tool call failed (guard denial, unknown tool, dispatch
    error, limit exceeded). Catchable: the program may recover and continue."""

    def __init__(self, tool_name, message):
        super().__init__(f"tool '{tool_name}' failed: {message}")
        self.tool_name = tool_name


_sub_call_id = 0


def _bridge_call(tool, args):
    global _sub_call_id
    _sub_call_id += 1
    request_id = _sub_call_id
    try:
        payload = _json.dumps(
            {"id": request_id, "tool": tool, "args": args}, ensure_ascii=False
        )
    except (TypeError, ValueError) as exc:
        raise ToolCallError(tool, f"arguments are not JSON-serializable: {exc}")
    print(payload, flush=True)
    line = _sys.stdin.readline()
    if not line:
        raise ToolCallError(tool, "the parent broker closed the reply channel (run aborted)")
    try:
        reply = _json.loads(line)
    except ValueError as exc:
        raise ToolCallError(tool, f"malformed reply from the parent broker: {exc}")
    if reply.get("id") != request_id:
        raise ToolCallError(
            tool, f"reply id mismatch (expected {request_id}, got {reply.get('id')})"
        )
    if not reply.get("ok", False):
        raise ToolCallError(tool, reply.get("error", "unknown error"))
    return _Value(reply.get("value"))


class _Value:
    """Dual-interface tool result: usable directly (indexing/iteration/str)
    AND awaitable. Models write both styles — `await tools.list_dir(...)`
    and `tools.list_dir(...)` must behave identically."""

    def __init__(self, v):
        self._v = v

    def __await__(self):
        return iter((self._v,))

    def __iter__(self):
        return iter(self._v)

    def __getitem__(self, k):
        return self._v[k]

    def __len__(self):
        return len(self._v)

    def __bool__(self):
        return bool(self._v)

    def __str__(self):
        return str(self._v)

    def __repr__(self):
        return repr(self._v)

    def __eq__(self, other):
        if isinstance(other, _Value):
            other = other._v
        return self._v == other

    def get(self, *a, **k):
        return self._v.get(*a, **k) if hasattr(self._v, "get") else None

    def __getattr__(self, name):
        # Method passthrough (splitlines, keys, ...) so the wrapper behaves
        # exactly like the wrapped value in normal code paths.
        return getattr(self._v, name)


def _merge_args(positional, kwargs, tool):
    if positional:
        if len(positional) == 1 and isinstance(positional[0], dict):
            merged = dict(positional[0])
            merged.update(kwargs)
            return merged
        raise ToolCallError(tool, "expected a single dict argument and/or keyword arguments")
    return dict(kwargs)


class _Tools:
    """The SDK tool surface: only these four tools are bridged to the parent
    (read_file / write_file / list_dir / run_shell)."""

    def read_file(self, *args, **kwargs):
        return _bridge_call("read_file", _merge_args(args, kwargs, "read_file"))

    def write_file(self, *args, **kwargs):
        return _bridge_call("write_file", _merge_args(args, kwargs, "write_file"))

    def list_dir(self, *args, **kwargs):
        return _bridge_call("list_dir", _merge_args(args, kwargs, "list_dir"))

    def run_shell(self, *args, **kwargs):
        return _bridge_call("run_shell", _merge_args(args, kwargs, "run_shell"))


tools = _Tools()
"##;

/// The runner appended after the user program: calls `main()`, awaits it when
/// it is a coroutine (sync mains and sync mains returning coroutines also
/// work), then emits the `__final__` / `__error__` protocol line.
const RUN_CODE_RUNNER: &str = r##"
# ======================= harness entry point (injected) =======================
def _plain(v):
    """Unwrap dual-interface results before JSON serialization (dict/list deep)."""
    if isinstance(v, _Value):
        v = v._v
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return v


import asyncio as _asyncio


def _celestea_run_main():
    main = globals().get("main")
    if main is None:
        raise RuntimeError(
            "run_code: no 'main' defined - write the program as an async "
            "function body, or as a complete script defining async def main()"
        )
    result = main()
    if _asyncio.iscoroutine(result):
        result = _asyncio.run(result)
    return result


try:
    _final_value = _celestea_run_main()
    print(_json.dumps({"__final__": _plain(_final_value)}, ensure_ascii=False), flush=True)
except BaseException as _exc:  # report ANY failure as __error__
    _tb = _traceback.format_exc()
    for _line in _tb.rstrip("\n").split("\n"):
        print(_line, flush=True)
    print(
        _json.dumps({"__error__": f"{type(_exc).__name__}: {_exc}"}, ensure_ascii=False),
        flush=True,
    )
    _sys.exit(1)
"##;

// ---- program assembly --------------------------------------------------------

/// Assemble the file content: SDK preamble + user code + runner. When the
/// user code's first non-blank line is indented it is treated as an async
/// function BODY and wrapped into `async def main():`; otherwise it must be a
/// complete script defining `main` itself.
fn assemble_program(user_code: &str) -> String {
    let mut out = String::with_capacity(RUN_CODE_SDK.len() + user_code.len() + RUN_CODE_RUNNER.len() + 256);
    out.push_str(RUN_CODE_SDK);
    out.push_str("\n\n# ========================== user program ==========================\n");
    if first_nonblank_line_indented(user_code) {
        out.push_str("async def main():\n");
        for line in user_code.lines() {
            if line.trim().is_empty() {
                out.push('\n');
            } else {
                out.push_str("    ");
                out.push_str(line);
                out.push('\n');
            }
        }
        out.push('\n');
    } else {
        out.push_str(user_code);
        if !user_code.ends_with('\n') {
            out.push('\n');
        }
    }
    out.push_str(RUN_CODE_RUNNER);
    out
}

/// True when the first non-blank line starts with whitespace — the
/// "async function body" form.
fn first_nonblank_line_indented(code: &str) -> bool {
    code.lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.starts_with(' ') || l.starts_with('\t'))
        .unwrap_or(false)
}

// ---- child lifecycle ---------------------------------------------------------

/// Owns the spawned sandbox child: a Drop without settling first kills the
/// whole process group (cancel / abort / dropped future), never leaving an
/// orphaned python3 behind.
struct ChildKillGuard {
    child: Option<tokio::process::Child>,
}

impl ChildKillGuard {
    fn new(child: tokio::process::Child) -> Self {
        Self { child: Some(child) }
    }

    fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(|c| c.id())
    }

    /// Kill the whole process group now (timeout path). Reaps off-thread.
    fn kill_now(&mut self) -> Option<u32> {
        let pid = self.pid();
        if let Some(mut c) = self.child.take() {
            sandbox::kill_process(&mut c);
            reap(c);
        }
        pid
    }

    /// Wait for a natural exit within `grace`; on expiry kill the tree and
    /// reap. Returns (exit_status_when_natural, was_killed).
    async fn settle(&mut self, grace: Duration) -> (Option<std::process::ExitStatus>, bool) {
        let Some(mut c) = self.child.take() else {
            return (None, false);
        };
        match tokio::time::timeout(grace, c.wait()).await {
            Ok(Ok(status)) => (Some(status), false),
            Ok(Err(_)) => (None, false),
            Err(_elapsed) => {
                sandbox::kill_process(&mut c);
                let _ = tokio::time::timeout(Duration::from_secs(5), c.wait()).await;
                (None, true)
            }
        }
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        // Future dropped mid-flight (agent-loop cancel): kill the tree.
        if let Some(mut c) = self.child.take() {
            sandbox::kill_process(&mut c);
            reap(c);
        }
    }
}

/// Bounded reap on the runtime's background executor (no await from Drop).
fn reap(mut c: tokio::process::Child) {
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        let _ = handle.spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(5), c.wait()).await;
        });
    }
}

// ---- line reader -------------------------------------------------------------

/// Read one `\n`-terminated line with a byte budget: bytes past `max` are
/// drained but dropped (never buffered). Returns (line, truncated, eof).
async fn read_line_bounded<R: tokio::io::AsyncBufRead + Unpin>(
    r: &mut R,
    max: usize,
) -> std::io::Result<(String, bool, bool)> {
    let mut out = String::new();
    let mut truncated = false;
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return Ok((out, truncated, true)); // EOF (with any partial tail)
        }
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            append_bounded(&mut out, &mut truncated, &buf[..pos], max);
            r.consume(pos + 1);
            return Ok((out, truncated, false));
        }
        append_bounded(&mut out, &mut truncated, buf, max);
        let n = buf.len();
        r.consume(n);
    }
}

/// Append `chunk` to `out` up to `max` bytes total (UTF-8 safe); overflow sets
/// `truncated` and is dropped.
fn append_bounded(out: &mut String, truncated: &mut bool, chunk: &[u8], max: usize) {
    let chunk = std::str::from_utf8(chunk).unwrap_or("");
    if *truncated || chunk.is_empty() {
        if !chunk.is_empty() {
            *truncated = true;
        }
        return;
    }
    let remaining = max.saturating_sub(out.len());
    if chunk.len() <= remaining {
        out.push_str(chunk);
    } else {
        // Keep the prefix on a UTF-8 character boundary.
        let mut cut = remaining;
        while cut > 0 && !chunk.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push_str(&chunk[..cut]);
        *truncated = true;
    }
}

// ---- sub-call result shaping -------------------------------------------------

/// Truncate a sub-call result value to at most `budget` serialized bytes:
/// strings keep a UTF-8-safe prefix; non-strings collapse to a placeholder
/// (there is no lossless way to cut an object/array).
fn truncate_value(value: Value, budget: usize) -> Value {
    match value {
        Value::String(s) => {
            let mut cut = budget.min(s.len());
            while cut > 0 && !s.is_char_boundary(cut) {
                cut -= 1;
            }
            Value::String(s[..cut].to_string())
        }
        other => {
            if serde_json::to_string(&other).unwrap_or_default().len() <= budget {
                other
            } else {
                json!("[run_code] sub-call output exceeded the budget; value dropped")
            }
        }
    }
}

// ---- the tool -----------------------------------------------------------------

/// Late-bound handle to the composed registry. The tool is registered BEFORE
/// the registry can be shared (a live `Weak` would defeat `Arc::get_mut`
/// registration), so the wiring binds the `Weak` afterwards; dispatch resolves
/// it at execution time. No ownership cycle: only a weak edge back.
#[derive(Debug, Default)]
pub struct RegistryHandle(std::sync::OnceLock<Weak<dyn ToolRegistry>>);

impl RegistryHandle {
    /// Bind the composed registry (idempotent; the first binding wins).
    pub fn set(&self, weak: Weak<dyn ToolRegistry>) {
        let _ = self.0.set(weak);
    }

    fn resolve(&self) -> Option<Arc<dyn ToolRegistry>> {
        self.0.get().and_then(Weak::upgrade)
    }
}

/// A `Tool` whose behavior is the run_code parent broker. Sub-calls ride the
/// identical dispatch-guards-execute pipeline of the registry the tool is
/// registered in (see [RegistryHandle]).
pub struct RunCodeTool {
    spec: ToolSpec,
    config: RunCodeConfig,
    registry: Arc<RegistryHandle>,
    /// Session-log sink for sub-call ToolCall/ToolResult events
    /// (id = "<parent>:c<n>", parent_id = Some(parent)). Optional for
    /// embeddings that do not keep a session log.
    events: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
    script_seq: AtomicU64,
}

/// Build the `run_code` tool plus its [RegistryHandle]; after the tool is
/// registered into the (still uniquely-owned) registry, bind the handle:
///
/// ```ignore
/// let mut reg = Arc::new(ToolRegistryImpl::new());
/// // ... register all other tools + guards via Arc::get_mut ...
/// let (tool, handle) = run_code_tool_with_handle(RunCodeConfig::from_env(), Some(events));
/// Arc::get_mut(&mut reg).unwrap().register(tool);
/// let weak = { let d: Arc<dyn ToolRegistry> = reg.clone(); Arc::downgrade(&d) };
/// handle.set(weak);
/// ```
pub fn run_code_tool_with_handle(
    config: RunCodeConfig,
    events: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
) -> (Box<dyn Tool>, Arc<RegistryHandle>) {
    let handle = Arc::new(RegistryHandle::default());
    let tool = Box::new(RunCodeTool {
        spec: run_code_spec(),
        config,
        registry: handle.clone(),
        events,
        script_seq: AtomicU64::new(0),
    });
    (tool, handle)
}

#[async_trait]
impl Tool for RunCodeTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    async fn execute(&self, _args: Value) -> Result<Value, String> {
        // The broker needs the caller-assigned call id (sub-call event ids
        // embed it); the registry always dispatches via execute_with.
        Err(format!("{ERROR_PREFIX}: dispatched without a call id"))
    }

    async fn execute_with(&self, input: ToolInput) -> Result<ToolExecOutcome, String> {
        let call_id = input.call_id.clone();
        let outcome = broker_run(
            &self.config,
            self.registry.clone(),
            self.events.clone(),
            &self.script_seq,
            call_id,
            input.args,
        )
        .await;
        match outcome {
            Ok((value, render)) => Ok(ToolExecOutcome { value, render }),
            Err(err) => Err(err),
        }
    }
}

/// Append the tail of the captured logs to a failure message (bounded).
struct FailureCtx(Option<String>);
impl FailureCtx {
    fn err(self, err: String) -> String {
        match self.0 {
            Some(logs) if !logs.is_empty() => {
                const TAIL: usize = 2048;
                let count = logs.chars().count();
                let tail: String = if count > TAIL {
                    logs.chars().skip(count - TAIL).collect()
                } else {
                    logs
                };
                format!("{err}\n[run_code] logs:\n{tail}")
            }
            _ => err,
        }
    }
}

// ---- the broker loop ----------------------------------------------------------

/// One full run_code round trip. Returns the canonical final value on success;
/// `Err` carries either a program exception (plain text) or a structured
/// infrastructure failure (`run_code: code=...`).
async fn broker_run(
    config: &RunCodeConfig,
    registry: Arc<RegistryHandle>,
    events: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
    seq: &AtomicU64,
    parent_id: String,
    args: Value,
) -> Result<(Value, Option<String>), String> {
    // --- argument validation ---------------------------------------------
    let code = arg_str(&args, "code")?.to_owned();
    if code.trim().is_empty() {
        return Err(format!("{ERROR_PREFIX}: code=invalid_arg msg=\"'code' must be a non-empty Python program\""));
    }
    let timeout = match args.get("timeout_ms") {
        None => config.timeout,
        Some(v) => {
            let ms = v
                .as_i64()
                .ok_or_else(|| format!("{ERROR_PREFIX}: code=invalid_arg msg=\"timeout_ms must be an integer\""))?;
            if ms < 1 {
                return Err(format!("{ERROR_PREFIX}: code=invalid_arg msg=\"timeout_ms must be >= 1, got {ms}\""));
            }
            let max_ms = MAX_TIMEOUT.as_millis() as i64;
            if ms > max_ms {
                return Err(format!("{ERROR_PREFIX}: code=invalid_arg msg=\"timeout_ms={ms} exceeds the run_code maximum {max_ms}ms\""));
            }
            Duration::from_millis(ms as u64)
        }
    };
    let registry = registry.resolve().ok_or_else(|| {
        format!("{ERROR_PREFIX}: code=registry msg=\"the tool registry is not bound\"")
    })?;

    // --- assemble + place the program, then spawn -------------------------
    let script_name = format!(
        "run_code_{}_{}.py",
        std::process::id(),
        seq.fetch_add(1, Ordering::Relaxed)
    );
    let workdir = sandbox::default_workdir(&config.sandbox)
        .await
        .map_err(|e| format!("{ERROR_PREFIX}: code=config msg={e}"))?;
    let sdk_dir = workdir.join(".celestea");
    tokio::fs::create_dir_all(&sdk_dir)
        .await
        .map_err(|e| format!("{ERROR_PREFIX}: code=config msg=\"cannot create '{}': {e}\"", sdk_dir.display()))?;
    let script_path = sdk_dir.join(&script_name);
    tokio::fs::write(&script_path, assemble_program(&code))
        .await
        .map_err(|e| format!("{ERROR_PREFIX}: code=spawn msg=\"cannot write program file '{}': {e}\"", script_path.display()))?;
    // Best-effort script cleanup on every exit path.
    struct ScriptCleanup(PathBuf);
    impl Drop for ScriptCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = ScriptCleanup(script_path.clone());

    let command = format!("python3 -uB .celestea/{script_name}");
    let mut spawned = match sandbox::spawn_sandboxed(&command, &config.sandbox, None).await {
        Ok(s) => s,
        Err(e) => return Err(format!("{ERROR_PREFIX}: code=spawn msg={e}")),
    };
    let mut stdin = spawned
        .stdin
        .take()
        .ok_or_else(|| format!("{ERROR_PREFIX}: code=spawn msg=\"no stdin pipe (reply channel)\""))?;
    let mut stdout = BufReader::new(spawned.stdout);
    let stderr_task = tokio::spawn(sandbox::read_capped(spawned.stderr, config.max_log_bytes));
    let mut guard = ChildKillGuard::new(spawned.child);

    // --- broker loop -------------------------------------------------------
    let mut logs = String::new();
    let mut logs_truncated = false;
    let mut sub_output_bytes: usize = 0;
    let mut sub_output_dropped: usize = 0;
    let mut dispatched: u32 = 0;
    let mut final_value: Option<Value> = None;
    let mut program_error: Option<String> = None;
    let mut infra_error: Option<String> = None;
    let deadline = Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (line, truncated, eof) = match tokio::time::timeout(remaining, read_line_bounded(&mut stdout, MAX_LINE_BYTES)).await {
            Err(_elapsed) => {
                // Wall clock exceeded: kill the whole tree, keep what we have.
                let pid = guard.kill_now();
                let captured = logs.len();
                infra_error = Some(format!(
                    "{ERROR_PREFIX}: code=timeout msg=\"killed pid {} after {}ms (wall clock; stdout_log_captured_bytes={captured})\"",
                    pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into()),
                    timeout.as_millis(),
                ));
                break;
            }
            Ok(res) => res.map_err(|e| format!("{ERROR_PREFIX}: code=protocol msg=\"stdout read failed: {e}\""))?,
        };
        if eof {
            break; // no final line: handled after settle()
        }

        if truncated {
            // Over-long line: drained and treated as a log line (a protocol
            // line can never be valid if we cut it).
            append_bounded(&mut logs, &mut logs_truncated, line.as_bytes(), config.max_log_bytes);
            logs_truncated = logs_truncated || line.len() > config.max_log_bytes;
            continue;
        }

        let trimmed = line.trim_end();
        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(obj)) if obj.contains_key("__final__") => {
                final_value = obj.get("__final__").cloned();
                break;
            }
            Ok(Value::Object(obj)) if obj.contains_key("__error__") => {
                program_error = obj
                    .get("__error__")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some("unknown program error".into()));
                break;
            }
            Ok(Value::Object(obj)) => {
                let id = obj.get("id").and_then(Value::as_u64);
                let tool = obj.get("tool").and_then(Value::as_str);
                let sub_args = match obj.get("args") {
                    Some(Value::Object(o)) => Some(Value::Object(o.clone())),
                    Some(_) | None => None,
                };
                if let (Some(id), Some(tool), Some(sub_args)) = (id, tool, sub_args) {
                    // ---- a protocol request: enforce limits + dispatch -----
                    let reply = if !SDK_TOOLS.contains(&tool) {
                        json!({
                            "id": id,
                            "ok": false,
                            "error": format!("tool '{tool}' not exposed in run_code SDK"),
                        })
                    } else if dispatched >= config.max_sub_calls {
                        json!({
                            "id": id,
                            "ok": false,
                            "error": format!(
                                "run_code: sub-call limit exceeded (max {})",
                                config.max_sub_calls
                            ),
                        })
                    } else {
                        dispatched += 1;
                        let sub_call_id = format!("{parent_id}:c{id}");
                        let input = ToolInput {
                            call_id: sub_call_id.clone(),
                            name: tool.to_string(),
                            args: sub_args,
                        };
                        if let Some(sink) = &events {
                            sink(SessionEvent::ToolCall {
                                id: sub_call_id.clone(),
                                name: tool.to_string(),
                                args: input.args.clone(),
                                parent_id: Some(parent_id.clone()),
                            });
                        }
                        let out = registry.dispatch(input).await;
                        if let Some(sink) = &events {
                            sink(SessionEvent::ToolResult {
                                id: sub_call_id,
                                value: out.value.clone(),
                                error: out.error.clone(),
                                parent_id: Some(parent_id.clone()),
                            });
                        }
                        match out.error {
                            Some(err) => json!({ "id": id, "ok": false, "error": err }),
                            None => {
                                let value = out.value.unwrap_or(Value::Null);
                                let serialized = serde_json::to_string(&value).unwrap_or_default();
                                let remaining =
                                    config.max_sub_output_bytes.saturating_sub(sub_output_bytes);
                                if serialized.len() <= remaining {
                                    sub_output_bytes += serialized.len();
                                    json!({ "id": id, "ok": true, "value": value })
                                } else {
                                    let cut = truncate_value(value, remaining);
                                    let cut_len = serde_json::to_string(&cut).unwrap_or_default().len();
                                    sub_output_bytes += cut_len;
                                    sub_output_dropped += serialized.len().saturating_sub(cut_len);
                                    json!({
                                        "id": id,
                                        "ok": true,
                                        "value": cut,
                                        "truncated": true,
                                        "warning": format!(
                                            "sub-call output budget ({} bytes) exceeded; value truncated",
                                            config.max_sub_output_bytes
                                        ),
                                    })
                                }
                            }
                        }
                    };
                    let reply_line = serde_json::to_string(&reply).unwrap_or_else(|_| {
                        serde_json::to_string(&json!({ "id": id, "ok": false, "error": "reply not serializable" }))
                            .unwrap_or_default()
                    });
                    if let Err(e) = write_reply(&mut stdin, &reply_line).await {
                        infra_error = Some(format!(
                            "{ERROR_PREFIX}: code=protocol msg=\"cannot write reply to the program (stdin closed): {e}\""
                        ));
                        break;
                    }
                } else {
                    // JSON that is not a request / final / error line -> log.
                    append_bounded(&mut logs, &mut logs_truncated, trimmed.as_bytes(), config.max_log_bytes);
                    logs_truncated = logs_truncated || trimmed.len() > config.max_log_bytes;
                }
            }
            _ => {
                // Not JSON at all -> a program log line.
                append_bounded(&mut logs, &mut logs_truncated, trimmed.as_bytes(), config.max_log_bytes);
                logs_truncated = logs_truncated || trimmed.len() > config.max_log_bytes;
            }
        }
    }

    // Close our end of the reply channel: a program still blocked in a bridge
    // call sees EOF and raises instead of hanging forever.
    drop(stdin);

    // Settle the child (natural exit within a grace period, else kill).
    let (status, killed) = guard.settle(EXIT_GRACE).await;
    let exit_code = status.as_ref().and_then(|s| s.code());
    let (stderr_bytes, stderr_truncated) = stderr_task
        .await
        .unwrap_or_else(|_| (Vec::new(), false));

    // --- outcome -----------------------------------------------------------
    let error = match (&infra_error, &program_error) {
        (Some(e), _) => Some(e.clone()),
        (None, Some(p)) => Some(p.clone()),
        (None, None) if final_value.is_none() => Some(format!(
            "{ERROR_PREFIX}: code=aborted msg=\"program exited code={} (killed={killed}) without a final line\"",
            exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
        )),
        (None, None) => None,
    };
    let render = compose_render(
        &logs,
        logs_truncated,
        &stderr_bytes,
        stderr_truncated,
        sub_output_dropped,
    );
    if let Some(err) = error {
        return Err(FailureCtx(render).err(err));
    }
    Ok((final_value.unwrap_or(Value::Null), render))
}


async fn write_reply(stdin: &mut tokio::process::ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

/// Human rendering of the run: stdout logs (≤64KiB) + stderr tail + budget
/// warnings. The canonical ToolOutput.value stays the program's final value.
fn compose_render(
    logs: &str,
    logs_truncated: bool,
    stderr: &[u8],
    stderr_truncated: bool,
    sub_output_dropped: usize,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if !logs.is_empty() {
        parts.push(logs.to_string());
    }
    if logs_truncated {
        parts.push(format!("[run_code] stdout logs truncated at {MAX_LOG_BYTES} bytes"));
    }
    let stderr_text = String::from_utf8_lossy(stderr).into_owned();
    if !stderr_text.is_empty() {
        parts.push(format!("[stderr]\n{stderr_text}"));
    }
    if stderr_truncated {
        parts.push(format!("[run_code] stderr truncated at {MAX_LOG_BYTES} bytes"));
    }
    if sub_output_dropped > 0 {
        parts.push(format!(
            "[run_code] warning: sub-call output budget ({MAX_SUB_OUTPUT_BYTES} bytes) exceeded — {sub_output_dropped} bytes dropped"
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

// ---- spec ---------------------------------------------------------------------

/// The run_code tool schema (W255). `description` documents the SDK surface,
/// the main() convention and the three hard limits.
pub fn run_code_spec() -> ToolSpec {
    ToolSpec {
        name: "run_code".into(),
        description: format!(
            "Execute a Python program in the sandbox and get its final value in ONE round trip (Python parent-broker, W255). Write the program as an `async def main():` function body, or a complete script defining main; main()'s return value (lossless JSON) is the final result. Inside the program the SDK exposes four synchronous bridges dispatched through the normal guarded tool pipeline: tools.read_file(path=...) / tools.write_file(path=..., content=...) / tools.list_dir(path=...) / tools.run_shell(command=...); a denied or failed sub-call raises ToolCallError (catch it and continue). Only print() what the model needs: stdout lines become logs (≤{} bytes, UI render only); intermediate sub-call results are recorded in the session log but context-retained (the model sees only the final value). Hard limits: ≤{} sub-calls (the next one errors), wall clock ≤{}ms (timeout_ms, default {}), sub-call output ledger ≤{} bytes (truncated with a warning). No network; the same sandbox as run_shell (bwrap/raw/userspace + rlimits).",
            MAX_LOG_BYTES,
            MAX_SUB_CALLS,
            MAX_TIMEOUT.as_millis(),
            DEFAULT_TIMEOUT.as_millis(),
            MAX_SUB_OUTPUT_BYTES
        ),
        parameters: json!({
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python source: an `async def main():` function body, or a complete script that defines main. The engine injects the SDK preamble (tools bridge + protocol)."
                },
                "description": {
                    "type": "string",
                    "description": "Optional short summary (5-10 words) of what the program does; used as the run's card title."
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 120000,
                    "description": "Optional whole-run wall clock in ms. Default 120000; hard cap 120000 (CELAESTEA_RUN_CODE_TIMEOUT_MS tunes the default, never the cap)."
                }
            },
            "required": ["code"],
            "additionalProperties": false
        }),
    }
}


// ---- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use celestea_core::{ToolDecision, ToolGuard, ToolOutput, ToolSpec};
    use std::sync::Mutex;

    use crate::builtin::builtin_tools;
    use crate::registry::ToolRegistryImpl;

    // --- fakes -----------------------------------------------------------------

    /// A ToolRegistry whose dispatch is a plain closure (echo / big-value /
    /// scripted replies) — the "mock registry 回显" of the P0 test matrix.
    struct MockRegistry {
        f: Box<dyn Fn(&ToolInput) -> ToolOutput + Send + Sync>,
    }

    impl MockRegistry {
        fn echo() -> Self {
            Self {
                f: Box::new(|input| ToolOutput {
                    call_id: input.call_id.clone(),
                    value: Some(json!({ "echo": input.name.clone(), "args": input.args.clone() })),
                    render: None,
                    error: None,
                    decision: Some(ToolDecision::Allow),
                }),
            }
        }

        fn big_string(n: usize) -> Self {
            Self {
                f: Box::new(move |input| ToolOutput {
                    call_id: input.call_id.clone(),
                    value: Some(json!("x".repeat(n))),
                    render: None,
                    error: None,
                    decision: Some(ToolDecision::Allow),
                }),
            }
        }
    }

    #[async_trait]
    impl ToolRegistry for MockRegistry {
        fn register(&mut self, _tool: Box<dyn Tool>) {}
        fn add_guard(&mut self, _guard: Box<dyn ToolGuard>) {}
        fn get(&self, _name: &str) -> Option<&dyn Tool> {
            None
        }
        fn schemas(&self) -> Vec<ToolSpec> {
            vec![]
        }
        async fn dispatch(&self, input: ToolInput) -> ToolOutput {
            (self.f)(&input)
        }
    }

    /// Denies every tool EXCEPT run_code itself — models a production guard
    /// that lets the outer run through while its sub-calls get refused.
    struct DenySubCalls;
    #[async_trait]
    impl ToolGuard for DenySubCalls {
        async fn check(&self, input: &ToolInput) -> ToolDecision {
            if input.name == "run_code" {
                ToolDecision::Allow
            } else {
                ToolDecision::Deny("policy says no".into())
            }
        }
    }

    type EventLog = Arc<Mutex<Vec<SessionEvent>>>;

    fn event_sink() -> (EventLog, Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>) {
        let log: EventLog = Arc::new(Mutex::new(Vec::new()));
        let sink: Arc<dyn Fn(SessionEvent) + Send + Sync> = {
            let log = log.clone();
            Arc::new(move |ev| log.lock().unwrap().push(ev))
        };
        (log, Some(sink))
    }

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("celestea-run-code-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    fn test_cfg(dir: &std::path::Path) -> RunCodeConfig {
        RunCodeConfig::new()
            .with_workdir(dir)
            .with_root(dir)
            .with_timeout(Duration::from_secs(30))
    }

    /// run_code needs a working python3 inside the sandbox; skip (not fail)
    /// when the host cannot provide one right now (nproc pressure / missing
    /// binary) — same policy as the W249 fork-health probes.
    async fn python_sandbox_healthy(cfg: &RunCodeConfig) -> bool {
        matches!(
            crate::sandbox::execute_sandboxed("python3 -c 'print(1)'", &cfg.sandbox, None, None).await,
            Ok(out) if out.exit_code == Some(0) && out.stdout == b"1\n"
        )
    }

    /// run_code over a mock registry (echo / scripted), no real tools. The
    /// caller keeps the `Arc<dyn ToolRegistry>` alive in its own scope and
    /// binds it into the tool's RegistryHandle (production wiring parity).
    fn mock_tool(
        cfg: RunCodeConfig,
        reg: &Arc<dyn ToolRegistry>,
        events: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
    ) -> Box<dyn Tool> {
        let (tool, handle) = run_code_tool_with_handle(cfg, events);
        handle.set(Arc::downgrade(reg));
        tool
    }

    /// Full real registry (builtin tools + optional guard) with run_code
    /// registered through a Weak of the shared Arc (the production wiring).
    fn real_registry_with_run_code(
        cfg: RunCodeConfig,
        events: Option<Arc<dyn Fn(SessionEvent) + Send + Sync>>,
        guard: Option<Box<dyn ToolGuard>>,
    ) -> Arc<ToolRegistryImpl> {
        let mut reg = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            reg.register(tool);
        }
        if let Some(g) = guard {
            reg.add_guard(g);
        }
        let mut reg = Arc::new(reg);
        let (tool, handle) = run_code_tool_with_handle(cfg, events);
        Arc::get_mut(&mut reg)
            .expect("sole owner")
            .register(tool);
        let weak = {
            let dyn_clone: Arc<dyn ToolRegistry> = reg.clone();
            Arc::downgrade(&dyn_clone)
        };
        handle.set(weak);
        reg
    }

    // --- pure unit tests --------------------------------------------------------

    #[test]
    fn assemble_program_wraps_indented_body_into_async_main() {
        let program = assemble_program("    return tools.read_file(path=\"/x\")");
        assert!(program.contains("async def main():"), "{program}");
        assert!(program.contains("    return tools.read_file(path=\"/x\")"), "{program}");
        assert!(program.contains("__final__"));
    }

    #[test]
    fn assemble_program_keeps_complete_script_with_main() {
        let script = "async def main():\n    return 1\n";
        let program = assemble_program(script);
        assert!(program.contains("async def main():"), "{program}");
        assert!(!program.contains("async def main():\n\nasync def main()"), "must not double-wrap");
        assert!(program.contains("__final__"));
    }

    #[test]
    fn run_code_spec_documents_limits_and_sdk() {
        let spec = run_code_spec();
        assert_eq!(spec.name, "run_code");
        assert_eq!(spec.parameters["required"], json!(["code"]));
        assert_eq!(spec.parameters["properties"]["timeout_ms"]["maximum"], json!(120_000));
        assert_eq!(spec.parameters["properties"]["timeout_ms"]["minimum"], json!(1));
        let desc = &spec.description;
        assert!(desc.contains("ToolCallError"), "{desc}");
        assert!(desc.contains("read_file"), "{desc}");
        assert!(desc.contains("write_file"), "{desc}");
        assert!(desc.contains("list_dir"), "{desc}");
        assert!(desc.contains("run_shell"), "{desc}");
        assert!(desc.contains("sub-calls"), "{desc}");
        assert!(desc.contains("120000"), "{desc}");
        assert!(desc.contains("262144"), "{desc}");
        assert!(desc.contains("65536"), "{desc}");
    }

    // --- parent-broker protocol tests (all spawn python3 in the sandbox) -------

    /// P0 matrix: parent-broker round trip against a mock registry that echoes
    /// each sub-call; asserts the exact JSON-RPC request/reply shape, the
    /// kwargs AND positional-dict call forms, and the sub-call event log
    /// (id "<rcid>:c<n>", parent_id Some(rcid)).
    #[tokio::test]
    async fn parent_broker_echo_round_trip() {
        let dir = tmp_dir("echo");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let (events, sink) = event_sink();
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, sink);

        let code = r#"
async def main():
    a = tools.read_file(path="/tmp/x.txt")          # kwargs form
    b = tools.run_shell({"command": "printf hi"})   # positional-dict form
    c = tools.list_dir(path="/tmp")
    return {"a": a, "b": b, "c": c}
"#;
        let out = tool
            .execute_with(ToolInput {
                call_id: "rc-echo".into(),
                name: "run_code".into(),
                args: json!({ "code": code, "description": "echo three sub-calls" }),
            })
            .await
            .expect("run_code success");
        assert_eq!(
            out.value,
            json!({
                "a": {"echo": "read_file", "args": {"path": "/tmp/x.txt"}},
                "b": {"echo": "run_shell", "args": {"command": "printf hi"}},
                "c": {"echo": "list_dir", "args": {"path": "/tmp"}},
            }),
            "render: {:?}",
            out.render
        );
        assert_eq!(out.render, None, "no logs printed");

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 6, "3 sub-calls x (call + result): {evs:?}");
        for (i, name) in ["read_file", "run_shell", "list_dir"].iter().enumerate() {
            let n = i + 1;
            match &evs[2 * i] {
                SessionEvent::ToolCall { id, name: n2, parent_id, .. } => {
                    assert_eq!(id, &format!("rc-echo:c{n}"));
                    assert_eq!(n2, name);
                    assert_eq!(parent_id.as_deref(), Some("rc-echo"));
                }
                other => panic!("expected sub-call ToolCall, got {other:?}"),
            }
            match &evs[2 * i + 1] {
                SessionEvent::ToolResult { id, error, parent_id, .. } => {
                    assert_eq!(id, &format!("rc-echo:c{n}"));
                    assert_eq!(error, &None);
                    assert_eq!(parent_id.as_deref(), Some("rc-echo"));
                }
                other => panic!("expected sub-call ToolResult, got {other:?}"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: a guard denial on a sub-call flows back as a catchable
    /// ToolCallError (ok:false reply), the run still completes, and the
    /// denied sub-call is fully logged (ToolCall + ToolResult with the
    /// "denied: ..." error and parent_id).
    #[tokio::test]
    async fn guard_denial_flows_back_as_tool_call_error() {
        let dir = tmp_dir("guard-deny");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let (events, sink) = event_sink();
        let reg = real_registry_with_run_code(cfg, sink, Some(Box::new(DenySubCalls)));

        let code = r#"
async def main():
    try:
        tools.read_file(path="/tmp/x")
    except ToolCallError as e:
        return "caught: " + str(e)
    return "not caught"
"#;
        let out = reg
            .dispatch(ToolInput {
                call_id: "rc-deny".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await;
        assert!(out.error.is_none(), "unexpected tool error: {:?}", out.error);
        assert_eq!(
            out.value,
            Some(json!("caught: tool 'read_file' failed: denied: policy says no"))
        );

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 2, "{evs:?}");
        match &evs[1] {
            SessionEvent::ToolResult { id, error, parent_id, .. } => {
                assert_eq!(id, "rc-deny:c1");
                assert_eq!(error.as_deref(), Some("denied: policy says no"));
                assert_eq!(parent_id.as_deref(), Some("rc-deny"));
            }
            other => panic!("expected denied ToolResult, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: the 21st sub-call is refused with a limit error (no
    /// dispatch, no event rows); 20 sub-call pairs are logged.
    #[tokio::test]
    async fn sub_call_limit_twenty_rejects_twenty_first() {
        let dir = tmp_dir("limit");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let (events, sink) = event_sink();
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, sink);

        let code = r#"
async def main():
    try:
        for _ in range(30):
            tools.read_file(path="/x")
    except ToolCallError as e:
        return "caught: " + str(e)
    return "no error"
"#;
        let out = tool
            .execute_with(ToolInput {
                call_id: "rc-limit".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect("success");
        let v = out.value.as_str().expect("string final value");
        assert!(v.contains("caught: "), "{v}");
        assert!(v.contains("sub-call limit exceeded (max 20)"), "{v}");

        let evs = events.lock().unwrap();
        assert_eq!(evs.len(), 40, "exactly 20 dispatched sub-calls logged: {evs:?}");
        assert!(matches!(
            &evs[0],
            SessionEvent::ToolCall { id, .. } if id == "rc-limit:c1"
        ));
        assert!(matches!(
            &evs[38],
            SessionEvent::ToolCall { id, .. } if id == "rc-limit:c20"
        ));
        assert!(matches!(
            &evs[39],
            SessionEvent::ToolResult { id, .. } if id == "rc-limit:c20"
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: wall-clock timeout kills the whole process tree and yields
    /// a structured timeout error.
    #[tokio::test]
    async fn wall_clock_timeout_kills_the_program() {
        let dir = tmp_dir("timeout");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        let code = "while True:\n    pass\n"; // busy spin — must be killed
        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-timeout".into(),
                name: "run_code".into(),
                args: json!({ "code": code, "timeout_ms": 800 }),
            })
            .await
            .expect_err("spin must time out");
        assert!(err.starts_with("run_code: code=timeout"), "{err}");
        assert!(err.contains("800ms"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: sub-call output budget (256KiB) — oversized values are
    /// truncated (prefix kept), the reply carries truncated:true + a warning,
    /// and the outer render carries the dropped-bytes warning.
    #[tokio::test]
    async fn sub_call_output_budget_truncates_with_warning() {
        let dir = tmp_dir("budget");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::big_string(300_000));
        let tool = mock_tool(cfg, &reg, None);

        let code = r#"
async def main():
    v = tools.read_file(path="/big")
    return len(v)
"#;
        let out = tool
            .execute_with(ToolInput {
                call_id: "rc-budget".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect("success");
        assert_eq!(out.value, json!(MAX_SUB_OUTPUT_BYTES), "value cut to 256KiB");
        let render = out.render.expect("warning render");
        assert!(render.contains("sub-call output budget"), "{render}");
        assert!(render.contains("dropped"), "{render}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: program stdout logs are capped at 64KiB (prefix kept, the
    /// final value unaffected, a truncation marker in the render).
    #[tokio::test]
    async fn stdout_logs_are_capped_at_64_kib() {
        let dir = tmp_dir("logs");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        let code = r#"
async def main():
    print("x" * 100000, flush=True)
    return "done"
"#;
        let out = tool
            .execute_with(ToolInput {
                call_id: "rc-logs".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect("success");
        assert_eq!(out.value, json!("done"));
        let render = out.render.expect("logs render");
        assert!(render.starts_with('x'), "logs prefix kept");
        assert!(render.contains("stdout logs truncated at 65536 bytes"), "{render}");
        assert!(render.len() <= MAX_LOG_BYTES + 128, "render bounded: {}", render.len());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: the SDK whitelist — any tool outside
    /// read_file/write_file/list_dir/run_shell is refused by the parent
    /// ("not exposed in run_code SDK"), including run_code itself, and the
    /// SDK side has no such attribute at all.
    #[tokio::test]
    async fn sdk_whitelist_rejects_other_tools() {
        let dir = tmp_dir("whitelist");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        // parent-side refusal of raw protocol lines (defense in depth):
        let code = r#"
import json, sys
async def main():
    out = []
    for i, name in enumerate(["http_request", "run_code"], start=1):
        print(json.dumps({"id": i, "tool": name, "args": {}}), flush=True)
        reply = json.loads(sys.stdin.readline())
        out.append(reply.get("error"))
    # SDK-side: no such attribute at all
    try:
        tools.http_request(url="http://x")
        out.append("attr-missing")
    except AttributeError:
        out.append("attr-ok")
    return out
"#;
        let out = tool
            .execute_with(ToolInput {
                call_id: "rc-wl".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect("success");
        assert_eq!(
            out.value,
            json!([
                "tool 'http_request' not exposed in run_code SDK",
                "tool 'run_code' not exposed in run_code SDK",
                "attr-ok",
            ])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: an uncaught program exception becomes the ToolResult error
    /// (with a bounded log tail carrying the traceback), value stays None.
    #[tokio::test]
    async fn program_exception_becomes_error_with_log_tail() {
        let dir = tmp_dir("exc");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        let code = r#"
async def main():
    print("before boom")
    raise ValueError("boom")
"#;
        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-exc".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect_err("program error");
        assert!(err.starts_with("ValueError: boom\n[run_code] logs:\n"), "{err}");
        assert!(err.contains("before boom"), "log lines precede the traceback: {err}");
        assert!(err.contains("Traceback (most recent call last)"), "{err}");
        assert!(err.contains("raise ValueError(\"boom\")"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: a non-JSON-serializable main() return value surfaces as the
    /// program error (lossless-JSON contract).
    #[tokio::test]
    async fn non_json_return_value_is_a_program_error() {
        let dir = tmp_dir("nonjson");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        let code = r#"
async def main():
    return object()
"#;
        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-nonjson".into(),
                name: "run_code".into(),
                args: json!({ "code": code }),
            })
            .await
            .expect_err("non-JSON return");
        assert!(err.contains("not JSON serializable"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0 matrix: argument validation — missing code, empty code, and
    /// timeout_ms above the 120000 cap are structured tool errors.
    #[tokio::test]
    async fn invalid_args_are_structured_errors() {
        let dir = tmp_dir("args");
        let cfg = test_cfg(&dir);
        if !python_sandbox_healthy(&cfg).await {
            eprintln!("skip: python3 unavailable in the sandbox right now");
            return;
        }
        let reg: Arc<dyn ToolRegistry> = Arc::new(MockRegistry::echo());
        let tool = mock_tool(cfg, &reg, None);

        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-a1".into(),
                name: "run_code".into(),
                args: json!({}),
            })
            .await
            .expect_err("missing code");
        assert!(err.contains("missing 'code'"), "{err}");

        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-a2".into(),
                name: "run_code".into(),
                args: json!({ "code": "   \n" }),
            })
            .await
            .expect_err("empty code");
        assert!(err.starts_with("run_code: code=invalid_arg"), "{err}");

        let err = tool
            .execute_with(ToolInput {
                call_id: "rc-a3".into(),
                name: "run_code".into(),
                args: json!({ "code": "return 1", "timeout_ms": 999_999 }),
            })
            .await
            .expect_err("timeout above cap");
        assert!(err.contains("exceeds the run_code maximum 120000ms"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
