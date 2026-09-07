//! W249 P0-3: production tool guard chain — path whitelist guard.
//!
//! Mounted at registry assembly time by the runtime tool-registration path
//! ([`mount_production_guards`]) so the file tools can no longer reach the
//! host filesystem unmediated (roadmap R3 / P0-C):
//! - `read_file` / `list_dir`: the canonical target path must resolve inside
//!   the workspace or an explicitly whitelisted read root
//!   ([`ENV_TOOL_ROOTS`], `PATH`-style separator list);
//! - `write_file`: the canonical target (existing file, or the nearest
//!   existing ancestor plus the not-yet-created suffix) must resolve inside
//!   the workspace only — whitelist roots are read-only (the workspace is the
//!   writable subset of the configured roots, per the W246 P0-3 ruling);
//! - every other tool passes through untouched: `run_shell` keeps its own
//!   sandbox layer, `process_control` operates on registry handles,
//!   `http_request` carries its own target policy, worker tools carry no
//!   `path` argument in this guard's scope.
//!
//! A deny decision carries a stable contract-error shape; the registry then
//! surfaces it as `ToolOutput { error: "denied: <reason>", decision: Deny }`:
//! `toolguard: code=path_forbidden msg="<quoted message>"`.
//!
//! Env knobs (minimal config, P0-3): [`ENV_TOOL_ROOTS`],
//! [`ENV_TOOL_WORKDIR`] (workspace override; default = process cwd pinned at
//! guard construction), [`ENV_TOOL_GUARD`]`=0` (explicit escape hatch — skips
//! mounting only; it never weakens the sandbox or http policy knobs).
//!
//! Known residual gaps (documented, P0-3): TOCTOU between the check and the
//! tool's own open (both resolve the canonical path, but the tool re-opens
//! after the check); `run_shell` can still READ the ro-bound host root inside
//! the sandbox (host readability gap — P0 follow-up, not closed here); the
//! workers plugin's combined registry (`crates/workers/src/plugin.rs`) is now
//! mounted with this guard too (W248 follow-up closed: `WorkersPlugin::mount`
//! calls `mount_production_guards` on its combined registry).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use celestea_core::{ToolDecision, ToolGuard, ToolInput, ToolRegistry};

use crate::registry::ToolRegistryImpl;
use crate::sandbox::env_flag;

/// Env var: `PATH`-style list of extra directories read_file/list_dir may
/// reach (read-only; writes stay workspace-only).
pub const ENV_TOOL_ROOTS: &str = "CELESTEA_TOOL_ROOTS";
/// Env var: workspace override. Default: the process cwd pinned at guard
/// construction.
pub const ENV_TOOL_WORKDIR: &str = "CELESTEA_TOOL_WORKDIR";
/// Env var: `0`/`off` skips mounting the production guard chain (explicit
/// operator escape hatch; default: mounted). Only affects guard mounting.
pub const ENV_TOOL_GUARD: &str = "CELESTEA_TOOL_GUARD";
/// Stable prefix of every guard deny reason.
pub const GUARD_ERROR_PREFIX: &str = "toolguard";

/// The path policy: a canonical writable workspace plus canonical read roots.
#[derive(Debug, Clone)]
pub struct PathGuardPolicy {
    /// Canonical workspace: the only writable root.
    workspace: PathBuf,
    /// Canonical read roots: workspace + explicit whitelist.
    read_roots: Vec<PathBuf>,
}

impl PathGuardPolicy {
    /// Build a policy from a workspace and optional extra read roots.
    /// Roots that cannot be canonicalized (do not exist yet) are kept as
    /// given; the canonical comparison still resolves every target.
    pub fn new(workspace: impl Into<PathBuf>, read_roots: Vec<PathBuf>) -> Self {
        let workspace = canon_or_raw(&workspace.into());
        let mut roots = vec![workspace.clone()];
        roots.extend(read_roots.iter().map(|p| canon_or_raw(p)));
        Self { workspace, read_roots: roots }
    }

    /// Policy from the environment: `CELESTEA_TOOL_WORKDIR` (else process
    /// cwd) + `CELESTEA_TOOL_ROOTS`.
    pub fn from_env() -> Self {
        let workspace = std::env::var_os(ENV_TOOL_WORKDIR)
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir()));
        let extra = std::env::var(ENV_TOOL_ROOTS)
            .ok()
            .map(|v| parse_roots(&v))
            .unwrap_or_default();
        Self::new(workspace, extra)
    }

    /// The canonical writable workspace.
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// All canonical read roots (workspace first).
    pub fn read_roots(&self) -> &[PathBuf] {
        &self.read_roots
    }

    /// read/list: the canonical target must exist inside a read root.
    /// Unresolvable targets pass through so the tool reports its natural
    /// error (the guard only arbitrates real paths).
    pub async fn check_read(&self, path: &str) -> ToolDecision {
        match self.resolve_existing(path).await {
            None => ToolDecision::Allow,
            Some(canon) if self.read_roots.iter().any(|r| canon.starts_with(r)) => {
                ToolDecision::Allow
            }
            Some(_) => deny(
                "path_forbidden",
                format!(
                    "read/list path '{path}' is outside the allowed roots (workspace '{}' + {ENV_TOOL_ROOTS})",
                    self.workspace.display()
                ),
            ),
        }
    }

    /// write: the canonical target (existing file, or nearest existing
    /// ancestor + missing suffix for a new file) must stay inside the
    /// workspace. Whitelist roots do not grant write.
    pub async fn check_write(&self, path: &str) -> ToolDecision {
        match self.resolve_for_write(path).await {
            None => ToolDecision::Allow,
            Some(canon) if canon.starts_with(&self.workspace) => ToolDecision::Allow,
            Some(_) => deny(
                "path_forbidden",
                format!(
                    "write path '{path}' is outside the workspace '{}'",
                    self.workspace.display()
                ),
            ),
        }
    }

    async fn resolve_existing(&self, path: &str) -> Option<PathBuf> {
        tokio::fs::canonicalize(self.absolutize(path)).await.ok()
    }

    async fn resolve_for_write(&self, path: &str) -> Option<PathBuf> {
        let abs = self.absolutize(path);
        if let Ok(c) = tokio::fs::canonicalize(&abs).await {
            return Some(c);
        }
        // The file does not exist yet: canonicalize the nearest existing
        // ancestor and re-append the missing suffix components, so new files
        // are arbitrated by the directory they would be created in.
        let mut suffix: Vec<std::ffi::OsString> = Vec::new();
        let mut cur = abs.as_path();
        loop {
            match tokio::fs::canonicalize(cur).await {
                Ok(c) => {
                    let mut out = c;
                    for seg in suffix.iter().rev() {
                        out.push(seg);
                    }
                    return Some(out);
                }
                Err(_) => match cur.parent() {
                    Some(parent) => {
                        suffix.push(cur.file_name().unwrap_or_default().to_os_string());
                        cur = parent;
                    }
                    None => return None,
                },
            }
        }
    }

    fn absolutize(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.workspace.join(p)
        }
    }
}

/// Split a `PATH`-style list of directories into paths (platform separator:
/// `:` on unix, `;` on windows; empty entries skipped).
pub fn parse_roots(value: &str) -> Vec<PathBuf> {
    std::env::split_paths(value)
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

/// The production path-whitelist guard (W249 P0-3).
#[derive(Debug, Clone)]
pub struct PathGuard {
    policy: Arc<PathGuardPolicy>,
}

impl PathGuard {
    pub fn new(policy: PathGuardPolicy) -> Self {
        Self { policy: Arc::new(policy) }
    }

    pub fn from_env() -> Self {
        Self::new(PathGuardPolicy::from_env())
    }
}

#[async_trait]
impl ToolGuard for PathGuard {
    async fn check(&self, input: &ToolInput) -> ToolDecision {
        let Some(path) = input.args.get("path").and_then(|v| v.as_str()) else {
            // Missing/ill-typed path: the tool's own contract validation
            // produces the error; the guard only arbitrates real paths.
            return ToolDecision::Allow;
        };
        match input.name.as_str() {
            "read_file" | "list_dir" => self.policy.check_read(path).await,
            "write_file" => self.policy.check_write(path).await,
            // run_shell / process_control / http_request / worker tools:
            // not path-guarded here (sandbox layer / own policies).
            _ => ToolDecision::Allow,
        }
    }
}

/// Mount the production guard chain onto a registry (W249 P0-3). Called by
/// the runtime tool-registration path so every Runtime assembly gets the
/// guard. `CELESTEA_TOOL_GUARD=0` skips mounting (explicit, loudly logged
/// escape hatch); it never weakens the sandbox or http policy knobs.
pub fn mount_production_guards(registry: &mut ToolRegistryImpl) {
    if !env_flag(ENV_TOOL_GUARD, true) {
        eprintln!("[celestea] tool guard disabled: {ENV_TOOL_GUARD}=0 — file tools run without the path whitelist (sandbox + http policy knobs unaffected)");
        return;
    }
    registry.add_guard(Box::new(PathGuard::from_env()));
}

fn deny(code: &str, msg: String) -> ToolDecision {
    ToolDecision::Deny(format!("{GUARD_ERROR_PREFIX}: code={code} msg=\"{}\"", quote(&msg)))
}

/// One-line, escaped message payload (mirrors the sandbox's `quoted`).
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
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
    out
}

fn canon_or_raw(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use celestea_core::{ToolInput, ToolRegistry};
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("celestea-guard-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn parse_roots_splits_and_skips_empty() {
        assert_eq!(
            parse_roots("/a:/b:/c"),
            vec![PathBuf::from("/a"), PathBuf::from("/b"), PathBuf::from("/c")]
        );
        assert_eq!(parse_roots(":/a::"), vec![PathBuf::from("/a")]);
        assert_eq!(parse_roots(""), Vec::<PathBuf>::new());
    }

    #[tokio::test]
    async fn read_allowed_inside_workspace_and_whitelist() {
        let ws = tmp("ws");
        let wl = tmp("wl");
        std::fs::write(ws.join("a.txt"), "a").unwrap();
        std::fs::write(wl.join("b.txt"), "b").unwrap();
        let policy = PathGuardPolicy::new(&ws, vec![wl.clone()]);
        assert_eq!(
            policy.check_read(&ws.join("a.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );
        assert_eq!(
            policy.check_read(&wl.join("b.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );

        let outside = tmp("ws-out");
        std::fs::write(outside.join("c.txt"), "c").unwrap();
        let d = policy.check_read(&outside.join("c.txt").to_string_lossy()).await;
        match &d {
            ToolDecision::Deny(reason) => assert!(reason.contains("code=path_forbidden"), "{reason}"),
            other => panic!("expected Deny, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn write_limited_to_workspace_only() {
        let ws = tmp("ws-w");
        let wl = tmp("wl-w");
        let policy = PathGuardPolicy::new(&ws, vec![wl.clone()]);

        // existing file inside the workspace: allowed
        std::fs::write(ws.join("ok.txt"), "x").unwrap();
        assert_eq!(
            policy.check_write(&ws.join("ok.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );
        // not-yet-created file inside the workspace: allowed
        assert_eq!(
            policy.check_write(&ws.join("new.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );
        // whitelist root is read-only: denied
        let d = policy.check_write(&wl.join("x.txt").to_string_lossy()).await;
        assert!(
            matches!(&d, ToolDecision::Deny(r) if r.contains("code=path_forbidden")),
            "{d:?}"
        );
        // outside the workspace: denied
        let outside = tmp("ws-w-out");
        let d = policy.check_write(&outside.join("y.txt").to_string_lossy()).await;
        assert!(
            matches!(&d, ToolDecision::Deny(r) if r.contains("code=path_forbidden")),
            "{d:?}"
        );
    }

    #[tokio::test]
    async fn relative_paths_resolve_against_workspace() {
        let ws = tmp("ws-rel");
        let policy = PathGuardPolicy::new(&ws, vec![]);
        // relative new-file write resolves inside the workspace
        assert_eq!(policy.check_write("sub/dir/f.txt").await, ToolDecision::Allow);

        // a relative `..` escape reaching an existing file outside is denied
        let outside = tmp("ws-rel-out");
        std::fs::write(outside.join("outside.txt"), "x").unwrap();
        let rel = format!("../{}/outside.txt", outside.file_name().unwrap().to_string_lossy());
        let d = policy.check_read(&rel).await;
        assert!(
            matches!(&d, ToolDecision::Deny(r) if r.contains("code=path_forbidden")),
            "{d:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_is_denied() {
        let ws = tmp("ws-link");
        let outside = tmp("ws-link-out");
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), ws.join("link.txt")).unwrap();
        let policy = PathGuardPolicy::new(&ws, vec![]);
        let d = policy.check_read(&ws.join("link.txt").to_string_lossy()).await;
        assert!(
            matches!(&d, ToolDecision::Deny(r) if r.contains("code=path_forbidden")),
            "{d:?}"
        );
    }

    #[tokio::test]
    async fn guard_passes_non_file_tools_through() {
        let ws = tmp("ws-pass");
        let guard = PathGuard::new(PathGuardPolicy::new(&ws, vec![]));
        for name in ["run_shell", "process_control", "http_request", "spawn_worker"] {
            let input = ToolInput {
                call_id: "c".into(),
                name: name.into(),
                args: json!({ "path": "/etc/passwd" }),
            };
            assert_eq!(guard.check(&input).await, ToolDecision::Allow, "{name}");
        }
        // missing path arg -> Allow (the tool's own validation reports it)
        let input = ToolInput { call_id: "c".into(), name: "read_file".into(), args: json!({}) };
        assert_eq!(guard.check(&input).await, ToolDecision::Allow);
    }

    #[tokio::test]
    async fn dispatch_denies_out_of_workspace_write_with_contract_shape() {
        let ws = tmp("ws-disp");
        let outside = tmp("ws-disp-out");
        let mut registry = ToolRegistryImpl::new();
        for tool in crate::builtin::builtin_tools() {
            registry.register(tool);
        }
        registry.add_guard(Box::new(PathGuard::new(PathGuardPolicy::new(&ws, vec![]))));

        // out-of-workspace write: denied with the contract shape, no side effect
        let out = registry
            .dispatch(ToolInput {
                call_id: "w1".into(),
                name: "write_file".into(),
                args: json!({ "path": outside.join("x.txt").to_string_lossy(), "content": "x" }),
            })
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("deny error");
        assert!(err.starts_with("denied: toolguard: code=path_forbidden"), "{err}");
        match out.decision {
            Some(ToolDecision::Deny(r)) => assert!(r.contains("code=path_forbidden"), "{r}"),
            other => panic!("expected Deny, got {other:?}"),
        }
        assert!(!outside.join("x.txt").exists(), "denied write must not touch the fs");

        // in-workspace write: allowed and executed
        let ok = registry
            .dispatch(ToolInput {
                call_id: "w2".into(),
                name: "write_file".into(),
                args: json!({ "path": ws.join("ok.txt").to_string_lossy(), "content": "hi" }),
            })
            .await;
        assert!(ok.error.is_none(), "{:?}", ok.error);
        assert!(ws.join("ok.txt").exists());

        // run_shell is not intercepted by the path guard
        let sh = registry
            .dispatch(ToolInput {
                call_id: "s1".into(),
                name: "run_shell".into(),
                args: json!({ "command": "printf hi" }),
            })
            .await;
        assert!(sh.error.is_none(), "{:?}", sh.error);
        assert_eq!(sh.decision, Some(ToolDecision::Allow));
        assert_eq!(sh.value.as_ref().unwrap()["stdout"], json!("hi"));
    }

    #[tokio::test]
    async fn dispatch_denies_out_of_workspace_read() {
        let ws = tmp("ws-disp-r");
        let outside = tmp("ws-disp-r-out");
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let mut registry = ToolRegistryImpl::new();
        for tool in crate::builtin::builtin_tools() {
            registry.register(tool);
        }
        registry.add_guard(Box::new(PathGuard::new(PathGuardPolicy::new(&ws, vec![]))));

        let out = registry
            .dispatch(ToolInput {
                call_id: "r1".into(),
                name: "read_file".into(),
                args: json!({ "path": outside.join("secret.txt").to_string_lossy() }),
            })
            .await;
        assert_eq!(out.value, None);
        let err = out.error.expect("deny error");
        assert!(err.starts_with("denied: toolguard: code=path_forbidden"), "{err}");
        assert!(matches!(out.decision, Some(ToolDecision::Deny(_))));
    }

    #[tokio::test]
    async fn from_env_reads_roots_and_workdir() {
        let ws = tmp("ws-env");
        let wl = tmp("wl-env");
        std::fs::write(wl.join("e.txt"), "e").unwrap();
        std::env::set_var(ENV_TOOL_WORKDIR, &ws);
        std::env::set_var(ENV_TOOL_ROOTS, wl.to_string_lossy().as_ref());
        let policy = PathGuardPolicy::from_env();
        assert_eq!(
            policy.check_read(&wl.join("e.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );
        assert_eq!(
            policy.check_write(&ws.join("z.txt").to_string_lossy()).await,
            ToolDecision::Allow
        );
        std::env::remove_var(ENV_TOOL_WORKDIR);
        std::env::remove_var(ENV_TOOL_ROOTS);
    }
}
