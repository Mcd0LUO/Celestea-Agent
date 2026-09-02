//! v1 execution sandbox for the `run_shell` builtin tool (W209).
//!
//! The bare `sh -c` / `cmd /C` execution is turned into a bounded,
//! deterministic environment with five pragmatic guarantees. This is a
//! *userspace* sandbox: **no** OS-level namespace/seccomp isolation in v1
//! (see [`OsSandboxLayer`] for the v2 extension point).
//!
//! 1. **Timeout** — commands are killed at [`SandboxConfig::timeout`]
//!    (default 30s). A per-call `timeout_ms` override is allowed, bounded by
//!    [`SandboxConfig::max_timeout`]. On unix the child leads its own process
//!    group (via `process_group(0)`) and the whole group receives SIGKILL; a
//!    bounded grace wait reaps it. Failure is [`SandboxError::Timeout`] with
//!    captured byte counts and small previews.
//! 2. **Output cap** — stdout and stderr are each capped at
//!    [`SandboxConfig::max_output_bytes`] (default 64 KiB). Bytes past the cap
//!    are drained (never buffered), so the child can never block on a full
//!    pipe; truncation is reported via `stdout_truncated` / `stderr_truncated`.
//! 3. **Workdir control** — commands always start in
//!    [`SandboxConfig::workdir`] (default: the process cwd pinned when the
//!    config is built; override with `CELAESTEA_RUN_SHELL_WORKDIR`). A
//!    per-call `workdir` override must already exist and resolve inside
//!    [`SandboxConfig::root`] — by default the git top-level containing the
//!    workdir, else the workdir itself (i.e. fully pinned; widen with
//!    `CELAESTEA_RUN_SHELL_ROOT`). Violations are structured
//!    [`SandboxError::Workdir*`] errors carrying the offending path and the
//!    root, plus the env knobs that control them.
//! 4. **Env sanitization** — the child inherits nothing but a small allowance
//!    (`PATH`, locale vars, `TERM`, `TMPDIR`; plus `SystemRoot`/`TEMP`/… on
//!    Windows). Host secrets (`*_API_KEY`, `HOME`-based credential files,
//!    …) never reach the child. Deliberate additions go through
//!    [`SandboxConfig::extra_env`] only.
//! 5. **Structured errors** — every violation maps to a [`SandboxError`]
//!    variant; `Display` emits `run_shell-sandbox: code=<code> msg=<…>` with a
//!    stable prefix and code. The tool seam keeps its
//!    `ToolOutput { value, render, error, decision }` contract untouched:
//!    violations surface as `ToolOutput::error` with `decision: Allow`.
//!
//! v2 extension point: [`OsSandboxLayer`] (namespaces / seccomp / landlock /
//! bubblewrap) — install a real layer via [`SandboxConfig::with_os_layer`] and
//! `apply` runs right before spawn, without touching call sites or the seam.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

// ---- configuration knobs (env + in-code) -------------------------------------

/// Default kill deadline for a command.
pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Upper bound for per-call `timeout_ms` overrides.
pub(crate) const DEFAULT_MAX_TIMEOUT: Duration = Duration::from_secs(120);
/// Default per-stream output cap (64 KiB).
pub(crate) const DEFAULT_MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Stable prefix of every structured sandbox error emitted by this module.
pub(crate) const ERROR_PREFIX: &str = "run_shell-sandbox";

/// Env var: default timeout in milliseconds.
pub(crate) const ENV_TIMEOUT_MS: &str = "CELAESTEA_RUN_SHELL_TIMEOUT_MS";
/// Env var: max per-call timeout in milliseconds.
pub(crate) const ENV_MAX_TIMEOUT_MS: &str = "CELAESTEA_RUN_SHELL_MAX_TIMEOUT_MS";
/// Env var: per-stream output cap in bytes.
pub(crate) const ENV_MAX_OUTPUT_BYTES: &str = "CELAESTEA_RUN_SHELL_MAX_OUTPUT_BYTES";
/// Env var: fixed sandbox workdir.
pub(crate) const ENV_WORKDIR: &str = "CELAESTEA_RUN_SHELL_WORKDIR";
/// Env var: root every resolved workdir must stay inside.
pub(crate) const ENV_ROOT: &str = "CELAESTEA_RUN_SHELL_ROOT";

/// Host env vars v1 passes through to the child. `HOME` is deliberately
/// excluded (`~/.ssh`, `~/.aws`, `~/.gnupg`, …); secret-looking vars are
/// excluded by whitelisting rather than blacklisting.
pub(crate) const ENV_ALLOWLIST: &[&str] =
    &["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "TMPDIR"];
#[cfg(windows)]
const ENV_ALLOWLIST_WINDOWS: &[&str] = &["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"];

// ---- v2 extension point -------------------------------------------------------

/// Hook for the v2 OS-level sandbox (namespaces, seccomp, landlock,
/// bubblewrap, seccomp profiles, …). v1 ships [`NullOsSandbox`]; install a
/// real layer with [`SandboxConfig::with_os_layer`] and `apply` runs right
/// before spawn — no call-site or seam changes.
pub(crate) trait OsSandboxLayer: Send + Sync + std::fmt::Debug {
    fn apply(&self, cmd: &mut Command) -> Result<(), String>;
}

/// v1 no-op layer: sandboxing is userspace-only.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct NullOsSandbox;

impl OsSandboxLayer for NullOsSandbox {
    fn apply(&self, _cmd: &mut Command) -> Result<(), String> {
        Ok(())
    }
}

// ---- config -------------------------------------------------------------------

/// Tuning knobs for the v1 sandbox.
#[derive(Debug, Clone)]
pub(crate) struct SandboxConfig {
    /// Kill deadline when no per-call override is given.
    pub(crate) timeout: Duration,
    /// Upper bound accepted for a per-call `timeout_ms` override.
    pub(crate) max_timeout: Duration,
    /// Per-stream (stdout / stderr) capture cap in bytes.
    pub(crate) max_output_bytes: usize,
    /// Fixed workdir: default cwd of every command.
    pub(crate) workdir: PathBuf,
    /// Canonical prefix every resolved workdir must stay inside.
    pub(crate) root: PathBuf,
    /// Deliberate operator env injected on top of the allowlist.
    pub(crate) extra_env: Vec<(String, String)>,
    /// v2 OS-sandbox layer applied right before spawn.
    pub(crate) os_layer: Arc<dyn OsSandboxLayer>,
}

impl Default for SandboxConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl SandboxConfig {
    /// Defaults: 30s timeout / 120s per-call cap / 64 KiB per stream;
    /// workdir = pinned process cwd; root = git top-level containing the
    /// workdir (else the workdir itself, i.e. fully pinned).
    pub(crate) fn new() -> Self {
        let workdir = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
        let root = git_toplevel_or(&workdir);
        Self {
            timeout: DEFAULT_TIMEOUT,
            max_timeout: DEFAULT_MAX_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            workdir,
            root,
            extra_env: Vec::new(),
            os_layer: Arc::new(NullOsSandbox),
        }
    }

    /// `new()` after applying `CELAESTEA_RUN_SHELL_*` env overrides, so
    /// operators can tune the sandbox without code changes.
    pub(crate) fn from_env() -> Self {
        let mut cfg = Self::new();
        if let Some(ms) = env_u64(ENV_TIMEOUT_MS).filter(|&ms| ms > 0) {
            cfg = cfg.with_timeout(Duration::from_millis(ms));
        }
        if let Some(ms) = env_u64(ENV_MAX_TIMEOUT_MS).filter(|&ms| ms > 0) {
            cfg = cfg.with_max_timeout(Duration::from_millis(ms));
        }
        if let Some(n) = env_u64(ENV_MAX_OUTPUT_BYTES).filter(|&n| n > 0) {
            cfg = cfg.with_max_output_bytes(n as usize);
        }
        if let Some(p) = std::env::var_os(ENV_WORKDIR) {
            cfg = cfg.with_workdir(p);
        }
        if let Some(p) = std::env::var_os(ENV_ROOT) {
            cfg = cfg.with_root(p);
        }
        cfg
    }

    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub(crate) fn with_max_timeout(mut self, max: Duration) -> Self {
        self.max_timeout = max;
        self
    }

    pub(crate) fn with_max_output_bytes(mut self, n: usize) -> Self {
        self.max_output_bytes = n;
        self
    }

    pub(crate) fn with_workdir(mut self, p: impl AsRef<Path>) -> Self {
        self.workdir = p.as_ref().to_path_buf();
        self
    }

    pub(crate) fn with_root(mut self, p: impl AsRef<Path>) -> Self {
        self.root = p.as_ref().to_path_buf();
        self
    }

    #[allow(dead_code)] // extension point: not exercised by the default builders
    pub(crate) fn with_extra_env(
        mut self,
        pairs: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        self.extra_env = pairs.into_iter().collect();
        self
    }

    #[allow(dead_code)] // v2 OS-sandbox extension point, not used in v1 defaults
    pub(crate) fn with_os_layer(mut self, layer: Arc<dyn OsSandboxLayer>) -> Self {
        self.os_layer = layer;
        self
    }
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.parse().ok()
}

// ---- errors -------------------------------------------------------------------

/// Structured failure of the v1 sandbox. `Display` emits
/// `run_shell-sandbox: code=<code> msg=<...>` (stable prefix + stable code,
/// quoted + escaped message) so tool callers and agents can branch reliably.
#[derive(Debug)]
pub(crate) enum SandboxError {
    /// Command exceeded the deadline and was killed (whole unix process
    /// group). Carries the captured bytes + short previews for diagnostics.
    Timeout {
        pid: Option<u32>,
        timeout_ms: u64,
        stdout_captured: usize,
        stderr_captured: usize,
        stdout_preview: String,
        stderr_preview: String,
    },
    /// Per-call or default workdir resolved outside `config.root`.
    WorkdirOutsideRoot { requested: String, root: String },
    /// Per-call workdir does not exist.
    WorkdirMissing { requested: String },
    /// Per-call workdir exists but is not a directory.
    WorkdirNotDir { requested: String },
    /// Invalid per-call argument (e.g. `timeout_ms` out of range).
    InvalidArg { message: String },
    /// Invalid sandbox configuration (e.g. zero cap / timeout).
    Config { message: String },
    /// The platform shell could not be started.
    Spawn { command: String, message: String },
}

impl SandboxError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            SandboxError::Timeout { .. } => "timeout",
            SandboxError::WorkdirOutsideRoot { .. }
            | SandboxError::WorkdirMissing { .. }
            | SandboxError::WorkdirNotDir { .. } => "workdir",
            SandboxError::InvalidArg { .. } => "arg",
            SandboxError::Config { .. } => "config",
            SandboxError::Spawn { .. } => "spawn",
        }
    }

    fn msg(&self) -> String {
        match self {
            SandboxError::Timeout {
                pid,
                timeout_ms,
                stdout_captured,
                stderr_captured,
                stdout_preview,
                stderr_preview,
            } => {
                let pid = pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into());
                format!(
                    "killed pid {pid} after {timeout_ms}ms (stdout_captured_bytes={stdout_captured} stderr_captured_bytes={stderr_captured} stdout_preview=\"{stdout_preview}\" stderr_preview=\"{stderr_preview}\")"
                )
            }
            SandboxError::WorkdirOutsideRoot { requested, root } => format!(
                "workdir '{requested}' is outside the sandbox root '{root}' (widen with {ENV_ROOT} or adjust {ENV_WORKDIR})"
            ),
            SandboxError::WorkdirMissing { requested } => {
                format!("workdir '{requested}' does not exist")
            }
            SandboxError::WorkdirNotDir { requested } => {
                format!("workdir '{requested}' is not a directory")
            }
            SandboxError::InvalidArg { message } => message.clone(),
            SandboxError::Config { message } => message.clone(),
            SandboxError::Spawn { command, message } => {
                format!("failed to start '{command}': {message}")
            }
        }
    }
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{ERROR_PREFIX}: code={} msg={}", self.code(), quoted(&self.msg()))
    }
}

/// One-line, escaped, truncated wrapper for messages (stable for logs/UI).
fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    out.push('"');
    for c in s.chars().take(512) {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Short lossy preview of captured output for timeout diagnostics.
fn preview(bytes: &[u8]) -> String {
    let n = bytes.len().min(512);
    String::from_utf8_lossy(&bytes[..n]).into_owned()
}

/// Truncated command preview for spawn errors (agent-facing).
fn command_preview(command: &str) -> String {
    let mut out: String = command.chars().take(256).collect();
    if command.chars().count() > 256 {
        out.push('…');
    }
    out
}

// ---- execution -----------------------------------------------------------------

/// Successful sandboxed run: capped streams + exit code + truncation flags.
#[derive(Debug)]
pub(crate) struct SandboxOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout_truncated: bool,
    pub(crate) stderr_truncated: bool,
}

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut { pid: Option<u32> },
    WaitFailed(String),
}

/// Execute `command` via the platform shell inside the v1 sandbox.
///
/// - `workdir_override`: optional per-call cwd. Must already exist and
///   resolve inside `config.root`; relative paths resolve against
///   `config.workdir`.
/// - `timeout_ms_override`: optional per-call kill deadline, bounded by
///   `config.max_timeout`.
pub(crate) async fn execute_sandboxed(
    command: &str,
    config: &SandboxConfig,
    workdir_override: Option<&str>,
    timeout_ms_override: Option<i64>,
) -> Result<SandboxOutput, SandboxError> {
    if config.max_output_bytes == 0 {
        return Err(SandboxError::Config {
            message: "max_output_bytes must be > 0".into(),
        });
    }
    if config.timeout.is_zero() {
        return Err(SandboxError::Config {
            message: "timeout must be > 0".into(),
        });
    }
    if config.max_timeout.is_zero() {
        return Err(SandboxError::Config {
            message: "max_timeout must be > 0".into(),
        });
    }

    let timeout = match timeout_ms_override {
        None => config.timeout,
        Some(ms) => {
            if ms < 1 {
                return Err(SandboxError::InvalidArg {
                    message: format!("timeout_ms must be >= 1, got {ms}"),
                });
            }
            let max_ms = config.max_timeout.as_millis() as u64;
            if ms as u64 > max_ms {
                return Err(SandboxError::InvalidArg {
                    message: format!("timeout_ms={ms} exceeds the sandbox maximum {max_ms}ms"),
                });
            }
            Duration::from_millis(ms as u64)
        }
    };

    let workdir = resolve_workdir(config, workdir_override).await?;

    let mut cmd = shell_command(command);
    cmd.current_dir(&workdir);
    cmd.stdin(Stdio::null()); // like the pre-sandbox `.output()`: never inherit stdio
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true); // drop reaps/kills even if our kill path is skipped
    #[cfg(unix)]
    cmd.process_group(0); // child leads its own pgid -> a timeout SIGKILLs the tree
    cmd.env_clear();
    for (k, v) in sanitized_env(config) {
        cmd.env(k, v);
    }
    config.os_layer.apply(&mut cmd).map_err(|e| SandboxError::Config {
        message: format!("os sandbox layer rejected the command: {e}"),
    })?;

    let mut child = cmd.spawn().map_err(|e| SandboxError::Spawn {
        command: command_preview(command),
        message: e.to_string(),
    })?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let cap = config.max_output_bytes;

    let out_fut = read_capped(stdout, cap);
    let err_fut = read_capped(stderr, cap);
    let wait_fut = async {
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => WaitOutcome::Exited(status),
            Ok(Err(e)) => WaitOutcome::WaitFailed(e.to_string()),
            Err(_elapsed) => {
                let pid = child.id();
                kill_process(&mut child);
                // Bounded grace reap; kill_on_drop covers the pathological case.
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                WaitOutcome::TimedOut { pid }
            }
        }
    };

    // Readers and the wait run concurrently: capping one stream while the
    // other still writes can never deadlock, and a timeout kills the child
    // while readers drain the (now closed) pipes.
    let ((stdout, stdout_truncated), (stderr, stderr_truncated), wait) =
        tokio::join!(out_fut, err_fut, wait_fut);

    let timeout_ms = timeout.as_millis() as u64;
    match wait {
        WaitOutcome::Exited(status) => Ok(SandboxOutput {
            stdout,
            stderr,
            exit_code: status.code(),
            stdout_truncated,
            stderr_truncated,
        }),
        WaitOutcome::TimedOut { pid } => Err(SandboxError::Timeout {
            pid,
            timeout_ms,
            stdout_captured: stdout.len(),
            stderr_captured: stderr.len(),
            stdout_preview: preview(&stdout),
            stderr_preview: preview(&stderr),
        }),
        WaitOutcome::WaitFailed(msg) => Err(SandboxError::Spawn {
            command: command_preview(command),
            message: msg,
        }),
    }
}

/// Resolve the effective workdir: default = `config.workdir` (created on
/// demand); override must already exist, be a directory, and resolve inside
/// the canonical `config.root`. Returns the canonical absolute path.
async fn resolve_workdir(
    config: &SandboxConfig,
    workdir_override: Option<&str>,
) -> Result<PathBuf, SandboxError> {
    let base = match workdir_override {
        None => config.workdir.clone(),
        Some(req) => {
            let p = PathBuf::from(req);
            if p.is_absolute() {
                p
            } else {
                config.workdir.join(p)
            }
        }
    };

    let canon = match tokio::fs::canonicalize(&base).await {
        Ok(c) => c,
        Err(_) if workdir_override.is_some() => {
            return Err(SandboxError::WorkdirMissing {
                requested: base.display().to_string(),
            });
        }
        Err(_e) => {
            // Default workdir: prepare it (a sandbox-owned dir) and re-resolve;
            // fail loudly if that does not pan out.
            tokio::fs::create_dir_all(&base).await.map_err(|ce| SandboxError::Config {
                message: format!("cannot create sandbox workdir '{}': {ce}", base.display()),
            })?;
            tokio::fs::canonicalize(&base).await.map_err(|ce| SandboxError::Config {
                message: format!(
                    "sandbox workdir '{}' is not resolvable after creation: {ce}",
                    base.display()
                ),
            })?
        }
    };

    let meta = tokio::fs::metadata(&canon).await.map_err(|e| SandboxError::Config {
        message: format!("cannot stat sandbox workdir '{}': {e}", canon.display()),
    })?;
    if !meta.is_dir() {
        return Err(SandboxError::WorkdirNotDir {
            requested: base.display().to_string(),
        });
    }

    let root =
        tokio::fs::canonicalize(&config.root).await.map_err(|e| SandboxError::Config {
            message: format!("sandbox root '{}' is not resolvable: {e}", config.root.display()),
        })?;
    if !canon.starts_with(&root) {
        return Err(SandboxError::WorkdirOutsideRoot {
            requested: base.display().to_string(),
            root: root.display().to_string(),
        });
    }
    Ok(canon)
}

/// Read `r` to EOF storing at most `cap` bytes; bytes past the cap are
/// drained (never buffered) so the child can keep writing. Returns
/// `(captured, truncated)`.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::with_capacity(cap.min(64 * 1024));
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break, // EOF, or the child's pipe closed: report what we got
            Ok(n) => {
                let remaining = cap.saturating_sub(buf.len());
                if n > remaining {
                    buf.extend_from_slice(&chunk[..remaining]);
                    truncated = true;
                    let _ = tokio::io::copy(&mut r, &mut tokio::io::sink()).await;
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
    (buf, truncated)
}

/// Kill the sandboxed process tree: on unix SIGKILL the whole process group
/// (the child leads it via `process_group(0)`); always signal the direct
/// child as well. Best effort — errors are swallowed because the timeout
/// already failed the call.
fn kill_process(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: `pid` belongs to a child we spawned ourselves; kill(2) with
        // a negative pid targets exactly the spawned process group.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    let _ = child.start_kill();
}

/// The child env: allowlist + explicit operator additions. Never the full
/// host environment.
fn sanitized_env(config: &SandboxConfig) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let k = k.to_string_lossy().into_owned();
            is_allowed_env(&k).then(|| (k, v.to_string_lossy().into_owned()))
        })
        .collect();
    env.extend(config.extra_env.iter().cloned());
    env
}

fn is_allowed_env(k: &str) -> bool {
    if ENV_ALLOWLIST.contains(&k) {
        return true;
    }
    #[cfg(windows)]
    if ENV_ALLOWLIST_WINDOWS.contains(&k) {
        return true;
    }
    false
}

/// Platform shell invocation for run_shell inside the sandbox.
#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", command]);
    cmd
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    // Absolute path: immune to the sanitized PATH of the child env.
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", command]);
    cmd
}

// ---- helpers ------------------------------------------------------------------

/// Walk up from `start` looking for a git marker (dir `.git` or a worktree
/// pointer file `.git`).
fn find_git_toplevel(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    loop {
        let marker = cur.join(".git");
        if marker.is_dir() || marker.is_file() {
            return Some(cur);
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn git_toplevel_or(start: &Path) -> PathBuf {
    find_git_toplevel(start).unwrap_or_else(|| start.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("celestea-sandbox-{}-{name}", std::process::id()))
    }

    fn mkdir(p: &Path) -> PathBuf {
        std::fs::create_dir_all(p).expect("create test dir");
        p.to_path_buf()
    }

    /// Config pinned at a temp dir (workdir == root), generous per-call cap.
    fn cfg_at(d: &Path, timeout_ms: u64) -> SandboxConfig {
        SandboxConfig::new()
            .with_workdir(d)
            .with_root(d)
            .with_timeout(Duration::from_millis(timeout_ms))
            .with_max_timeout(Duration::from_secs(10))
    }

    #[tokio::test]
    async fn success_returns_output_and_exit_code() {
        let d = mkdir(&tmp_dir("ok"));
        let cfg = cfg_at(&d, 5_000);
        let out = execute_sandboxed("printf '%s' 'hello world'", &cfg, None, None)
            .await
            .expect("ok");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello world");
        assert!(out.stderr.is_empty());
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.stdout_truncated);
        assert!(!out.stderr_truncated);

        // Exit codes propagate.
        let out2 = execute_sandboxed("exit 3", &cfg, None, None).await.expect("ok");
        assert_eq!(out2.exit_code, Some(3));
    }

    #[tokio::test]
    async fn timeout_kills_and_returns_structured_error() {
        let d = mkdir(&tmp_dir("timeout"));
        let cfg = cfg_at(&d, 300);
        let t0 = std::time::Instant::now();
        let err = execute_sandboxed("sleep 5", &cfg, None, None).await.unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(3), "timeout must fire early");
        let msg = err.to_string();
        assert!(msg.starts_with("run_shell-sandbox: code=timeout"), "{msg}");
        assert!(msg.contains("after 300ms"), "{msg}");
        assert!(msg.contains("stdout_captured_bytes="), "{msg}");
    }

    #[tokio::test]
    async fn timeout_stops_endless_output_at_cap() {
        let d = mkdir(&tmp_dir("endless"));
        let cfg = cfg_at(&d, 300).with_max_output_bytes(64);
        let t0 = std::time::Instant::now();
        let err = execute_sandboxed("yes foo", &cfg, None, None).await.unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(3), "reader+timeout must stop `yes`");
        let msg = err.to_string();
        assert!(msg.starts_with("run_shell-sandbox: code=timeout"), "{msg}");
        assert!(msg.contains("stdout_captured_bytes=64"), "{msg}");
    }

    #[tokio::test]
    async fn output_capped_and_drained_without_deadlock() {
        let d = mkdir(&tmp_dir("cap"));
        let cfg = cfg_at(&d, 5_000).with_max_output_bytes(128);
        let out = execute_sandboxed("head -c 10000 /dev/zero", &cfg, None, None)
            .await
            .expect("ok");
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(out.stdout.len(), 128);
        assert!(out.stdout_truncated);
        assert!(!out.stderr_truncated);
    }

    #[tokio::test]
    async fn workdir_override_inside_root_runs_there() {
        let root = mkdir(&tmp_dir("wd-root"));
        let inside = mkdir(&root.join("sub"));
        let cfg = SandboxConfig::new()
            .with_workdir(&root)
            .with_root(&root)
            .with_timeout(Duration::from_secs(5));
        let out = execute_sandboxed("pwd", &cfg, Some(inside.to_string_lossy().as_ref()), None)
            .await
            .expect("inside root is allowed");
        let canon = std::fs::canonicalize(&inside).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            canon.to_string_lossy()
        );
    }

    #[tokio::test]
    async fn workdir_override_outside_root_errors_structured() {
        let root = mkdir(&tmp_dir("wd-root-o"));
        let outside = mkdir(&tmp_dir("wd-out"));
        let cfg = SandboxConfig::new()
            .with_workdir(&root)
            .with_root(&root)
            .with_timeout(Duration::from_secs(5));
        let err = execute_sandboxed("pwd", &cfg, Some(outside.to_string_lossy().as_ref()), None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "workdir");
        let msg = err.to_string();
        assert!(msg.starts_with("run_shell-sandbox: code=workdir"), "{msg}");
        assert!(msg.contains("outside the sandbox root"), "{msg}");
        assert!(msg.contains(&outside.to_string_lossy().to_string()), "{msg}");
    }

    #[tokio::test]
    async fn workdir_override_missing_errors_structured() {
        let root = mkdir(&tmp_dir("wd-missing"));
        let cfg = SandboxConfig::new()
            .with_workdir(&root)
            .with_root(&root)
            .with_timeout(Duration::from_secs(5));
        let req = root.join("does-not-exist");
        let err = execute_sandboxed("pwd", &cfg, Some(req.to_string_lossy().as_ref()), None)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "workdir");
        let msg = err.to_string();
        assert!(msg.starts_with("run_shell-sandbox: code=workdir"), "{msg}");
        assert!(msg.contains("does not exist"), "{msg}");
    }

    #[tokio::test]
    async fn secret_env_vars_are_not_inherited() {
        std::env::set_var("CELAESTEA_SANDBOX_TEST_SECRET_VAR", "s3cr3t");
        let d = mkdir(&tmp_dir("env"));
        let cfg = cfg_at(&d, 5_000);
        let out = execute_sandboxed(
            r#"printf 'secret=%s;path=%s;home=%s
' "${CELAESTEA_SANDBOX_TEST_SECRET_VAR:-UNSET}" "${PATH:+SET}" "${HOME:-NO_HOME}""#,
            &cfg,
            None,
            None,
        )
        .await
        .expect("ok");
        let want = "secret=UNSET;path=SET;home=NO_HOME";
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), want);
    }

    #[tokio::test]
    async fn extra_env_is_injected_on_top_of_allowlist() {
        let d = mkdir(&tmp_dir("extra-env"));
        let cfg = cfg_at(&d, 5_000)
            .with_extra_env(vec![("SANDBOX_EXTRA_TEST".to_string(), "injected".to_string())]);
        let out = execute_sandboxed(
            r#"printf '%s' "${SANDBOX_EXTRA_TEST:-NO_EXTRA}""#,
            &cfg,
            None,
            None,
        )
        .await
        .expect("ok");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "injected");
    }

    #[tokio::test]
    async fn timeout_override_is_validated_and_bounded() {
        let d = mkdir(&tmp_dir("to-ov"));
        let cfg = cfg_at(&d, 5_000); // max 10s

        let err = execute_sandboxed("true", &cfg, None, Some(0)).await.unwrap_err();
        assert_eq!(err.code(), "arg");
        assert!(err.to_string().contains("timeout_ms must be >= 1"), "{err}");

        let err = execute_sandboxed("true", &cfg, None, Some(999_999_999)).await.unwrap_err();
        assert_eq!(err.code(), "arg");
        assert!(err.to_string().contains("exceeds the sandbox maximum"), "{err}");

        let out = execute_sandboxed("true", &cfg, None, Some(2_000)).await.expect("within max");
        assert_eq!(out.exit_code, Some(0));
    }

    #[tokio::test]
    async fn invalid_config_is_structured() {
        let d = mkdir(&tmp_dir("cfg"));
        let err = execute_sandboxed(
            "true",
            &cfg_at(&d, 5_000).with_max_output_bytes(0),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "config");
        assert!(err.to_string().starts_with("run_shell-sandbox: code=config"), "{err}");

        let err = execute_sandboxed(
            "true",
            &cfg_at(&d, 5_000).with_timeout(Duration::ZERO),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "config");
    }

    #[test]
    fn git_toplevel_detection_walks_up_to_marker() {
        let root = mkdir(&tmp_dir("gitroot"));
        std::fs::write(root.join(".git"), "gitdir: /nowhere
").unwrap();
        let nested = mkdir(&root.join("a/b"));
        assert_eq!(find_git_toplevel(&nested), Some(root.clone()));

        // No marker anywhere on this chain -> same result regardless of start.
        let plain = mkdir(&tmp_dir("norepo"));
        let sub = mkdir(&plain.join("s"));
        assert_eq!(find_git_toplevel(&sub), find_git_toplevel(&plain));
    }

    #[test]
    fn null_os_sandbox_layer_is_default_and_accepts() {
        let mut cmd = Command::new("/bin/sh");
        assert!(NullOsSandbox.apply(&mut cmd).is_ok());
        let cfg = SandboxConfig::new();
        let _ = cfg.os_layer.as_ref();
    }
}

