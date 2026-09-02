//! Execution sandbox for the `run_shell` builtin tool (W209, W221).
//!
//! The bare `sh -c` / `cmd /C` execution is turned into a bounded,
//! deterministic environment with five pragmatic guarantees (v1, userspace):
//! timeout, output cap, workdir control, env sanitization and structured
//! errors.
//!
//! **v2 OS isolation (W221)** — the [`OsSandboxLayer`] extension point now
//! ships [`OsSandboxV2`] as the default layer:
//!   1. **Process isolation** — bubblewrap (mount + user + pid + ipc + uts
//!      namespaces, read-only root, writable workdir/tmp) when available,
//!      else a raw `unshare(CLONE_NEWUSER|CLONE_NEWNS)` + chroot provider,
//!      else the v1 userspace path.
//!   2. **Resource limits** — `setrlimit(2)` (CPU / address space / process
//!      count / file size / open files / core) applied to the child tree.
//!   3. **seccomp (optional)** — a minimal syscall whitelist (`seccomp_v2`),
//!      installed directly in the child; bubblewrap `--seccomp` is opt-in.
//!
//! Degradation is probe-gated and never panics: if OS isolation would break
//! the v1 contract (e.g. a bubblewrap user-namespace sandbox that cannot open
//! device nodes like `/dev/zero`), the default layer falls back to the plain
//! v1 userspace path. The `v2_*` tests exercise the capability and the
//! degradation paths.
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

#[cfg(unix)]
use std::ffi::{CStr, CString};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

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

/// Context describing the direct, fully-configured spawn that a v2 layer may
/// wrap into an OS-isolated outer command. Carries everything `wrap` needs to
/// build a bubblewrap / raw-namespace wrapper without touching call sites.
#[derive(Debug, Clone)]
pub(crate) struct OsSpawnCtx {
    /// Program to execute inside the sandbox (e.g. `/bin/sh`).
    pub(crate) program: String,
    /// Arguments passed to `program` (e.g. `["-c", command]`).
    pub(crate) args: Vec<String>,
    /// Resolved canonical workdir (bind-mounted into the sandbox / cwd).
    pub(crate) workdir: PathBuf,
    /// Sanitized child environment (allowlist + extra_env).
    pub(crate) env: Vec<(String, String)>,
}

/// Hook for the v2 OS-level sandbox (namespaces, seccomp, landlock,
/// bubblewrap, …). v1 ships [`NullOsSandbox`]; the W221 v2 layer is
/// [`OsSandboxV2`]. `wrap` runs after the direct command is fully configured
/// (before spawn); `apply` runs on the final command right before spawn —
/// no call-site or seam changes.
pub(crate) trait OsSandboxLayer: Send + Sync + std::fmt::Debug {
    /// Legacy v1 hook: mutate the final command right before spawn.
    fn apply(&self, _cmd: &mut Command) -> Result<(), String> {
        Ok(())
    }

    /// v2 hook: given the fully-configured direct command plus its spawn
    /// context, return the command to actually spawn. The default returns the
    /// direct command unchanged (v1 userspace path).
    fn wrap(&self, direct: Command, _ctx: &OsSpawnCtx) -> Result<Command, String> {
        Ok(direct)
    }

    /// Whether a spawn failure of the wrapped command should fall back to a
    /// freshly built plain v1 command (best-effort OS isolation, never panic).
    fn degrade_on_spawn_failure(&self) -> bool {
        false
    }
}

/// v1 no-op layer: sandboxing is userspace-only.
///
/// The default `SandboxConfig` uses [`OsSandboxV2`] (which auto-degrades to
/// this layer when OS isolation is unavailable); `NullOsSandbox` remains the
/// explicit "no OS isolation" choice for embeddings that opt out.
#[derive(Debug, Default, Clone, Copy)]
#[allow(dead_code)] // explicit opt-out layer, exercised by tests
pub(crate) struct NullOsSandbox;

impl OsSandboxLayer for NullOsSandbox {}

// ---- v2 OS-level sandbox (W221) ------------------------------------------------
//
// Linux-first OS isolation layered on the OsSandboxLayer extension point:
//   1. process isolation - bubblewrap (mount + user + pid + ipc + uts
//      namespaces, read-only root) when available, else a raw
//      unshare(CLONE_NEWUSER|CLONE_NEWNS) + chroot provider, else nothing;
//   2. resource limits - setrlimit (CPU / address space / process count /
//      file size / open files / core) applied to the child tree;
//   3. seccomp (optional) - a minimal syscall whitelist installed directly in
//      the child (bubblewrap --seccomp is racy on some kernels, so it is
//      opt-in via env).
// Every capability is probe-gated and cached; if OS isolation is unavailable
// the layer degrades to the v1 userspace path. It never panics.
// ---- providers --------------------------------------------------------------

/// OS-sandbox provider selected by detect_provider.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V2Provider {
    /// bubblewrap: namespaces + read-only root + userns (primary on Linux).
    Bubblewrap,
    /// Raw unshare(CLONE_NEWUSER|CLONE_NEWNS) + chroot fallback provider.
    RawNamespace,
    /// v1 userspace-only: no OS isolation available on this box.
    Userspace,
}

#[cfg(not(target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V2Provider {
    /// No OS isolation available; the layer behaves exactly like v1.
    Userspace,
}

/// Per-command OS resource limits applied with setrlimit(2) in the child.
/// 0 means unlimited for the numeric fields; core toggles core dumps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct V2Limits {
    /// RLIMIT_CPU seconds (0 = unlimited).
    pub(crate) cpu_sec: u64,
    /// RLIMIT_AS MiB (0 = unlimited).
    pub(crate) mem_mb: u64,
    /// RLIMIT_NPROC (0 = unlimited).
    pub(crate) nproc: u64,
    /// RLIMIT_FSIZE bytes (0 = unlimited).
    pub(crate) fsize_bytes: u64,
    /// RLIMIT_NOFILE (0 = unlimited).
    pub(crate) nofile: u64,
    /// Disable core dumps.
    pub(crate) core: bool,
}

impl Default for V2Limits {
    fn default() -> Self {
        Self {
            cpu_sec: 20,
            mem_mb: 2048,
            nproc: 512,
            fsize_bytes: 256 * 1024 * 1024,
            nofile: 256,
            core: true,
        }
    }
}

/// v2 env knobs (read by OsSandboxV2::auto / SandboxConfig::from_env).
pub(crate) const ENV_OS_SANDBOX: &str = "CELAESTEA_RUN_SHELL_OS_SANDBOX";
pub(crate) const ENV_V2_SECCOMP: &str = "CELAESTEA_RUN_SHELL_V2_SECCOMP";
pub(crate) const ENV_V2_TMPFS_TMP: &str = "CELAESTEA_RUN_SHELL_V2_TMPFS_TMP";
pub(crate) const ENV_V2_CPU_SEC: &str = "CELAESTEA_RUN_SHELL_V2_CPU_SEC";
pub(crate) const ENV_V2_MEM_MB: &str = "CELAESTEA_RUN_SHELL_V2_MEM_MB";
pub(crate) const ENV_V2_NPROC: &str = "CELAESTEA_RUN_SHELL_V2_NPROC";
pub(crate) const ENV_V2_FSIZE_MB: &str = "CELAESTEA_RUN_SHELL_V2_FSIZE_MB";
pub(crate) const ENV_V2_NOFILE: &str = "CELAESTEA_RUN_SHELL_V2_NOFILE";
pub(crate) const ENV_V2_CORE: &str = "CELAESTEA_RUN_SHELL_V2_CORE";

/// fd the seccomp blob is dup2'd to for bubblewrap's --seccomp.
#[cfg(target_os = "linux")]
const SECCOMP_RESERVED_FD: libc::c_int = 200;

impl V2Limits {
    /// Apply these limits to the current process (run in the child via
    /// pre_exec). Best-effort: a failed setrlimit is ignored - rlimits are an
    /// added hardening layer, never a hard requirement.
    #[cfg(unix)]
    fn apply(&self) {
        unsafe {
            let set = |which: libc::__rlimit_resource_t, cur: u64| {
                let lim = libc::rlimit { rlim_cur: cur, rlim_max: cur };
                libc::setrlimit(which, &lim);
            };
            if self.cpu_sec > 0 {
                set(libc::RLIMIT_CPU, self.cpu_sec);
            }
            if self.mem_mb > 0 {
                set(libc::RLIMIT_AS, self.mem_mb * 1024 * 1024);
            }
            if self.nproc > 0 {
                set(libc::RLIMIT_NPROC, self.nproc);
            }
            if self.fsize_bytes > 0 {
                set(libc::RLIMIT_FSIZE, self.fsize_bytes);
            }
            if self.nofile > 0 {
                set(libc::RLIMIT_NOFILE, self.nofile);
            }
            if self.core {
                set(libc::RLIMIT_CORE, 0);
            }
        }
    }

    #[cfg(unix)]
    fn from_env() -> Self {
        let mut l = Self::default();
        if let Some(v) = env_u64(ENV_V2_CPU_SEC).filter(|&v| v > 0) {
            l.cpu_sec = v;
        }
        if let Some(v) = env_u64(ENV_V2_MEM_MB).filter(|&v| v > 0) {
            l.mem_mb = v;
        }
        if let Some(v) = env_u64(ENV_V2_NPROC).filter(|&v| v > 0) {
            l.nproc = v;
        }
        if let Some(v) = env_u64(ENV_V2_FSIZE_MB).filter(|&v| v > 0) {
            l.fsize_bytes = v * 1024 * 1024;
        }
        if let Some(v) = env_u64(ENV_V2_NOFILE).filter(|&v| v > 0) {
            l.nofile = v;
        }
        if let Ok(v) = std::env::var(ENV_V2_CORE) {
            l.core = v != "0" && v != "false" && v != "off" && v != "no";
        }
        l
    }

    #[cfg(not(unix))]
    #[allow(dead_code)]
    fn apply(&self) {}
    #[cfg(not(unix))]
    fn from_env() -> Self {
        Self::default()
    }
}

/// Simple on/off env flag with a sane default.
fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name).ok().as_deref() {
        Some("1") | Some("on") | Some("true") | Some("yes") => true,
        Some("0") | Some("off") | Some("false") | Some("no") => false,
        _ => default,
    }
}

/// Locate a usable bubblewrap binary (probe: runs bwrap --version).
fn detect_bwrap() -> Option<PathBuf> {
    for cand in [
        "/usr/bin/bwrap",
        "/bin/bwrap",
        "/usr/local/bin/bwrap",
        "/sbin/bwrap",
    ] {
        let p = PathBuf::from(cand);
        if p.is_file() && bwrap_runs(&p) {
            return Some(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("bwrap");
            if p.is_file() && bwrap_runs(&p) {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn bwrap_runs(p: &Path) -> bool {
    std::process::Command::new(p)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut c| c.wait())
        .map(|s| s.success())
        .unwrap_or(false)
}
#[cfg(not(target_os = "linux"))]
fn bwrap_runs(_p: &Path) -> bool {
    false
}

/// Verify a bubblewrap sandbox is usable as a drop-in for the v1 contract.
///
/// A bwrap sandbox runs the command inside a user namespace where the inner
/// process has no capabilities. On many kernels/containers such a process
/// cannot open device nodes (e.g. /dev/zero, /dev/null), which would break
/// ordinary commands like head -c N /dev/zero or ... 2>/dev/null. The v2
/// layer treats bwrap as the default only when this basic probe passes;
/// otherwise it degrades to the v1 userspace path (device access preserved).
#[cfg(target_os = "linux")]
fn bwrap_sandbox_usable(bwrap: &Path) -> bool {
    let workdir = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let wd = workdir.to_string_lossy().into_owned();
    let mut c = std::process::Command::new(bwrap);
    c.args([
        "--unshare-all",
        "--share-net",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        "/tmp",
        "/tmp",
        "--bind",
        &wd,
        &wd,
        "--",
        "/bin/sh",
        "-c",
        "exec 3</dev/zero 2>/dev/null && printf ok || printf no",
    ]);
    c.stdout(Stdio::piped());
    c.stderr(Stdio::null());
    match c.output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains("ok"),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "linux"))]
fn bwrap_sandbox_usable(_bwrap: &Path) -> bool {
    false
}

/// Probe whether unprivileged user/mount namespaces can be created here
/// (raw provider). Runs in a throwaway child; allocation-free.
#[cfg(target_os = "linux")]
fn raw_namespaces_supported() -> bool {
    use std::os::unix::process::CommandExt;
    let mut c = std::process::Command::new("/bin/true");
    unsafe {
        c.pre_exec(|| {
            if libc::unshare(libc::CLONE_NEWUSER) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let uid = libc::getuid();
            let mut buf = [0i8; 48];
            let n = libc::snprintf(buf.as_mut_ptr(), buf.len(), c"%d %d 1\n".as_ptr(), 0, uid);
            if n <= 0 {
                return Err(std::io::Error::from_raw_os_error(libc::EIO));
            }
            let b = &buf[..n as usize];
            let mut ok = true;
            let p = c"/proc/self/uid_map".as_ptr();
            let fd = libc::open(p, libc::O_WRONLY);
            if fd < 0 || libc::write(fd, b.as_ptr() as *const _, b.len()) < 0 {
                ok = false;
            }
            if fd >= 0 {
                libc::close(fd);
            }
            if ok && libc::unshare(libc::CLONE_NEWNS) != 0 {
                ok = false;
            }
            if ok {
                Ok(())
            } else {
                Err(std::io::Error::from_raw_os_error(libc::EPERM))
            }
        });
    }
    match c.status() {
        Ok(s) => s.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "linux"))]
fn raw_namespaces_supported() -> bool {
    false
}

/// Probe-based provider selection, cached process-wide.
fn detect_provider() -> V2Provider {
    #[cfg(target_os = "linux")]
    {
        use std::sync::OnceLock;
        static CACHE: OnceLock<V2Provider> = OnceLock::new();
        *CACHE.get_or_init(|| {
            if let Some(b) = detect_bwrap() {
                if bwrap_sandbox_usable(&b) {
                    V2Provider::Bubblewrap
                } else {
                    // bwrap exists but the sandbox breaks the v1 device
                    // contract on this kernel -> degrade to v1 userspace.
                    V2Provider::Userspace
                }
            } else if raw_namespaces_supported() {
                V2Provider::RawNamespace
            } else {
                V2Provider::Userspace
            }
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        V2Provider::Userspace
    }
}

/// The W221 v2 OS-sandbox layer: bubblewrap > raw namespaces > v1 userspace.
#[derive(Debug, Clone)]
pub(crate) struct OsSandboxV2 {
    provider: V2Provider,
    limits: V2Limits,
    seccomp: bool,
    tmpfs_tmp: bool,
    bwrap: Option<PathBuf>,
}

impl OsSandboxV2 {
    /// Probe-based default layer (env-aware), used by SandboxConfig::new.
    pub(crate) fn auto() -> Arc<dyn OsSandboxLayer> {
        let env = std::env::var(ENV_OS_SANDBOX).unwrap_or_default();
        let provider = match env.as_str() {
            "off" | "0" | "false" | "no" => V2Provider::Userspace,
            "bwrap" => {
                if detect_bwrap().is_some() {
                    V2Provider::Bubblewrap
                } else {
                    V2Provider::Userspace
                }
            }
            "raw" => {
                if raw_namespaces_supported() {
                    V2Provider::RawNamespace
                } else {
                    V2Provider::Userspace
                }
            }
            _ => detect_provider(),
        };
        Arc::new(Self {
            provider,
            limits: V2Limits::from_env(),
            seccomp: env_flag(ENV_V2_SECCOMP, false),
            tmpfs_tmp: env_flag(ENV_V2_TMPFS_TMP, false),
            bwrap: detect_bwrap(),
        })
    }

    /// Explicit layer for tests / embeddings.
    #[allow(dead_code)] // extension API used by tests / embeddings
    pub(crate) fn from_options(
        provider: V2Provider,
        limits: V2Limits,
        seccomp: bool,
        tmpfs_tmp: bool,
    ) -> Self {
        Self {
            provider,
            limits,
            seccomp,
            tmpfs_tmp,
            bwrap: detect_bwrap(),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn with_limits(mut self, l: V2Limits) -> Self {
        self.limits = l;
        self
    }
    #[allow(dead_code)]
    pub(crate) fn with_seccomp(mut self, on: bool) -> Self {
        self.seccomp = on;
        self
    }
    #[allow(dead_code)]
    pub(crate) fn with_tmpfs_tmp(mut self, on: bool) -> Self {
        self.tmpfs_tmp = on;
        self
    }
    #[allow(dead_code)]
    pub(crate) fn with_provider(mut self, p: V2Provider) -> Self {
        self.provider = p;
        self
    }
    #[allow(dead_code)]
    pub(crate) fn provider(&self) -> V2Provider {
        self.provider
    }
}

impl OsSandboxLayer for OsSandboxV2 {
    fn wrap(&self, direct: Command, ctx: &OsSpawnCtx) -> Result<Command, String> {
        #[cfg(target_os = "linux")]
        {
            match self.provider {
                V2Provider::Bubblewrap => match &self.bwrap {
                    Some(b) => self.wrap_bwrap(direct, ctx, b),
                    None => Ok(direct),
                },
                V2Provider::RawNamespace => self.wrap_raw(direct, ctx),
                V2Provider::Userspace => Ok(direct),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = ctx;
            Ok(direct)
        }
    }

    fn degrade_on_spawn_failure(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            self.provider != V2Provider::Userspace
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }
}

// ---- bubblewrap provider ------------------------------------------------------

/// Wrap the direct command under bubblewrap with a read-only root, a writable
/// workdir, resource limits (outer process, inherited by the whole tree) and
/// optional seccomp.
#[cfg(target_os = "linux")]
impl OsSandboxV2 {
    fn wrap_bwrap(&self, _direct: Command, ctx: &OsSpawnCtx, bwrap: &Path) -> Result<Command, String> {
        let mut outer = Command::new(bwrap);
        outer.args([
            "--unshare-all",
            "--share-net",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--ro-bind",
            "/",
            "/",
        ]);
        if self.tmpfs_tmp {
            outer.args(["--tmpfs", "/tmp"]);
        } else {
            outer.args(["--bind", "/tmp", "/tmp"]);
        }
        // the workdir must stay writable even though / is read-only
        outer.arg("--bind");
        outer.arg(&ctx.workdir);
        outer.arg(&ctx.workdir);

        let mut blob: Option<PathBuf> = None;
        if self.seccomp {
            let b = seccomp_v2::write_blob()?;
            blob = Some(b);
            outer.arg("--seccomp");
            outer.arg(SECCOMP_RESERVED_FD.to_string());
        }

        outer.arg("--");
        outer.arg(&ctx.program);
        for a in &ctx.args {
            outer.arg(a);
        }
        outer.current_dir(&ctx.workdir);
        outer.env_clear();
        for (k, v) in &ctx.env {
            outer.env(k, v);
        }
        outer.stdin(Stdio::null());
        outer.stdout(Stdio::piped());
        outer.stderr(Stdio::piped());
        outer.kill_on_drop(true);
        outer.process_group(0);

        let limits = self.limits;
        let blob_c: Option<CString> = blob
            .as_ref()
            .map(|b| CString::new(b.as_os_str().as_bytes()).map_err(|e| e.to_string()))
            .transpose()?;
        unsafe {
            outer.pre_exec(move || {
                limits.apply();
                if let Some(c) = &blob_c {
                    open_seccomp_fd(c)?;
                }
                Ok(())
            });
        }
        Ok(outer)
    }
}

/// Open the seccomp blob and dup it to a reserved fd (runs in the child; no
/// allocation).
#[cfg(target_os = "linux")]
fn open_seccomp_fd(path: &CStr) -> std::io::Result<()> {
    unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_RDONLY);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::dup2(fd, SECCOMP_RESERVED_FD) < 0 {
            let e = std::io::Error::last_os_error();
            libc::close(fd);
            return Err(e);
        }
        libc::close(fd);
        Ok(())
    }
}

// ---- raw namespace provider ---------------------------------------------------

/// Wrap the direct command with a raw user/mount-namespace + chroot setup in
/// pre_exec. Only reached when the probe succeeded; a setup failure here
/// surfaces as a spawn error and the caller degrades to v1 userspace.
#[cfg(target_os = "linux")]
impl OsSandboxV2 {
    fn wrap_raw(&self, direct: Command, ctx: &OsSpawnCtx) -> Result<Command, String> {
        let mut cmd = direct;
        let limits = self.limits;
        let seccomp = self.seccomp;
        let workdir_c = CString::new(ctx.workdir.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let root = raw_root_dir();
        let root_c = CString::new(root.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let dev_c = CString::new(raw_child_path(&root, "dev").as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let tmp_c = CString::new(raw_child_path(&root, "tmp").as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let w_c = CString::new(raw_child_path(&root, "w").as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let wdir_c = workdir_c.clone();
        unsafe {
            cmd.pre_exec(move || {
                limits.apply();
                raw_setup(&root_c, &dev_c, &tmp_c, &w_c, &wdir_c)?;
                if seccomp {
                    seccomp_v2::install_direct()?;
                }
                Ok(())
            });
        }
        Ok(cmd)
    }
}

/// A fresh per-run sandbox root directory on the host filesystem.
#[cfg(target_os = "linux")]
fn raw_root_dir() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        ".celestea-v2-root-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    p
}

#[cfg(target_os = "linux")]
fn raw_child_path(root: &Path, child: &str) -> PathBuf {
    root.join(child)
}

/// The raw namespace + chroot dance. Every step is checked; failure returns
/// Err and the caller falls back to v1.
#[cfg(target_os = "linux")]
fn raw_setup(
    root: &CStr,
    dev: &CStr,
    tmp: &CStr,
    w: &CStr,
    workdir: &CStr,
) -> std::io::Result<()> {
    unsafe {
        if libc::unshare(libc::CLONE_NEWUSER) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let uid = libc::getuid();
        let gid = libc::getgid();
        let mut buf = [0i8; 48];
        let n = libc::snprintf(buf.as_mut_ptr(), buf.len(), c"%d %d 1\n".as_ptr(), 0, uid);
        if n <= 0 {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        let data = std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize);
        write_map("/proc/self/uid_map", data)?;
        let _ = write_map("/proc/self/setgroups", b"deny\n");
        let n = libc::snprintf(buf.as_mut_ptr(), buf.len(), c"%d %d 1\n".as_ptr(), 0, gid);
        if n <= 0 {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        let data = std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize);
        write_map("/proc/self/gid_map", data)?;

        if libc::unshare(libc::CLONE_NEWNS) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::mount(
            std::ptr::null(),
            c"/".as_ptr(),
            std::ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            std::ptr::null(),
        ) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if libc::mkdir(root.as_ptr(), 0o700) != 0 && *libc::__errno_location() != libc::EEXIST {
            return Err(std::io::Error::last_os_error());
        }
        if libc::mount(c"/".as_ptr(), root.as_ptr(), std::ptr::null(), libc::MS_BIND | libc::MS_REC, std::ptr::null()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::mount(
            std::ptr::null(),
            root.as_ptr(),
            std::ptr::null(),
            libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_REC,
            std::ptr::null(),
        ) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        libc::mkdir(dev.as_ptr(), 0o755);
        libc::mkdir(tmp.as_ptr(), 0o755);
        libc::mkdir(w.as_ptr(), 0o755);
        let _ = libc::mount(c"/dev".as_ptr(), dev.as_ptr(), std::ptr::null(), libc::MS_BIND, std::ptr::null());
        let _ = libc::mount(c"/tmp".as_ptr(), tmp.as_ptr(), std::ptr::null(), libc::MS_BIND, std::ptr::null());
        if libc::mount(workdir.as_ptr(), w.as_ptr(), std::ptr::null(), libc::MS_BIND, std::ptr::null()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::chroot(root.as_ptr()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::chdir(c"/w".as_ptr()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn write_map(path: &str, data: &[u8]) -> std::io::Result<()> {
    unsafe {
        let mut p = [0i8; 64];
        if path.len() >= p.len() {
            return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
        }
        for (i, b) in path.bytes().enumerate() {
            p[i] = b as i8;
        }
        let fd = libc::open(p.as_ptr(), libc::O_WRONLY);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let r = libc::write(fd, data.as_ptr() as *const _, data.len());
        libc::close(fd);
        if r < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

// ---- seccomp (optional) ---------------------------------------------------------

/// Minimal syscall whitelist seccomp filter. Only enabled explicitly (env
/// knob); when it cannot be applied the layer keeps running without it.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) mod seccomp_v2 {
    use super::*;

    /// x86_64 audit arch for the arch check.
    const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
    /// X32 syscall numbers share the table with a 0x4000_0000 high bit.
    const X32_BIT: u32 = 0x4000_0000;
    /// SECCOMP_RET_ALLOW
    const RET_ALLOW: u32 = 0x7FFF_0000;
    /// SECCOMP_RET_ERRNO | EPERM
    const RET_EPERM: u32 = 0x0005_0001;
    /// SECCOMP_RET_ERRNO | ENOSYS (forces glibc to fall back to clone(2))
    const RET_ENOSYS: u32 = 0x0005_0026;

    fn stmt(code: u16, k: u32) -> libc::sock_filter {
        libc::sock_filter { code, jt: 0, jf: 0, k }
    }
    fn jump(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
        libc::sock_filter { code, jt, jf, k }
    }

    /// Syscalls allowed inside the sandbox (x86_64 numbers). The set covers
    /// the shell + coreutils runtime and POSIX file/process operations, and
    /// deliberately omits network, mount, module, ptrace and privilege-change
    /// syscalls.
    const ALLOW: &[u32] = &[
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
        20, 21, 22, 23, 24, 25, 26, 27, 28, 32, 33, 35, 38, 39, 40, 42,
        56, 57, 58, 59, 60, 61, 62, 63, 72, 73, 74, 75, 76, 77, 78, 79, 80,
        81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
        98, 99, 100, 102, 104, 107, 108, 109, 110, 111, 112, 118, 120, 121,
        131, 137, 138, 157, 158, 160, 186, 202, 203, 204, 217, 218, 219, 228,
        229, 230, 231, 232, 233, 234, 235, 247, 253, 254, 255, 257, 258, 260,
        261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 273, 274, 276,
        280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293,
        294, 295, 296, 302, 306, 315, 318, 322, 324, 326, 327, 328, 332, 334,
        437, 439, 452,
    ];

    /// Build the filter as a Vec of sock_filter (native endian, exactly the
    /// layout the kernel and bubblewrap consume).
    pub(crate) fn build() -> Vec<libc::sock_filter> {
        let mut p = Vec::new();
        p.push(stmt(0x20, 4)); // BPF_LD | BPF_W | BPF_ABS : load arch
        p.push(jump(0x15, 0, 2, AUDIT_ARCH_X86_64)); // BPF_JEQ : != arch -> errno
        p.push(stmt(0x20, 0)); // load syscall nr
        p.push(jump(0x35, 0, 1, X32_BIT)); // BPF_JGE : nr >= 0x40000000 -> errno
        p.push(stmt(0x06, RET_EPERM)); // BPF_RET : default reject
        for nr in ALLOW {
            p.push(jump(0x15, 0, 1, *nr)); // BPF_JEQ nr -> allow
            p.push(stmt(0x06, RET_ALLOW));
        }
        p.push(jump(0x15, 0, 1, 435)); // clone3 -> ENOSYS
        p.push(stmt(0x06, RET_ENOSYS));
        p.push(stmt(0x06, RET_EPERM)); // final default reject
        p
    }

    /// Serialize the filter to the blob bytes bubblewrap reads.
    pub(crate) fn to_blob_bytes(f: &[libc::sock_filter]) -> Vec<u8> {
        let mut out = Vec::with_capacity(f.len() * 8);
        for s in f {
            out.extend_from_slice(&s.code.to_le_bytes());
            out.push(s.jt);
            out.push(s.jf);
            out.extend_from_slice(&s.k.to_le_bytes());
        }
        out
    }

    /// Write the filter blob to a temp file for bubblewrap --seccomp.
    pub(crate) fn write_blob() -> Result<PathBuf, String> {
        let bytes = to_blob_bytes(&build());
        let mut path = std::env::temp_dir();
        path.push(format!(
            "celestea-v2-seccomp-{}-{}.bpf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&path, &bytes).map_err(|e| format!("seccomp blob write failed: {e}"))?;
        Ok(path)
    }

    /// Install the whitelist filter directly on the current process (used by
    /// the raw provider and the capability tests). Requires NO_NEW_PRIVS.
    pub(crate) fn install_direct() -> std::io::Result<()> {
        let prog = build();
        unsafe {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let fprog = libc::sock_fprog {
                len: prog.len() as u16,
                filter: prog.as_ptr() as *mut libc::sock_filter,
            };
            if libc::syscall(libc::SYS_seccomp, libc::SECCOMP_SET_MODE_FILTER, 0, &fprog) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    /// Allowed-syscall membership, exposed for tests.
    #[cfg(test)]
    pub(crate) fn allows(nr: u32) -> bool {
        ALLOW.contains(&nr)
    }
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub(crate) mod seccomp_v2 {
    pub(crate) fn build() -> Vec<u8> {
        Vec::new()
    }
    pub(crate) fn write_blob() -> Result<std::path::PathBuf, String> {
        Err("seccomp unsupported on this platform".into())
    }
    pub(crate) fn install_direct() -> std::io::Result<()> {
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
            os_layer: OsSandboxV2::auto(),
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

    let mut direct = shell_command(command);
    direct.current_dir(&workdir);
    direct.stdin(Stdio::null()); // like the pre-sandbox `.output()`: never inherit stdio
    direct.stdout(Stdio::piped());
    direct.stderr(Stdio::piped());
    direct.kill_on_drop(true); // drop reaps/kills even if our kill path is skipped
    #[cfg(unix)]
    direct.process_group(0); // child leads its own pgid -> a timeout SIGKILLs the tree
    direct.env_clear();
    let envv = sanitized_env(config);
    for (k, v) in &envv {
        direct.env(k, v);
    }
    let ctx = OsSpawnCtx {
        program: shell_program().to_string(),
        args: shell_args(command),
        workdir: workdir.clone(),
        env: envv,
    };
    // v2 hook: may wrap the direct command under bubblewrap / raw namespaces.
    let mut cmd = config.os_layer.wrap(direct, &ctx).map_err(|e| SandboxError::Config {
        message: format!("os sandbox layer rejected the command: {e}"),
    })?;
    config.os_layer.apply(&mut cmd).map_err(|e| SandboxError::Config {
        message: format!("os sandbox layer rejected the command: {e}"),
    })?;

    let mut child = match cmd.spawn() {
        Ok(c) => Ok(c),
        Err(_e) if config.os_layer.degrade_on_spawn_failure() => {
            // OS isolation could not be set up (e.g. namespace creation
            // denied by the kernel). Fall back to a plain v1 spawn so the
            // run still succeeds - never panic, never lose a call.
            let mut v1 = shell_command(command);
            v1.current_dir(&workdir);
            v1.stdin(Stdio::null());
            v1.stdout(Stdio::piped());
            v1.stderr(Stdio::piped());
            v1.kill_on_drop(true);
            #[cfg(unix)]
            v1.process_group(0);
            v1.env_clear();
            for (k, v) in &ctx.env {
                v1.env(k, v);
            }
            v1.spawn()
        }
        Err(e) => Err(e),
    }
    .map_err(|e| SandboxError::Spawn {
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

/// The shell program for the v2 spawn context.
#[cfg(windows)]
fn shell_program() -> &'static str {
    "cmd"
}
#[cfg(not(windows))]
fn shell_program() -> &'static str {
    "/bin/sh"
}

/// The shell arguments for the v2 spawn context.
#[cfg(windows)]
fn shell_args(command: &str) -> Vec<String> {
    vec!["/C".into(), command.into()]
}
#[cfg(not(windows))]
fn shell_args(command: &str) -> Vec<String> {
    vec!["-c".into(), command.into()]
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

    // ---- v2 OS-sandbox capability & degradation tests (W221) ----

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn v2_seccomp_bpf_is_well_formed() {
        let f = seccomp_v2::build();
        assert!(f.len() > 10, "filter must be non-trivial");
        assert_eq!(f[0].code, 0x20, "first insn loads the arch");
        assert_eq!(f[1].code, 0x15, "second insn compares arch");
        assert_eq!(f[f.len() - 1].code, 0x06, "last insn must RET");
        assert_eq!(f[f.len() - 2].code, 0x06, "second-to-last must RET");
        let blob = seccomp_v2::to_blob_bytes(&f);
        assert_eq!(blob.len() % 8, 0, "bubblewrap blob is a sock_filter array");
        assert_eq!(blob.len() / 8, f.len());
        assert!(seccomp_v2::allows(0), "read allowed");
        assert!(seccomp_v2::allows(59), "execve allowed");
        assert!(!seccomp_v2::allows(41), "socket denied");
        assert!(!seccomp_v2::allows(166), "mount denied");
        assert!(!seccomp_v2::allows(101), "ptrace denied");
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn v2_seccomp_rejects_off_allowlist_syscall() {
        use std::os::unix::process::CommandExt;
        let mut ok = std::process::Command::new("/bin/sh");
        ok.arg("-c").arg("printf seccomp-ok");
        unsafe {
            ok.pre_exec(|| seccomp_v2::install_direct());
        }
        let out = ok.output().expect("allowed command must run");
        assert_eq!(out.status.code(), Some(0), "allowed syscalls pass the filter");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "seccomp-ok");

        let mut deny = std::process::Command::new("/bin/sh");
        deny.arg("-c").arg("perl -e 'socket(S,2,1,0) or exit 9; exit 0'");
        unsafe {
            deny.pre_exec(|| seccomp_v2::install_direct());
        }
        let out2 = deny.output().expect("denied command must run");
        assert_ne!(out2.status.code(), Some(0), "off-allowlist syscall is blocked");
    }

    #[test]
    fn v2_default_provider_matches_usability() {
        let p = detect_provider();
        let usable = detect_bwrap().map(|b| bwrap_sandbox_usable(&b)).unwrap_or(false);
        if usable {
            assert_eq!(p, V2Provider::Bubblewrap, "usable bwrap is the default");
        } else {
            assert_eq!(
                p,
                V2Provider::Userspace,
                "default degrades to v1 when bwrap is not a safe drop-in"
            );
        }
    }

    #[tokio::test]
    async fn v2_bwrap_provider_isolates_mount_namespace() {
        if detect_bwrap().is_none() {
            eprintln!("skip: no bwrap on this box");
            return;
        }
        let d = mkdir(&tmp_dir("v2-mnt"));
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Bubblewrap,
                V2Limits::default(),
                false,
                false,
            )));
        let host_ns = std::fs::read_link("/proc/self/ns/mnt")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let out = execute_sandboxed("readlink /proc/self/ns/mnt", &cfg, None, None)
            .await
            .expect("bwrap sandbox runs");
        assert_eq!(out.exit_code, Some(0), "readlink succeeded inside");
        let inner = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert!(!inner.is_empty(), "inner ns path present");
        assert_ne!(host_ns, inner, "mount namespace must differ from host");
    }

    #[tokio::test]
    async fn v2_bwrap_root_readonly_but_workdir_writable() {
        if detect_bwrap().is_none() {
            eprintln!("skip: no bwrap on this box");
            return;
        }
        let d = mkdir(&tmp_dir("v2-ro"));
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Bubblewrap,
                V2Limits::default(),
                false,
                false,
            )));
        let ro = execute_sandboxed("echo x > /etc/v2-ro-test", &cfg, None, None)
            .await
            .expect("runs");
        assert_ne!(ro.exit_code, Some(0), "writing /etc must fail (ro root)");
        let wd = execute_sandboxed("touch v2-wd-write-ok", &cfg, None, None)
            .await
            .expect("runs");
        assert_eq!(wd.exit_code, Some(0), "workdir stays writable");
    }

    #[tokio::test]
    async fn v2_rlimit_cpu_enforced() {
        if detect_bwrap().is_none() {
            eprintln!("skip: no bwrap on this box");
            return;
        }
        let d = mkdir(&tmp_dir("v2-cpu"));
        let limits = V2Limits { cpu_sec: 1, ..V2Limits::default() };
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Bubblewrap,
                limits,
                false,
                false,
            )));
        let t0 = std::time::Instant::now();
        let out = execute_sandboxed("yes", &cfg, None, Some(10_000)).await.expect("runs");
        assert!(t0.elapsed() < Duration::from_secs(8), "cpu limit must fire quickly");
        assert_ne!(out.exit_code, Some(0), "cpu-bound yes must be killed by RLIMIT_CPU");
    }

    #[tokio::test]
    async fn v2_rlimit_fsize_enforced() {
        if detect_bwrap().is_none() {
            eprintln!("skip: no bwrap on this box");
            return;
        }
        let d = mkdir(&tmp_dir("v2-fsize"));
        let limits = V2Limits { fsize_bytes: 4096, ..V2Limits::default() };
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Bubblewrap,
                limits,
                false,
                false,
            )));
        let out = execute_sandboxed("seq 1 1000000 > big.txt", &cfg, None, Some(10_000))
            .await
            .expect("runs");
        assert_ne!(out.exit_code, Some(0), "over-fsize write must be killed");
    }

    #[tokio::test]
    async fn v2_bwrap_preserves_basic_v1_behavior() {
        if detect_bwrap().is_none() {
            eprintln!("skip: no bwrap on this box");
            return;
        }
        let d = mkdir(&tmp_dir("v2-v1"));
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Bubblewrap,
                V2Limits::default(),
                false,
                false,
            )));
        let out = execute_sandboxed("printf hello-v2", &cfg, None, None).await.expect("ok");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello-v2");
        assert_eq!(out.exit_code, Some(0));
        let out2 = execute_sandboxed("exit 3", &cfg, None, None).await.expect("ok");
        assert_eq!(out2.exit_code, Some(3));
        let out3 = execute_sandboxed("pwd", &cfg, None, None).await.expect("ok");
        let canon = std::fs::canonicalize(&d).unwrap();
        assert_eq!(String::from_utf8_lossy(&out3.stdout).trim(), canon.to_string_lossy());
    }

    #[tokio::test]
    async fn v2_raw_provider_degrades_to_v1_when_namespaces_unsupported() {
        let d = mkdir(&tmp_dir("v2-raw"));
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::RawNamespace,
                V2Limits::default(),
                false,
                false,
            )));
        // On kernels where unprivileged namespaces are denied, the raw setup
        // fails at spawn and the layer must fall back to the plain v1 path.
        let out = execute_sandboxed("printf degrade-ok", &cfg, None, None)
            .await
            .expect("degradation keeps the run alive");
        assert_eq!(out.exit_code, Some(0));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "degrade-ok");
    }

    #[tokio::test]
    async fn v2_explicit_userspace_provider_is_v1_equivalent() {
        let d = mkdir(&tmp_dir("v2-user"));
        let cfg = SandboxConfig::new()
            .with_workdir(&d)
            .with_root(&d)
            .with_timeout(Duration::from_secs(10))
            .with_os_layer(Arc::new(OsSandboxV2::from_options(
                V2Provider::Userspace,
                V2Limits::default(),
                false,
                false,
            )));
        let out = execute_sandboxed("printf userspace-ok", &cfg, None, None).await.expect("ok");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "userspace-ok");
        assert_eq!(out.exit_code, Some(0));
    }
}

