//! W237: workspace registry + per-session directories over CELESTEA_SESSION_DIR.
//! W244: workspace KEY = folder basename (v2 registry) + optional session
//! metadata (session.json model).
//!
//! Model ("no global main session; every session is an independently
//! switchable unit"):
//!   - workspace = a USER folder registered by path in `workspaces.json`
//!     (atomic tmp+rename writes). The workspace key in every id/contract is
//!     the folder basename (`Path::file_name`) — names are NEVER stored
//!     (v2: {"workspaces":[{"path":...}],"active_session":"<basename>/<sess>"};
//!     v1 "name" fields are migrated away at load, active_session's ws
//!     segment rewritten to the basename, idempotent). Deleting a workspace
//!     only DEREGISTERS it — the folder is never touched; RENAMING a
//!     workspace renames the folder itself (fs::rename).
//!   - session = a directory directly inside a workspace path containing
//!     `cli-main.jsonl` (the engine's PersistentSessionLog replay file; the
//!     engine replays `<CELESTEA_SESSION_DIR>/cli-main.jsonl` at compose
//!     time). The session id is "<basename>/<dir>". `cli-main` is just the
//!     engine's internal file name — it holds no privileges; the ONLY
//!     restriction is that the active session cannot be archived or deleted
//!     (400). An optional `session.json` ({"model":"<id>"}) per session is
//!     honored by activate (model hot-apply via the post_config/prepare_gen
//!     path) and travels with branches.
//!   - activation = point CELESTEA_SESSION_DIR at the session directory and
//!     re-compose the engine generation (the compose replays cli-main.jsonl
//!     through PersistentSessionLog) — zero engine changes.
//!
//! Legacy migration (runs only when workspaces.json is missing; idempotent):
//!   sessions/cli-main.jsonl       -> sessions/cli-main/cli-main.jsonl
//!   sessions/<loose>.jsonl        -> sessions/<loose>/cli-main.jsonl
//!   sessions/<ws>/<file>.jsonl    -> sessions/<ws>/<file>/cli-main.jsonl
//!   workspaces.json = {"workspaces":[{"path":"<cwd>/sessions"}],
//!                       "active_session":"sessions/cli-main"}
//!   Legacy hidden dirs (.trash / .archived) and already-migrated session
//!   files are never touched; every move checks its target first, so a
//!   re-run is a no-op.
//!
//! All path joins go through [resolve_session_dir]: the workspace name is a
//! registry lookup (never a path component) and the session name is sanitized
//! (separators/control/whitespace -> '_', CJK kept) plus "." / ".." /
//! hidden-name rejection; the resolved path is parent-verified to sit
//! directly inside the registered workspace path — no traversal.
//!
//! Endpoints (mounted in main):
//!   GET  /api/workspaces                 -> {"workspaces":[{"name":<basename>,"path","sessions"}],"active_session"}
//!   POST /api/workspaces {"path"}        -> register (absolute existing dir; key = folder
//!                                           basename; dup path/basename 409; v1 "name" ignored)
//!   POST /api/workspaces/{name}/rename   -> rename the FOLDER itself (sanitize keeps CJK;
//!                                           target exists 409; active session re-composed)
//!   POST /api/workspaces/{name}/delete   -> deregister only, {"ok":true}
//!   POST /api/workspaces/batch-delete    -> same, {"names":[...]}
//!   GET  /api/fs/browse?path=            -> {"path","parent","dirs","roots","error"?}
//!   GET  /api/sessions                   -> {"sessions":[{"id","workspace","title","size","modified","active"}],"active_session"}
//!   POST /api/sessions {"workspace","title"} -> create "<sanitized title>-<ts>/cli-main.jsonl"
//!   POST /api/sessions/{id}/activate     -> busy 409; env + recompose; persist
//!   POST /api/sessions/{id}/rename        -> rename the session dir (sanitize keeps
//!                                           CJK; collisions get a -n suffix); the
//!                                           active session follows the activate
//!                                           path (busy 409, env + recompose, persist)
//!   POST /api/sessions/{id}/branch        -> copy cli-main.jsonl into a fresh
//!                                           sibling dir (default title "<源名>-分支";
//!                                           timestamped); never activates
//!   POST /api/workspaces/{name}/rename    -> registry-only rename (user folder
//!                                           untouched); duplicate name 409; returns
//!                                           the new registry view
//!   POST /api/sessions/{id}/archive|unarchive -> <ws-path>/.celestea-archived/ moves
//!   POST /api/sessions/batch-archive|batch-delete -> .celestea-archived / .celestea-trash
//!   GET  /api/sessions/{id}/messages     -> cli-main.jsonl transcript; ids
//!                                           prefixed "worker:" read the
//!                                           engine's in-memory worker
//!                                           SessionRegistry instead (W239)
//!   POST /api/clear                      -> clear the active session log
//!
//! W239: GET /api/sessions adds a THIRD source — engine worker sessions
//! (spawn_worker products living in the in-memory SessionRegistry behind
//! gen.runtime.workers.sessions(), never on disk): id "worker:<sid>",
//! pseudo-workspace "engine", kind "worker", size = event count of the
//! worker log. The compose-time "cli-main" shadow registration (HOST_SID)
//! is skipped — the host conversation is already listed from its workspace
//! directory. Worker transcripts are read from the same registry in
//! get_session_messages via the session_event_to_message mapping.

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use celestea_runtime::SessionLog;
use crate::{prepare_gen, profile_to_json, swap_gen, Shared};

/// Reserved hidden dirs under a workspace path (never scanned, never listed).
pub(crate) const ARCHIVED_DIR: &str = ".celestea-archived";
pub(crate) const TRASH_DIR: &str = ".celestea-trash";
/// The engine's internal session file name (PersistentSessionLog / HOST_SID
/// "cli-main"). No privileges attached on the studio side anymore.
pub(crate) const SESSION_FILE: &str = "cli-main.jsonl";
/// W239: the engine's compose-time shadow registration of the host
/// conversation in the shared worker SessionRegistry (celestea-runtime
/// compose::HOST_SID). Never listed as a worker session — the host session
/// is already listed from its workspace directory.
pub(crate) const WORKER_HOST_SHADOW_SID: &str = "cli-main";
/// W244: optional per-session metadata file inside the session directory
/// (currently {"model":"<id>"}); absent = defaults.
pub(crate) const SESSION_META: &str = "session.json";
/// W237 fs-browse contract: the suggested starting points for the frontend
/// file manager (informational only — browsing is not restricted to them).
pub(crate) const FS_ROOTS: [&str; 4] = ["/src", "/tmp", "/srv", "/home"];
/// fs-browse entry cap (contract).
const MAX_DIR_ENTRIES: usize = 200;

// ---- registry -----------------------------------------------------------------

/// One registered workspace: the user folder path. The workspace KEY in
/// every id/contract is the folder basename (`Path::file_name`) — names are
/// never stored (v1 "name" fields are migrated away at load).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Workspace {
    pub(crate) path: String,
}

/// The workspace key: the folder basename of the registered path.
pub(crate) fn workspace_basename(path: &str) -> Option<String> {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned())
}

/// The workspaces.json root: workspaces + the persisted active session id
/// ("<workspace>/<session>").
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct RegistryData {
    #[serde(default)]
    pub(crate) workspaces: Vec<Workspace>,
    #[serde(default)]
    pub(crate) active_session: Option<String>,
}

/// Shared registry store: RwLock over the parsed file + its path; every
/// mutation persists immediately (atomic tmp+rename; no secrets, plain mode).
pub(crate) struct WorkspaceRegistry {
    path: PathBuf,
    inner: RwLock<RegistryData>,
}

impl WorkspaceRegistry {
    /// In-memory store over `path` (tests / callers that manage the file
    /// themselves).
    #[cfg(test)]
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path, inner: RwLock::new(RegistryData::default()) }
    }

    /// Clone of the current data.
    pub(crate) fn snapshot(&self) -> RegistryData {
        self.inner.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The persisted active session id, if any.
    pub(crate) fn active_session(&self) -> Option<String> {
        self.snapshot().active_session
    }

    /// W244: register a user folder by path — the workspace key is the
    /// folder basename (never a caller-supplied name). Duplicate path -> 409;
    /// a DIFFERENT path whose folder basename collides with an existing
    /// workspace -> 409 (hint: rename one folder). Returns the basename key.
    pub(crate) fn register(&self, path: &str) -> Result<String, (StatusCode, String)> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        if let Some(w) = data.workspaces.iter().find(|w| w.path == path) {
            return Err((
                StatusCode::CONFLICT,
                format!("path '{path}' is already registered as workspace '{}'", workspace_basename(&w.path).unwrap_or_default()),
            ));
        }
        let base = workspace_basename(path)
            .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("path '{path}' has no folder name")))?;
        if let Some(w) = data.workspaces.iter().find(|w| workspace_basename(&w.path).as_deref() == Some(base.as_str())) {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "workspace '{base}' already exists (folder '{path}' and '{}' share the same folder name; rename one folder first)",
                    w.path
                ),
            ));
        }
        data.workspaces.push(Workspace { path: path.to_string() });
        self.persist_locked(&data)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(base)
    }

    /// Deregister a workspace — the user folder is NOT touched. When the
    /// active session lived in that workspace its id would dangle, so it is
    /// cleared (the engine keeps running on its current dir; /api/status
    /// then reports session null). Unknown name -> 404.
    pub(crate) fn deregister(&self, name: &str) -> Result<(), (StatusCode, String)> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let before = data.workspaces.len();
        data.workspaces
            .retain(|w| workspace_basename(&w.path).as_deref() != Some(name));
        if data.workspaces.len() == before {
            return Err((StatusCode::NOT_FOUND, format!("unknown workspace '{name}'")));
        }
        if let Some(active) = &data.active_session {
            if active.strip_prefix(name).is_some_and(|rest| rest.starts_with('/')) {
                data.active_session = None;
            }
        }
        self.persist_locked(&data)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))
    }

    /// W244: rename the workspace FOLDER on disk (fs::rename — this DOES
    /// move the user folder; new_name is pre-sanitized by the caller and the
    /// target must not exist). Updates the registered path and re-points the
    /// active session id ("<old>/<sess>" -> "<new>/<sess>"). Unknown old key
    /// -> 404; duplicate workspace key -> 409; target exists -> 409. A
    /// failed persist rolls the disk move back.
    pub(crate) fn rename_workspace(
        &self,
        old: &str,
        new_name: &str,
    ) -> Result<(), (StatusCode, String)> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        let Some(pos) = data.workspaces.iter().position(|w| workspace_basename(&w.path).as_deref() == Some(old)) else {
            return Err((StatusCode::NOT_FOUND, format!("unknown workspace '{old}'")));
        };
        if new_name == old {
            return Ok(()); // no-op
        }
        if data.workspaces.iter().enumerate().any(|(i, w)| i != pos && workspace_basename(&w.path).as_deref() == Some(new_name)) {
            return Err((StatusCode::CONFLICT, format!("workspace '{new_name}' already exists")));
        }
        let old_path = PathBuf::from(&data.workspaces[pos].path);
        let parent = old_path.parent().ok_or_else(|| {
            (StatusCode::INTERNAL_SERVER_ERROR, format!("path '{}' has no parent", old_path.display()))
        })?;
        let new_path = parent.join(new_name);
        if new_path.exists() {
            return Err((
                StatusCode::CONFLICT,
                format!("target '{}' already exists; rename the folder first", new_path.display()),
            ));
        }
        std::fs::rename(&old_path, &new_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
        data.workspaces[pos].path = new_path.display().to_string();
        if let Some(active) = &data.active_session {
            if let Some(rest) = active.strip_prefix(old) {
                if rest.starts_with('/') {
                    data.active_session = Some(format!("{new_name}{rest}"));
                }
            }
        }
        if let Err(e) = self.persist_locked(&data) {
            // roll the disk move back and restore the in-memory registry
            let _ = std::fs::rename(&new_path, &old_path);
            data.workspaces[pos].path = old_path.display().to_string();
            if let Some(active) = &data.active_session {
                if let Some(rest) = active.strip_prefix(new_name) {
                    if rest.starts_with('/') {
                        data.active_session = Some(format!("{old}{rest}"));
                    }
                }
            }
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e));
        }
        Ok(())
    }

    /// Persist the active session id (or clear it with None).
    pub(crate) fn set_active(&self, id: Option<String>) -> Result<(), String> {
        let mut data = self.inner.write().unwrap_or_else(|p| p.into_inner());
        data.active_session = id;
        self.persist_locked(&data)
    }

    /// Atomic save: pretty JSON to `<path>.json.tmp` then rename over the
    /// target (no secrets here, so no 0600 requirement).
    fn persist_locked(&self, data: &RegistryData) -> Result<(), String> {
        let text = serde_json::to_string_pretty(data)
            .map_err(|e| format!("workspaces serialize failed: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text.as_bytes())
            .map_err(|e| format!("cannot write workspaces tmp '{}': {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            format!("workspaces rename onto '{}' failed: {e}", self.path.display())
        })
    }
}

/// W244 v1->v2 registry normalization (idempotent): v1 stored a free-form
/// "name" per workspace; v2 keys every workspace by its folder basename.
/// Load drops any "name" field, re-derives keys from the paths, and rewrites
/// active_session's workspace segment to the basename. The file is only
/// rewritten when something changed, so re-loading is a no-op. Two
/// workspaces resolving to the same basename is a hard error (ambiguous
/// keys — rename one folder). A malformed file is a hard error too.
pub(crate) fn normalize_registry(
    mut data: RegistryData,
    v1_names: &[(String, String)], // (old v1 name, folder basename) pairs
) -> Result<(RegistryData, bool), String> {
    let mut changed = false;
    let mut seen = std::collections::HashSet::new();
    for w in &data.workspaces {
        let base = workspace_basename(&w.path).ok_or_else(|| {
            format!("workspace path '{}' has no folder name", w.path)
        })?;
        if !seen.insert(base.clone()) {
            return Err(format!(
                "two workspaces resolve to the same folder name '{base}' (workspace keys must be unique basenames; rename one folder)"
            ));
        }
    }
    if let Some(active) = &data.active_session {
        if let Some((ws, sess)) = active.split_once('/') {
            // v1 name -> basename mapping takes priority; a v2 id already uses
            // the basename and simply matches its workspace directly.
            let expected = v1_names
                .iter()
                .find(|(n, _)| n == ws)
                .map(|(_, b)| b.clone())
                .or_else(|| {
                    data.workspaces
                        .iter()
                        .find(|w| workspace_basename(&w.path).as_deref() == Some(ws))
                        .and_then(|w| workspace_basename(&w.path))
                });
            if let Some(expected) = expected {
                if ws != expected {
                    data.active_session = Some(format!("{expected}/{sess}"));
                    changed = true;
                }
            }
        }
    }
    Ok((data, changed))
}

/// Load the registry from `path`. A missing file triggers the W237
/// bootstrap: migrate the legacy flat `sessions/` layout into per-session
/// directories, then create workspaces.json with the single default
/// workspace (folder basename of `default_root`) and active_session
/// "<basename>/cli-main". A malformed file is a hard error (never overwrite
/// a registry we cannot read).
pub(crate) fn load_registry(
    path: PathBuf,
    default_root: &Path,
) -> Result<WorkspaceRegistry, String> {
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let data: RegistryData = serde_json::from_str(&text).map_err(|e| {
                format!("workspaces.json '{}' is malformed: {e}", path.display())
            })?;
            // v1 detection + name->basename map: v1 workspaces carry a
            // free-form "name" field and the active id uses that name as its
            // workspace segment, so the migration needs the old mapping.
            let mut v1_names: Vec<(String, String)> = Vec::new();
            if let Ok(raw) = serde_json::from_str::<Value>(&text) {
                if let Some(arr) = raw.get("workspaces").and_then(|w| w.as_array()) {
                    for w in arr {
                        if let (Some(name), Some(path)) = (
                            w.get("name").and_then(|n| n.as_str()),
                            w.get("path").and_then(|p| p.as_str()),
                        ) {
                            if let Some(base) = workspace_basename(path) {
                                v1_names.push((name.to_string(), base));
                            }
                        }
                    }
                }
            }
            let had_names = !v1_names.is_empty();
            let (data, changed) = normalize_registry(data, &v1_names)?;
            if changed || had_names {
                let reg = WorkspaceRegistry { path: path.clone(), inner: RwLock::new(data.clone()) };
                reg.persist_locked(&data)?;
                if had_names {
                    eprintln!(
                        "[celestea-studio] workspaces.json v1 -> v2 migrated: 'name' dropped, workspace key = folder basename ({} registered)",
                        data.workspaces.len(),
                    );
                }
                eprintln!(
                    "[celestea-studio] workspaces.json normalized: active_session={:?}",
                    data.active_session,
                );
            }
            eprintln!(
                "[celestea-studio] workspaces: {} registered, active_session={:?}",
                data.workspaces.len(),
                data.active_session,
            );
            Ok(WorkspaceRegistry { path, inner: RwLock::new(data) })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let moved = migrate_legacy_layout(default_root)?;
            let base = workspace_basename(&default_root.display().to_string())
                .ok_or_else(|| format!("default root '{}' has no folder name", default_root.display()))?;
            let data = RegistryData {
                workspaces: vec![Workspace {
                    path: default_root.display().to_string(),
                }],
                active_session: Some(format!("{base}/cli-main")),
            };
            let reg = WorkspaceRegistry { path, inner: RwLock::new(data.clone()) };
            reg.persist_locked(&data)?;
            eprintln!(
                "[celestea-studio] workspaces.json created: workspace '{}' -> {} ({} legacy file(s) migrated)",
                base,
                default_root.display(),
                moved,
            );
            Ok(reg)
        }
        Err(e) => Err(format!("cannot read workspaces.json '{}': {e}", path.display())),
    }
}

/// W237 legacy migration, idempotent:
///   - every loose `*.jsonl` directly in `root` (the host cli-main.jsonl
///     included) -> `root/<stem>/cli-main.jsonl`;
///   - every `*.jsonl` inside a direct subdirectory (except dot-dirs — the
///     legacy .trash/.archived are never migrated) ->
///     `root/<ws>/<stem>/cli-main.jsonl`; a file already named
///     cli-main.jsonl inside a subdirectory IS a session file -> skipped.
/// Every move checks its target first, so re-running is a no-op and never
/// duplicates or overwrites anything. Per-file failures are logged and
/// skipped (data stays in place) — migration must never break startup.
fn migrate_legacy_layout(root: &Path) -> Result<u64, String> {
    let mut moved: u64 = 0;
    if !root.is_dir() {
        return Ok(0);
    }
    // Safety net: snapshot every legacy jsonl before any move, so a botched
    // migration (or a concurrent smoke test writing into the live dir) can
    // never lose history. Backup lands in root/.backup-<unix-ts>/.
    if let Ok(ts) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        let backup_root = root.join(format!(".backup-{}", ts.as_secs()));
        if let Err(e) = backup_legacy_files(root, &backup_root) {
            eprintln!("[celestea-studio] legacy backup failed: {e}");
        }
    }
    // 1. root loose files -> root/<stem>/cli-main.jsonl
    for f in jsonl_files(root)? {
        let Some(stem) = f.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        let target_dir = root.join(&stem);
        let target = target_dir.join(SESSION_FILE);
        if target.exists() {
            continue; // already migrated
        }
        match migrate_one(&f, &target_dir, &target) {
            Ok(()) => moved += 1,
            Err(e) => eprintln!("[celestea-studio] migration skip '{}': {e}", f.display()),
        }
    }
    // 2. legacy workspace subdirs -> nested session dirs
    let mut subs: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue; // legacy .trash/.archived stay untouched
            }
            subs.push(e.path());
        }
    }
    for ws in subs {
        for f in jsonl_files(&ws)? {
            if f.file_name().and_then(|n| n.to_str()) == Some(SESSION_FILE) {
                continue; // already a session file (post-migration state)
            }
            let Some(stem) = f.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
                continue;
            };
            let target_dir = ws.join(&stem);
            let target = target_dir.join(SESSION_FILE);
            if target.exists() {
                continue;
            }
            match migrate_one(&f, &target_dir, &target) {
                Ok(()) => moved += 1,
                Err(e) => eprintln!("[celestea-studio] migration skip '{}': {e}", f.display()),
            }
        }
    }
    Ok(moved)
}

/// Copy every legacy jsonl (root level + direct subdirs, dot-dirs skipped)
/// into a mirror tree under `backup`. Best-effort: per-file failures are
/// ignored — the migration itself still proceeds, but history stays put.
fn backup_legacy_files(root: &Path, backup: &Path) -> std::io::Result<()> {
    let mut sources: Vec<PathBuf> = jsonl_files(root).unwrap_or_default();
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            sources.extend(jsonl_files(&e.path()).unwrap_or_default());
        }
    }
    for src in sources {
        let rel = src
            .strip_prefix(root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| PathBuf::from(src.file_name().unwrap_or_default()));
        let dst = backup.join(&rel);
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(&src, &dst);
    }
    Ok(())
}

/// Move one legacy file into its session directory as cli-main.jsonl.
fn migrate_one(src: &Path, target_dir: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("cannot create '{}': {e}", target_dir.display()))?;
    std::fs::rename(src, target)
        .map_err(|e| format!("cannot move into '{}': {e}", target.display()))
}

/// *.jsonl FILES directly inside `dir` (non-recursive, sorted for
/// determinism).
fn jsonl_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let rd = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read '{}': {e}", dir.display()))?;
    let mut files: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| {
            e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && e.file_name().to_string_lossy().ends_with(".jsonl")
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    Ok(files)
}

// ---- path rules ---------------------------------------------------------------

/// Sanitize one path component: separators / control chars / whitespace
/// become '_', everything else survives — CJK and other Unicode letters are
/// kept (Chinese UI). Not a listing filter: names starting with '.' are
/// rejected by the callers that need visibility guarantees.
pub(crate) fn sanitize_component(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | '\0' | '\u{7f}'..='\u{9f}' => '_',
            c if c.is_control() || c.is_whitespace() => '_',
            c => c,
        })
        .collect()
}

/// W244: validate a FOLDER name for workspace rename (sanitize keeps CJK,
/// separators/whitespace -> '_'), then reject empty / "." / "..". The name
/// becomes a real path component via fs::rename, but sanitize_component has
/// already removed separators; hidden-dir reservations don't apply.
pub(crate) fn validate_workspace_name(name: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("workspace name must not be empty".to_string());
    }
    let s = sanitize_component(name);
    if s.is_empty() {
        return Err("workspace name must not be empty".to_string());
    }
    if s == "." || s == ".." {
        return Err(format!("invalid workspace name '{name}'"));
    }
    Ok(s)
}

/// Split a session id into ("<workspace>", "<session>"): exactly one slash,
/// both sides non-empty, the session part separator-free.
fn parse_session_id(id: &str) -> Option<(&str, &str)> {
    let id = id.trim();
    if id.is_empty() {
        return None;
    }
    let (ws, name) = id.split_once('/')?;
    if ws.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some((ws, name))
}

/// Resolve a session id to ("<workspace>", "<sanitized session>", dir).
/// The workspace part is a registry lookup (never a path component); the
/// session part is sanitized, rejects "." / ".." / hidden names, and the
/// resolved dir is parent-verified to sit directly inside the registered
/// workspace path — no traversal.
pub(crate) fn resolve_session_dir(
    data: &RegistryData,
    id: &str,
) -> Result<(String, String, PathBuf), (StatusCode, String)> {
    let Some((ws_name, sess)) = parse_session_id(id) else {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("invalid session id '{id}': expected '<workspace>/<session>'"),
        ));
    };
    let Some(ws) = data
        .workspaces
        .iter()
        .find(|w| workspace_basename(&w.path).as_deref() == Some(ws_name))
    else {
        return Err((StatusCode::NOT_FOUND, format!("unknown workspace '{ws_name}'")));
    };
    let name = sanitize_component(sess);
    if name.is_empty() || name == "." || name == ".." || name.starts_with('.') {
        return Err((StatusCode::BAD_REQUEST, format!("invalid session id '{id}'")));
    }
    let ws_path = PathBuf::from(&ws.path);
    let dir = ws_path.join(&name);
    // Belt-and-braces: the sanitized name cannot contain a separator, but
    // verify the resolved dir still sits directly under the workspace path.
    if dir.parent() != Some(ws_path.as_path()) {
        return Err((StatusCode::BAD_REQUEST, format!("invalid session id '{id}'")));
    }
    Ok((ws_name.to_string(), name, dir))
}

/// Resolve + existence check: the session dir must hold cli-main.jsonl.
pub(crate) fn session_dir_for(
    data: &RegistryData,
    id: &str,
) -> Result<(String, String, PathBuf), (StatusCode, String)> {
    let (ws, name, dir) = resolve_session_dir(data, id)?;
    if !dir.is_dir() || !dir.join(SESSION_FILE).is_file() {
        return Err((StatusCode::NOT_FOUND, format!("unknown session '{id}'")));
    }
    Ok((ws, name, dir))
}

/// "<secs>.<nanos>" timestamp used for creation/trash suffixes.
fn now_ts() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{}", d.as_secs(), d.subsec_nanos())
}

/// Count session dirs directly under a workspace path (dirs containing
/// cli-main.jsonl; dot-dirs never scanned).
pub(crate) fn count_session_dirs(ws_path: &Path) -> u64 {
    scan_session_dirs(ws_path, |_, _, _| {}) as u64
}

/// Scan the session dirs directly under a workspace path: every direct
/// subdirectory (dot-prefixed names skipped) that contains cli-main.jsonl.
/// The callback gets (dir name, dir path, cli-main.jsonl path).
fn scan_session_dirs(ws_path: &Path, mut f: impl FnMut(&str, &Path, &Path)) -> usize {
    let Ok(rd) = std::fs::read_dir(ws_path) else {
        return 0;
    };
    let mut n = 0usize;
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let file = e.path().join(SESSION_FILE);
        if !file.is_file() {
            continue;
        }
        n += 1;
        f(&name, &e.path(), &file);
    }
    n
}

// ---- fs browse -----------------------------------------------------------------

/// Read-only directory browse: absolute existing dir required; only DIRECTORY
/// names are returned (files are never listed), dot-names are hidden,
/// symlinks are never followed (a symlink's file_type is the link itself,
/// not its target, so it is not a dir here), sorted, capped at 200 entries.
pub(crate) fn browse_dirs(path: &Path) -> Result<Vec<String>, String> {
    if !path.is_absolute() {
        return Err(format!("path '{}' must be absolute", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("path '{}' is not an existing directory", path.display()));
    }
    let rd = std::fs::read_dir(path)
        .map_err(|e| format!("cannot read '{}': {e}", path.display()))?;
    let mut dirs: Vec<String> = Vec::new();
    for e in rd.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(name) = e.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        dirs.push(name);
    }
    dirs.sort();
    dirs.truncate(MAX_DIR_ENTRIES);
    Ok(dirs)
}

/// GET /api/fs/browse?path= -> {"path","parent","dirs","roots","error"?}
#[derive(Deserialize)]
pub(crate) struct BrowseQuery {
    pub(crate) path: Option<String>,
}

pub(crate) async fn get_fs_browse(Query(q): Query<BrowseQuery>) -> Response {
    // Missing/empty path = the initial view: list the filesystem root, so the
    // picker opens with a usable tree instead of an error fallback.
    let raw = q
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("/");
    let p = Path::new(raw);
    match browse_dirs(p) {
        Ok(dirs) => (
            StatusCode::OK,
            Json(json!({
                "path": raw,
                "parent": p.parent().map(|x| x.display().to_string()).unwrap_or_else(|| "/".to_string()),
                "dirs": dirs,
                "roots": FS_ROOTS,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "path": raw,
                "parent": Value::Null,
                "dirs": [],
                "roots": FS_ROOTS,
                "error": e,
            })),
        )
            .into_response(),
    }
}

// ---- workspace handlers --------------------------------------------------------

fn err_response(code: StatusCode, msg: String) -> Response {
    (code, Json(json!({"ok": false, "error": msg}))).into_response()
}

/// The registry view contract (used by GET /api/workspaces and returned
/// after a registry mutation): {"workspaces":[{"name","path","sessions"}],
/// "active_session":"<ws>/<session>"|null}
pub(crate) fn workspaces_view(st: &Shared) -> Value {
    let data = st.workspaces.snapshot();
    let workspaces: Vec<Value> = data
        .workspaces
        .iter()
        .map(|w| {
            json!({
                "name": workspace_basename(&w.path),
                "path": w.path,
                "sessions": count_session_dirs(Path::new(&w.path)),
            })
        })
        .collect();
    json!({"workspaces": workspaces, "active_session": data.active_session})
}

/// GET /api/workspaces -> the registry view.
pub(crate) async fn get_workspaces(State(st): State<Shared>) -> Json<Value> {
    Json(workspaces_view(&st))
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceCreateReq {
    /// W244: the workspace key IS the folder basename — nothing else is
    /// needed. The v1 "name" field is tolerated and ignored.
    pub(crate) path: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) name: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceRenameReq {
    pub(crate) new_name: String,
}

/// POST /api/workspaces {"path"} — register a user folder as a workspace;
/// the workspace key is the folder basename (the v1 "name" field is
/// tolerated and ignored). The path must be an absolute existing directory;
/// the folder is never created or modified by the studio. Duplicate path or
/// duplicate basename -> 409.
pub(crate) async fn post_workspace_create(
    State(st): State<Shared>,
    Json(req): Json<WorkspaceCreateReq>,
) -> Response {
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return err_response(StatusCode::BAD_REQUEST, "path must not be empty".to_string());
    }
    let p = Path::new(&path);
    if !p.is_absolute() {
        return err_response(StatusCode::BAD_REQUEST, format!("path '{path}' must be absolute"));
    }
    if !p.is_dir() {
        return err_response(
            StatusCode::BAD_REQUEST,
            format!("path '{path}' is not an existing directory"),
        );
    }
    match st.workspaces.register(&path) {
        Ok(base) => (
            StatusCode::OK,
            Json(json!({"ok": true, "name": base})),
        )
            .into_response(),
        Err((code, e)) => err_response(code, e),
    }
}

#[derive(Deserialize)]
pub(crate) struct BatchNamesReq {
    pub(crate) names: Vec<String>,
}

/// POST /api/workspaces/{name}/delete — deregister only ({"ok":true}); the
/// user's folder is never touched.
pub(crate) async fn post_workspace_delete(
    State(st): State<Shared>,
    AxPath(name): AxPath<String>,
) -> Response {
    match st.workspaces.deregister(&name) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err((code, e)) => err_response(code, e),
    }
}

/// POST /api/workspaces/{name}/rename {"new_name"} — W244: rename the
/// workspace FOLDER on disk (fs::rename; sanitize keeps CJK; existing target
/// -> 409) and update the registered path + active_session references. When
/// the active session lives in the workspace, CELESTEA_SESSION_DIR is
/// re-pointed at the moved session dir and the generation re-composed
/// (activate path; busy 409; a failed compose/persist rolls the folder move
/// back). Response: the new registry view.
pub(crate) async fn post_workspace_rename(
    State(st): State<Shared>,
    AxPath(name): AxPath<String>,
    Json(req): Json<WorkspaceRenameReq>,
) -> Response {
    let new_name = match validate_workspace_name(&req.new_name) {
        Ok(n) => n,
        Err(e) => return err_response(StatusCode::BAD_REQUEST, e),
    };
    let data = st.workspaces.snapshot();
    let active_here = data
        .active_session
        .as_deref()
        .and_then(|a| a.split_once('/').map(|(ws, _)| ws))
        .is_some_and(|ws| ws == name);
    let guard = if active_here { Some(st.busy.lock().await) } else { None };
    if guard.as_ref().is_some_and(|g| g.is_some()) {
        return err_response(
            StatusCode::CONFLICT,
            "turn in progress; rename applies between turns".to_string(),
        );
    }
    let active_old = match &data.active_session {
        Some(active) if active_here => session_dir_for(&data, active).ok().map(|r| r.2),
        _ => None,
    };
    if let Err((code, e)) = st.workspaces.rename_workspace(&name, &new_name) {
        return err_response(code, e);
    }
    if let Some(old_dir) = active_old {
        // activate tail: env -> re-compose -> persist -> swap, with rollback
        let session_part = data
            .active_session
            .as_deref()
            .and_then(|a| a.split_once('/').map(|(_, s)| s.to_string()))
            .unwrap_or_default();
        let Some(new_dir) = old_dir
            .parent()
            .and_then(|ws| ws.parent())
            .map(|p| p.join(&new_name).join(&session_part))
        else {
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot derive the moved session dir".to_string(),
            );
        };
        let pj = {
            let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            profile_to_json(&gen.profile)
        };
        std::env::set_var("CELESTEA_SESSION_DIR", &new_dir);
        let gen = match prepare_gen(pj, None, &st.providers) {
            Ok(g) => g,
            Err(e) => {
                let _ = st.workspaces.rename_workspace(&new_name, &name);
                std::env::set_var("CELESTEA_SESSION_DIR", &old_dir);
                return err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("compose failed: {e}"),
                );
            }
        };
        let new_id = format!("{new_name}/{session_part}");
        if let Err(e) = st.workspaces.set_active(Some(new_id.clone())) {
            let _ = st.workspaces.rename_workspace(&new_name, &name);
            std::env::set_var("CELESTEA_SESSION_DIR", &old_dir);
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot persist active session: {e}"),
            );
        }
        let _ = swap_gen(&st, gen);
    }
    drop(guard);
    (StatusCode::OK, Json(workspaces_view(&st))).into_response()
}

/// POST /api/workspaces/batch-delete {"names":[...]} — per-name
/// deregistration; failures are reported per name, the batch continues.
pub(crate) async fn post_workspaces_batch_delete(
    State(st): State<Shared>,
    Json(req): Json<BatchNamesReq>,
) -> Response {
    let mut deleted = 0usize;
    let mut failed = Vec::new();
    for name in &req.names {
        match st.workspaces.deregister(name) {
            Ok(()) => deleted += 1,
            Err((_, e)) => failed.push(json!({"name": name, "error": e})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "deleted": deleted, "failed": failed})),
    )
        .into_response()
}

// ---- session handlers ----------------------------------------------------------

/// W244: read the optional session meta model ("<dir>/session.json").
/// Missing file / malformed JSON / missing model -> None (tolerant).
pub(crate) fn session_meta(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(SESSION_META)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// W244/W245: write "<dir>/session.json" with the present fields
/// ({"model"?: "<id>", "prompt"?: "<id>"}).
pub(crate) fn write_session_meta(
    dir: &Path,
    model: Option<&str>,
    prompt: Option<&str>,
) -> Result<(), String> {
    let mut m = serde_json::Map::new();
    if let Some(v) = model {
        m.insert("model".to_string(), json!(v));
    }
    if let Some(v) = prompt {
        m.insert("prompt".to_string(), json!(v));
    }
    let text = serde_json::to_string_pretty(&Value::Object(m))
        .map_err(|e| format!("session meta serialize failed: {e}"))?;
    std::fs::write(dir.join(SESSION_META), text.as_bytes())
        .map_err(|e| format!("cannot write '{}': {e}", dir.join(SESSION_META).display()))
}

#[derive(Deserialize)]
pub(crate) struct SessionCreateReq {
    /// Optional: None -> the ACTIVE session's workspace (or the first
    /// registered workspace). The UI's "root" option sends null.
    pub(crate) workspace: Option<String>,
    pub(crate) title: String,
    /// W244: optional model id persisted into "<dir>/session.json".
    #[serde(default)]
    pub(crate) model: Option<String>,
    /// W245: optional prompt id binding (session.json "prompt"); the bound
    /// prompt's section_overrides rank above global/workspace overrides.
    #[serde(default)]
    pub(crate) prompt: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SessionRenameReq {
    pub(crate) new_title: String,
}

#[derive(Deserialize)]
pub(crate) struct SessionBranchReq {
    #[serde(default)]
    pub(crate) title: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct BatchIdsReq {
    pub(crate) ids: Vec<String>,
}

// ---- W239: engine worker sessions (third GET /api/sessions source) -----------

/// W239: strip the "worker:" scheme prefix from a session id. Returns the
/// engine sid ("session-<n>") when the scheme is present, None otherwise —
/// file-backed ids ("<workspace>/<session>") never carry the prefix.
pub(crate) fn worker_sid(id: &str) -> Option<&str> {
    id.strip_prefix("worker:")
}

/// W239: render one engine worker session into the GET /api/sessions entry
/// contract: id "worker:<sid>", pseudo-workspace "engine" (the frontend
/// groups worker entries by `kind`), size = event count of the worker's
/// in-memory log, modified 0 / active false (in-memory lifecycle — a worker
/// session dies with the engine process).
fn render_worker_entry(
    id: &str,
    title: &str,
    model: Option<&str>,
    size: usize,
) -> Value {
    json!({
        "id": format!("worker:{id}"),
        "workspace": "engine",
        "kind": "worker",
        "title": title,
        "model": model,
        "size": size,
        "modified": 0,
        "active": false,
    })
}

/// W239: list the engine's worker sessions (the in-memory SessionRegistry
/// behind gen.runtime.workers.sessions() — spawn_worker products) as
/// /api/sessions entries. The compose-time "cli-main" shadow registration
/// (WORKER_HOST_SHADOW_SID / HOST_SID) is skipped — the host conversation is
/// already listed from its workspace directory, and the shadow's log is
/// empty anyway.
fn worker_session_entries(workers: &celestea_runtime::WorkerRegistry) -> Vec<Value> {
    let sessions = workers.sessions();
    sessions
        .list()
        .into_iter()
        .filter(|m| m.id != WORKER_HOST_SHADOW_SID)
        .map(|m| {
            let size = sessions
                .get(&m.id)
                .map(|s| s.log.events().len())
                .unwrap_or(0);
            render_worker_entry(&m.id, &m.title, m.model.as_deref(), size)
        })
        .collect()
}

/// GET /api/sessions — every session dir across ALL registered workspaces,
/// plus the engine's in-memory worker sessions (W239; the "cli-main" shadow
/// registration is never listed):
/// {"sessions":[{"id":"<ws>/<session>"|"worker:<sid>","workspace","title",
/// "size","modified","active","kind"?}],"active_session":...}.
/// `.celestea-*` and other dot-dirs are never scanned.
pub(crate) async fn get_sessions(State(st): State<Shared>) -> Json<Value> {
    let data = st.workspaces.snapshot();
    let mut sessions: Vec<Value> = Vec::new();
    for w in &data.workspaces {
        let ws_path = Path::new(&w.path);
        scan_session_dirs(ws_path, |name, dir, file| {
            let (size, modified) = std::fs::metadata(file)
                .map(|m| {
                    (
                        m.len(),
                        m.modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    )
                })
                .unwrap_or((0, 0));
            let ws_name = workspace_basename(&w.path).unwrap_or_default();
            let id = format!("{}/{}", ws_name, name);
            sessions.push(json!({
                "id": id,
                "workspace": ws_name,
                "title": name,
                "model": session_meta(dir),
                "size": size,
                "modified": modified,
                "active": data.active_session.as_deref() == Some(id.as_str()),
            }));
        });
    }
    // W239: third source — engine worker sessions from the in-memory
    // SessionRegistry of the CURRENT generation (worker sessions are
    // per-compose; a hot swap starts a fresh registry).
    {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        sessions.extend(worker_session_entries(&gen.runtime.workers));
    }
    sessions.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Json(json!({"sessions": sessions, "active_session": data.active_session}))
}

/// POST /api/sessions {"workspace","title"} — create the session directory
/// "<sanitized title>-<ts>" (collision counter) with an empty cli-main.jsonl
/// inside the registered workspace. Response {"ok":true,"id":"<ws>/<dir>"}.
pub(crate) async fn post_session_create(
    State(st): State<Shared>,
    Json(req): Json<SessionCreateReq>,
) -> Response {
    let data = st.workspaces.snapshot();
    let ws_name = match req.workspace.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => w.to_string(),
        None => data
            .active_session
            .as_deref()
            .and_then(|id| id.split('/').next())
            .map(str::to_string)
            .or_else(|| {
                data.workspaces
                    .first()
                    .and_then(|w| workspace_basename(&w.path))
            })
            .unwrap_or_default(),
    };
    let Some(ws) = data
        .workspaces
        .iter()
        .find(|w| workspace_basename(&w.path).as_deref() == Some(ws_name.as_str()))
    else {
        return err_response(StatusCode::NOT_FOUND, format!("unknown workspace '{ws_name}'"));
    };
    if let Some(m) = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        if let Err(e) = crate::api::validate_model_name(m) {
            return err_response(StatusCode::BAD_REQUEST, format!("invalid model: {e}"));
        }
    }
    if let Some(p) = req.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        if let Err(e) = crate::prompts::validate_prompt_id(p) {
            return err_response(StatusCode::BAD_REQUEST, format!("invalid prompt: {e}"));
        }
    }
    let base = sanitize_component(req.title.trim());
    if base.is_empty() || base == "." || base == ".." {
        return err_response(StatusCode::BAD_REQUEST, "title must not be empty".to_string());
    }
    if base.starts_with('.') {
        return err_response(
            StatusCode::BAD_REQUEST,
            format!("title '{}' sanitizes to the hidden name '{base}'", req.title.trim()),
        );
    }
    let ws_path = PathBuf::from(&ws.path);
    if !ws_path.is_dir() {
        return err_response(
            StatusCode::NOT_FOUND,
            format!("workspace path '{}' is not accessible", ws.path),
        );
    }
    let mut name = format!("{base}-{}", now_ts());
    let mut n = 0u32;
    let dir = loop {
        let candidate = ws_path.join(&name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        name = format!("{base}-{}-{n}", now_ts());
    };
    if let Err(e) = std::fs::create_dir(&dir) {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("create failed: {e}"));
    }
    if let Err(e) = std::fs::File::create(dir.join(SESSION_FILE)) {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("create failed: {e}"));
    }
    {
        let model = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let prompt = req.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty());
        if model.is_some() || prompt.is_some() {
            if let Err(e) = write_session_meta(&dir, model, prompt) {
                let _ = std::fs::remove_dir_all(&dir);
                return err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("meta write failed: {e}"),
                );
            }
        }
    }
    let id = format!("{}/{}", workspace_basename(&ws.path).unwrap_or_default(), name);
    (StatusCode::OK, Json(json!({"ok": true, "id": id}))).into_response()
}

/// W243 core: rename the session DIRECTORY for a new title. The title is
/// sanitized (CJK kept; separators/whitespace -> '_'), hidden/empty/dot names
/// rejected, and a collision with an existing sibling gets a "-n" suffix
/// (auto, like the create endpoint). Renaming onto the current name is a
/// no-op. Returns (workspace, old name, new name, new dir).
pub(crate) fn rename_session_dir(
    data: &RegistryData,
    id: &str,
    new_title: &str,
) -> Result<(String, String, String, PathBuf), (StatusCode, String)> {
    let (ws, old_name, dir) = session_dir_for(data, id)?;
    let base = sanitize_component(new_title.trim());
    if base.is_empty() || base == "." || base == ".." {
        return Err((StatusCode::BAD_REQUEST, "new title must not be empty".to_string()));
    }
    if base.starts_with('.') {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("title '{}' sanitizes to the hidden name '{base}'", new_title.trim()),
        ));
    }
    if base == old_name {
        return Ok((ws, old_name.clone(), old_name, dir)); // same name -> no-op
    }
    let parent = dir.parent().expect("session dir sits directly under the workspace path");
    let mut name = base.clone();
    let mut n = 0u32;
    let new_dir = loop {
        let candidate = parent.join(&name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        name = format!("{base}-{n}");
    };
    std::fs::rename(&dir, &new_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
    Ok((ws, old_name, name, new_dir))
}

/// W243 core: copy a session's cli-main.jsonl into a fresh sibling session
/// dir. The title defaults to "<源名>-分支"; it is sanitized (CJK kept) and
/// the dir name gets the create-style "<base>-<ts>" (collision counter)
/// suffix. Returns (workspace, new dir name, new dir); never activates.
pub(crate) fn branch_session_dir(
    data: &RegistryData,
    id: &str,
    title: Option<&str>,
) -> Result<(String, String, PathBuf), (StatusCode, String)> {
    let (ws, src_name, dir) = session_dir_for(data, id)?;
    let base = match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => sanitize_component(t),
        None => format!("{src_name}-分支"),
    };
    if base.is_empty() || base == "." || base == ".." {
        return Err((StatusCode::BAD_REQUEST, "title must not be empty".to_string()));
    }
    if base.starts_with('.') {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("title sanitizes to the hidden name '{base}'"),
        ));
    }
    let parent = dir.parent().expect("session dir sits directly under the workspace path");
    let mut name = format!("{base}-{}", now_ts());
    let mut n = 0u32;
    let new_dir = loop {
        let candidate = parent.join(&name);
        if !candidate.exists() {
            break candidate;
        }
        n += 1;
        name = format!("{base}-{}-{n}", now_ts());
    };
    std::fs::create_dir(&new_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("create failed: {e}")))?;
    if let Err(e) = std::fs::copy(dir.join(SESSION_FILE), new_dir.join(SESSION_FILE)) {
        let _ = std::fs::remove_dir_all(&new_dir);
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("copy failed: {e}")));
    }
    // W244: the optional meta file travels with the branch too.
    if dir.join(SESSION_META).is_file() {
        if let Err(e) = std::fs::copy(dir.join(SESSION_META), new_dir.join(SESSION_META)) {
            let _ = std::fs::remove_dir_all(&new_dir);
            return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("meta copy failed: {e}")));
        }
    }
    Ok((ws, name, new_dir))
}

/// POST /api/sessions/{id}/activate — switch the engine generation onto the
/// session directory:
///   1. refuse while a turn runs (409) — a swap mid-turn could lose events;
///   2. resolve "<ws>/<session>" (sanitized, traversal-safe) and require the
///      dir + cli-main.jsonl;
///   3. set CELESTEA_SESSION_DIR to the session dir and re-compose the
///      engine generation (the same prepare/swap tail as post_config; the
///      compose replays cli-main.jsonl through PersistentSessionLog);
///   4. persist active_session (atomic), then swap the generation.
/// Response {"ok":true,"active_session":"<ws>/<session>"}.
pub(crate) async fn post_session_activate(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> Response {
    let guard = st.busy.lock().await;
    if guard.is_some() {
        return err_response(
            StatusCode::CONFLICT,
            "turn in progress; activate applies between turns".to_string(),
        );
    }
    let (ws_name, name, dir) = match session_dir_for(&st.workspaces.snapshot(), &id) {
        Ok(v) => v,
        Err((code, e)) => return err_response(code, e),
    };
    // Re-compose onto the CURRENT profile (api key stays in the process env;
    // CELESTEA_SESSION_DIR is read at compose time, so the new generation
    // replays the target session's cli-main.jsonl). W244: a session.json
    // {"model"} rides the same post_config/prepare_gen hot-apply path — the
    // merged profile override is validated, then composed + swapped.
    let mut pj = {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        profile_to_json(&gen.profile)
    };
    if let Some(m) = session_meta(&dir) {
        if let Err(e) = crate::api::validate_model_name(&m) {
            return err_response(StatusCode::BAD_REQUEST, format!("invalid session model: {e}"));
        }
        pj["model"] = json!(m);
    }
    std::env::set_var("CELESTEA_SESSION_DIR", &dir);
    let gen = match prepare_gen(pj, None, &st.providers) {
        Ok(g) => g,
        Err(e) => {
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("compose failed: {e}"))
        }
    };
    let canonical = format!("{ws_name}/{name}");
    if let Err(e) = st.workspaces.set_active(Some(canonical.clone())) {
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot persist active session: {e}"),
        );
    }
    let _ = swap_gen(&st, gen);
    drop(guard);
    (
        StatusCode::OK,
        Json(json!({"ok": true, "active_session": canonical})),
    )
        .into_response()
}

/// POST /api/sessions/{id}/rename {"new_title"} — rename the session
/// directory (sanitize keeps CJK; collisions auto-get a "-n" suffix).
/// Renaming the ACTIVE session follows the activate implementation path:
/// busy 409 while a turn runs, then CELESTEA_SESSION_DIR -> re-compose ->
/// persist active_session -> swap (a failed compose/persist rolls the
/// directory move back). Response {"ok":true,"id":"<ws>/<new dir>"}.
pub(crate) async fn post_session_rename(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
    Json(req): Json<SessionRenameReq>,
) -> Response {
    let data = st.workspaces.snapshot();
    let is_active = data.active_session.as_deref() == Some(id.trim());
    let guard = if is_active { Some(st.busy.lock().await) } else { None };
    if guard.as_ref().is_some_and(|g| g.is_some()) {
        return err_response(
            StatusCode::CONFLICT,
            "turn in progress; rename applies between turns".to_string(),
        );
    }
    let (ws, old_name, new_name, new_dir) =
        match rename_session_dir(&data, &id, &req.new_title) {
            Ok(v) => v,
            Err((code, e)) => return err_response(code, e),
        };
    let new_id = format!("{ws}/{new_name}");
    if is_active && new_name != old_name {
        // activate tail: re-point CELESTEA_SESSION_DIR at the renamed dir and
        // re-compose (the compose replays the new dir's cli-main.jsonl).
        let pj = {
            let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
            profile_to_json(&gen.profile)
        };
        let old_dir = new_dir.parent().expect("session dir has a parent").join(&old_name);
        std::env::set_var("CELESTEA_SESSION_DIR", &new_dir);
        let gen = match prepare_gen(pj, None, &st.providers) {
            Ok(g) => g,
            Err(e) => {
                let _ = std::fs::rename(&new_dir, &old_dir); // roll the move back
                std::env::set_var("CELESTEA_SESSION_DIR", &old_dir);
                return err_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("compose failed: {e}"),
                );
            }
        };
        if let Err(e) = st.workspaces.set_active(Some(new_id.clone())) {
            let _ = std::fs::rename(&new_dir, &old_dir);
            std::env::set_var("CELESTEA_SESSION_DIR", &old_dir);
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot persist active session: {e}"),
            );
        }
        let _ = swap_gen(&st, gen);
    }
    drop(guard);
    (StatusCode::OK, Json(json!({"ok": true, "id": new_id}))).into_response()
}

/// POST /api/sessions/{id}/branch {"title"?} — copy the session's
/// cli-main.jsonl into a fresh sibling session dir (title defaults to
/// "<源名>-分支"; timestamped name). The branch is NOT activated.
/// Response {"ok":true,"id":"<ws>/<new dir>"}.
pub(crate) async fn post_session_branch(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
    Json(req): Json<SessionBranchReq>,
) -> Response {
    let data = st.workspaces.snapshot();
    match branch_session_dir(&data, &id, req.title.as_deref()) {
        Ok((ws, name, _dir)) => (
            StatusCode::OK,
            Json(json!({"ok": true, "id": format!("{ws}/{name}")})),
        )
            .into_response(),
        Err((code, e)) => err_response(code, e),
    }
}

/// GET /api/sessions/{id}/messages — read-only transcript of the session's
/// cli-main.jsonl (engine SessionEvent JSONL; a torn tail is dropped).
/// Response {"ok":true,"session":"<id>","messages":[{"role","content"},...]}
pub(crate) async fn get_session_messages(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> Response {
    // W239: "worker:<sid>" ids address the engine's in-memory worker
    // SessionRegistry (spawn_worker products), not a workspace directory.
    if let Some(sid) = worker_sid(&id) {
        let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
        let Some(session) = gen.runtime.workers.sessions().get(sid) else {
            return err_response(StatusCode::NOT_FOUND, format!("unknown session '{id}'"));
        };
        let messages: Vec<Value> = session
            .log
            .events()
            .iter()
            .filter_map(crate::api::session_event_to_message)
            .collect();
        return (
            StatusCode::OK,
            Json(json!({"ok": true, "session": id, "messages": messages})),
        )
            .into_response();
    }
    let data = st.workspaces.snapshot();
    let (_ws, _name, dir) = match session_dir_for(&data, &id) {
        Ok(v) => v,
        Err((code, e)) => return err_response(code, e),
    };
    let text = match std::fs::read_to_string(dir.join(SESSION_FILE)) {
        Ok(t) => t,
        Err(_) => return err_response(StatusCode::NOT_FOUND, "unknown session".to_string()),
    };
    let events = crate::api::parse_session_jsonl(&text);
    let messages: Vec<Value> = events
        .iter()
        .filter_map(crate::api::session_event_to_message)
        .collect();
    (
        StatusCode::OK,
        Json(json!({"ok": true, "session": id, "messages": messages})),
    )
        .into_response()
}

/// POST /api/clear — clear the ACTIVE session: SessionLog::clear (a
/// PersistentSessionLog truncates its cli-main.jsonl) + report which session
/// was cleared. {"ok":true,"cleared":true,"session":"<active>"|null}
pub(crate) async fn post_clear(State(st): State<Shared>) -> Json<Value> {
    let active = st.workspaces.active_session();
    let gen = st.gen.read().unwrap_or_else(|p| p.into_inner());
    gen.runtime.session.clear();
    Json(json!({"ok": true, "cleared": true, "session": active}))
}

// ---- session moves (archive / trash) -------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum MoveOp {
    Archive,
    Unarchive,
    Trash,
}

/// Core session-dir move (the active session is always refused with 400):
///   Archive   -> <ws-path>/.celestea-archived/<name>  (409 when already there)
///   Unarchive -> back to <ws-path>/<name>            (409 when a live one exists)
///   Trash     -> <ws-path>/.celestea-trash/<name>-<ts> (collision-safe)
pub(crate) fn move_session_dir(
    data: &RegistryData,
    id: &str,
    op: MoveOp,
) -> Result<(), (StatusCode, String)> {
    let (_ws, name, dir) = resolve_session_dir(data, id)?;
    if op != MoveOp::Unarchive && data.active_session.as_deref() == Some(id.trim()) {
        let verb = if op == MoveOp::Trash { "deleted" } else { "archived" };
        return Err((StatusCode::BAD_REQUEST, format!("active session '{id}' cannot be {verb}")));
    }
    let parent = dir.parent().expect("session dir sits directly under the workspace path");
    match op {
        MoveOp::Archive => {
            if !dir.is_dir() || !dir.join(SESSION_FILE).is_file() {
                return Err((StatusCode::NOT_FOUND, format!("unknown session '{id}'")));
            }
            let dst = parent.join(ARCHIVED_DIR).join(&name);
            if dst.exists() {
                return Err((StatusCode::CONFLICT, format!("session '{id}' is already archived")));
            }
            std::fs::create_dir_all(dst.parent().expect("archived dir has a parent"))
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir failed: {e}")))?;
            std::fs::rename(&dir, &dst)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
        }
        MoveOp::Unarchive => {
            let src = parent.join(ARCHIVED_DIR).join(&name);
            if !src.is_dir() {
                return Err((StatusCode::NOT_FOUND, format!("session '{id}' is not archived")));
            }
            if dir.exists() {
                return Err((
                    StatusCode::CONFLICT,
                    format!("a live session already exists at '{id}'"),
                ));
            }
            std::fs::rename(&src, &dir)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
        }
        MoveOp::Trash => {
            if !dir.is_dir() || !dir.join(SESSION_FILE).is_file() {
                return Err((StatusCode::NOT_FOUND, format!("unknown session '{id}'")));
            }
            let dst = parent.join(TRASH_DIR).join(format!("{name}-{}", now_ts()));
            std::fs::create_dir_all(dst.parent().expect("trash dir has a parent"))
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("mkdir failed: {e}")))?;
            std::fs::rename(&dir, &dst)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("move failed: {e}")))?;
        }
    }
    Ok(())
}

/// POST /api/sessions/{id}/archive
pub(crate) async fn post_session_archive(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> Response {
    let data = st.workspaces.snapshot();
    match move_session_dir(&data, &id, MoveOp::Archive) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err((code, e)) => err_response(code, e),
    }
}

/// POST /api/sessions/{id}/unarchive
pub(crate) async fn post_session_unarchive(
    State(st): State<Shared>,
    AxPath(id): AxPath<String>,
) -> Response {
    let data = st.workspaces.snapshot();
    match move_session_dir(&data, &id, MoveOp::Unarchive) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err((code, e)) => err_response(code, e),
    }
}

/// POST /api/sessions/batch-archive {"ids":[...]} — per-id archive; failures
/// (incl. the active session) land in "failed", the batch continues.
pub(crate) async fn post_sessions_batch_archive(
    State(st): State<Shared>,
    Json(req): Json<BatchIdsReq>,
) -> Response {
    let data = st.workspaces.snapshot();
    let mut archived = 0usize;
    let mut failed = Vec::new();
    for id in &req.ids {
        match move_session_dir(&data, id, MoveOp::Archive) {
            Ok(()) => archived += 1,
            Err((_, msg)) => failed.push(json!({"id": id, "error": msg})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "archived": archived, "failed": failed})),
    )
        .into_response()
}

/// POST /api/sessions/batch-delete {"ids":[...]} — per-id move to
/// .celestea-trash (recoverable on disk); the active session is refused.
pub(crate) async fn post_sessions_batch_delete(
    State(st): State<Shared>,
    Json(req): Json<BatchIdsReq>,
) -> Response {
    let data = st.workspaces.snapshot();
    let mut deleted = 0usize;
    let mut failed = Vec::new();
    for id in &req.ids {
        match move_session_dir(&data, id, MoveOp::Trash) {
            Ok(()) => deleted += 1,
            Err((_, msg)) => failed.push(json!({"id": id, "error": msg})),
        }
    }
    (
        StatusCode::OK,
        Json(json!({"ok": true, "deleted": deleted, "failed": failed})),
    )
        .into_response()
}

// ---- tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use celestea_runtime::{SessionEvent, SessionLog, WorkerRegistry};
    use celestea_session::{Session, SessionMeta, SessionSpec};

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "celestea-studio-w237-{}-{}-{}",
            std::process::id(),
            name,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn user_line(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::to_string(&SessionEvent::UserMessage { text: text.to_string() }).unwrap()
        )
    }

    fn user_texts(log: &std::sync::Arc<dyn celestea_core::SessionLog>) -> Vec<String> {
        log.events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn workspace_name_sanitizes_keeps_cjk_and_rejects_bare_dots() {
        assert_eq!(validate_workspace_name("my ws").unwrap(), "my_ws");
        assert_eq!(validate_workspace_name("a/b\\c").unwrap(), "a_b_c");
        assert_eq!(validate_workspace_name("团队 A").unwrap(), "团队_A");
        assert!(validate_workspace_name("").is_err());
        assert!(validate_workspace_name("   ").is_err());
        assert!(validate_workspace_name(".").is_err());
        assert!(validate_workspace_name("..").is_err());
        assert_eq!(sanitize_component("Hello 世界"), "Hello_世界");
    }

    #[test]
    fn resolve_session_dir_is_traversal_safe() {
        let mut data = RegistryData::default();
        data.workspaces.push(Workspace { path: "/tmp/fake-ws".into() });
        // W244: the workspace key is the folder basename ("fake-ws")
        let (ws, name, dir) = resolve_session_dir(&data, "fake-ws/s1").unwrap();
        assert_eq!(ws, "fake-ws");
        assert_eq!(name, "s1");
        assert_eq!(dir, PathBuf::from("/tmp/fake-ws/s1"));
        // separators/whitespace sanitized; CJK kept
        let (_, n, d) = resolve_session_dir(&data, "fake-ws/x y").unwrap();
        assert_eq!(n, "x_y");
        assert_eq!(d, PathBuf::from("/tmp/fake-ws/x_y"));
        // invalid ids: multi-slash, empties, absolute, hidden names, dots
        for bad in [
            "fake-ws/../evil",
            "fake-ws//x",
            "fake-ws/a/b",
            "fake-ws/",
            "/abs",
            "solo",
            "",
            "   ",
            "fake-ws/.",
            "fake-ws/..",
            "fake-ws/.hidden",
            "B/s1",
        ] {
            assert!(
                resolve_session_dir(&data, bad).is_err(),
                "{bad:?} should not resolve"
            );
        }
    }

    #[test]
    fn legacy_migration_is_idempotent() {
        let dir = scratch("migrate");
        let root = dir.join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        // legacy layout: host file + loose root file + workspace subdir with
        // two files + a legacy hidden dir (never migrated)
        std::fs::write(root.join("cli-main.jsonl"), user_line("host")).unwrap();
        std::fs::write(root.join("loose.jsonl"), user_line("loose")).unwrap();
        let old_ws = root.join("old-ws");
        std::fs::create_dir_all(&old_ws).unwrap();
        std::fs::write(old_ws.join("a.jsonl"), user_line("a")).unwrap();
        std::fs::write(old_ws.join("b.jsonl"), user_line("b")).unwrap();
        let hidden = root.join(".trash");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("junk.jsonl"), "x\n").unwrap();

        let reg_path = dir.join("workspaces.json");
        let reg = load_registry(reg_path.clone(), &root).unwrap();
        let snap = reg.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert_eq!(snap.workspaces[0].path, root.display().to_string());
        assert_eq!(
            workspace_basename(&snap.workspaces[0].path).as_deref(),
            Some("sessions"),
            "v2 key = folder basename"
        );
        assert_eq!(snap.active_session.as_deref(), Some("sessions/cli-main"));

        // every legacy file became <stem>/cli-main.jsonl
        assert!(root.join("cli-main/cli-main.jsonl").is_file());
        assert!(root.join("loose/cli-main.jsonl").is_file());
        assert!(old_ws.join("a/cli-main.jsonl").is_file());
        assert!(old_ws.join("b/cli-main.jsonl").is_file());
        assert!(!root.join("cli-main.jsonl").exists());
        assert!(!root.join("loose.jsonl").exists());
        assert!(!old_ws.join("a.jsonl").exists());
        assert!(!old_ws.join("b.jsonl").exists());
        assert!(hidden.join("junk.jsonl").is_file(), "legacy hidden dir untouched");
        assert!(std::fs::read_to_string(root.join("cli-main/cli-main.jsonl"))
            .unwrap()
            .contains("host"));

        // second load: registry exists -> no re-migration, same state
        let reg2 = load_registry(reg_path, &root).unwrap();
        let snap2 = reg2.snapshot();
        assert_eq!(snap2.workspaces.len(), 1);
        assert_eq!(snap2.active_session, snap.active_session);
        assert!(
            !root.join("cli-main/cli-main/cli-main.jsonl").exists(),
            "no double migration"
        );
        // a forced re-walk of the migration is a no-op too
        assert_eq!(migrate_legacy_layout(&root).unwrap(), 0);
        assert!(!root.join("cli-main/cli-main/cli-main.jsonl").exists());
        assert!(root.join("cli-main/cli-main.jsonl").is_file());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_registry_migrates_to_basename_keys_idempotently() {
        let dir = scratch("v1migrate");
        let ws = dir.join("数据区");
        std::fs::create_dir_all(ws.join("cli-main")).unwrap();
        std::fs::write(ws.join("cli-main/cli-main.jsonl"), user_line("v1")).unwrap();
        let reg_path = dir.join("workspaces.json");
        // v1 on disk: free-form "name" + name-based active id
        std::fs::write(
            &reg_path,
            format!(
                "{{\"workspaces\":[{{\"name\":\"默认\",\"path\":\"{}\"}}],\"active_session\":\"默认/cli-main\"}}",
                ws.display()
            ),
        )
        .unwrap();

        let reg = load_registry(reg_path.clone(), &dir.join("sessions")).unwrap();
        let snap = reg.snapshot();
        assert_eq!(snap.workspaces.len(), 1);
        assert_eq!(snap.workspaces[0].path, ws.display().to_string());
        assert_eq!(
            workspace_basename(&snap.workspaces[0].path).as_deref(),
            Some("数据区"),
            "workspace key = folder basename"
        );
        assert_eq!(
            snap.active_session.as_deref(),
            Some("数据区/cli-main"),
            "active ws segment rewritten to the basename"
        );

        // the file was rewritten to v2: no "name" fields, active re-keyed
        let text = std::fs::read_to_string(&reg_path).unwrap();
        assert!(!text.contains("\"name\""), "v1 name dropped: {text}");
        assert!(text.contains("数据区/cli-main"));
        let before = text;

        // idempotent: a second load leaves the file byte-identical
        let _reg2 = load_registry(reg_path.clone(), &dir.join("sessions")).unwrap();
        let after = std::fs::read_to_string(&reg_path).unwrap();
        assert_eq!(before, after, "re-load must not rewrite");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_register_deregister_only_deregisters() {
        let dir = scratch("regdereg");
        let user_folder = dir.join("user-folder");
        std::fs::create_dir_all(&user_folder).unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();

        // sanitize helper still drives folder renames (CJK kept)
        let name = validate_workspace_name("项目 A").unwrap();
        assert_eq!(name, "项目_A");

        // W244: register by path — the key is the folder basename
        let base = reg.register(&user_folder.display().to_string()).unwrap();
        assert_eq!(base, "user-folder");
        assert!(reg.snapshot().workspaces.iter().any(|w| {
            workspace_basename(&w.path).as_deref() == Some("user-folder")
        }));

        // duplicate path -> 409
        let err = reg.register(&user_folder.display().to_string()).unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        // same basename, DIFFERENT path -> 409 (hint: rename one folder)
        let twin = dir.join("elsewhere");
        std::fs::create_dir_all(twin.join("user-folder")).unwrap();
        let err = reg
            .register(&twin.join("user-folder").display().to_string())
            .unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert!(err.1.contains("rename one folder"), "conflict hints at the fix: {err:?}");

        // deregister: registry entry gone, the USER FOLDER is untouched
        reg.deregister("user-folder").unwrap();
        assert!(user_folder.is_dir());
        assert!(!reg.snapshot().workspaces.iter().any(|w| {
            workspace_basename(&w.path).as_deref() == Some("user-folder")
        }));
        // the migrated default workspace survives, and unknown keys -> 404
        assert!(reg.snapshot().workspaces.iter().any(|w| {
            workspace_basename(&w.path).as_deref() == Some("sessions")
        }));
        let err = reg.deregister("不存在").unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);

        // deregistering the active session's workspace clears the dangling id
        reg.register(&user_folder.display().to_string()).unwrap();
        std::fs::create_dir_all(user_folder.join("s1")).unwrap();
        std::fs::write(user_folder.join("s1/cli-main.jsonl"), "x\n").unwrap();
        reg.set_active(Some("user-folder/s1".to_string())).unwrap();
        reg.deregister("user-folder").unwrap();
        assert_eq!(reg.snapshot().active_session, None);
        // reloaded from disk: the cleared active session persisted
        let reloaded = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        assert_eq!(reloaded.snapshot().active_session, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn activate_switch_replays_session_dir() {
        // The env vars below are process-global: serialize with the other
        // test that composes the engine (providers default hot-apply test).
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("switch");
        let ws_a = dir.join("ws-a");
        let ws_b = dir.join("ws-b");
        let a_sess = ws_a.join("alpha");
        let b_sess = ws_b.join("beta");
        for d in [&ws_a, &ws_b, &a_sess, &b_sess] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(a_sess.join(SESSION_FILE), user_line("from-alpha")).unwrap();
        std::fs::write(b_sess.join(SESSION_FILE), user_line("from-beta")).unwrap();

        let reg_path = dir.join("workspaces.json");
        let reg = load_registry(reg_path.clone(), &dir.join("sessions")).unwrap();
        reg.register(&ws_a.display().to_string()).unwrap();
        reg.register(&ws_b.display().to_string()).unwrap();

        // A dedicated key env name: never touch DEEPSEEK_API_KEY (it may be
        // legitimately set for the real instance).
        std::env::set_var("W237_REPLAY_KEY", "test-key");
        let profile = celestea_runtime::merge_profile(&json!({
            "model": "deepseek-v4-flash-0731",
            "api_key_env": "W237_REPLAY_KEY",
        }))
        .expect("lenient merge");

        let store = crate::providers::ProvidersStore::empty();
        // activate A (the handler tail: resolve -> env -> recompose -> persist)
        let (_id_a, _name_a, dir_a) = session_dir_for(&reg.snapshot(), "ws-a/alpha").unwrap();
        assert_eq!(dir_a, a_sess);
        std::env::set_var("CELESTEA_SESSION_DIR", &dir_a);
        reg.set_active(Some("ws-a/alpha".to_string())).unwrap();
        let gen_a = crate::build_gen(profile.clone(), &store).unwrap();
        assert_eq!(user_texts(&gen_a.runtime.session), vec!["from-alpha".to_string()]);

        // switch to B -> the compose replays B's history
        let (_id_b, _name_b, dir_b) = session_dir_for(&reg.snapshot(), "ws-b/beta").unwrap();
        std::env::set_var("CELESTEA_SESSION_DIR", &dir_b);
        reg.set_active(Some("ws-b/beta".to_string())).unwrap();
        let gen_b = crate::build_gen(profile.clone(), &store).unwrap();
        assert_eq!(user_texts(&gen_b.runtime.session), vec!["from-beta".to_string()]);

        // the registry persisted the switch (reload from disk)
        let reloaded = load_registry(reg_path, &dir.join("sessions")).unwrap();
        assert_eq!(reloaded.snapshot().active_session.as_deref(), Some("ws-b/beta"));

        // switch BACK to A -> its history is intact again
        let (_id_a, _name_a, dir_a) = session_dir_for(&reloaded.snapshot(), "ws-a/alpha").unwrap();
        std::env::set_var("CELESTEA_SESSION_DIR", &dir_a);
        reloaded.set_active(Some("ws-a/alpha".to_string())).unwrap();
        let gen_a2 = crate::build_gen(profile, &store).unwrap();
        assert_eq!(user_texts(&gen_a2.runtime.session), vec!["from-alpha".to_string()]);

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W237_REPLAY_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_rename_moves_dir_and_resolves_collisions() {
        let dir = scratch("rename");
        let ws_path = dir.join("ws");
        std::fs::create_dir_all(ws_path.join("alpha")).unwrap();
        std::fs::write(ws_path.join("alpha").join(SESSION_FILE), user_line("from-alpha")).unwrap();
        // pre-existing sibling that collides with the requested title
        std::fs::create_dir_all(ws_path.join("beta")).unwrap();
        std::fs::write(ws_path.join("beta").join(SESSION_FILE), user_line("junk")).unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        reg.register(&ws_path.display().to_string()).unwrap();

        // CJK kept, whitespace sanitized: "新 名称" -> "新_名称"; old dir gone
        let (ws, old, new, new_dir) =
            rename_session_dir(&reg.snapshot(), "ws/alpha", "新 名称").unwrap();
        assert_eq!(ws, "ws");
        assert_eq!(old, "alpha");
        assert_eq!(new, "新_名称");
        assert!(new_dir.is_dir() && new_dir.join(SESSION_FILE).is_file());
        assert!(!ws_path.join("alpha").exists(), "old dir moved away");
        assert!(std::fs::read_to_string(new_dir.join(SESSION_FILE))
            .unwrap()
            .contains("from-alpha"));

        // rename onto an existing sibling -> auto "-1" suffix, sibling untouched
        let (_, _, n2, _) = rename_session_dir(&reg.snapshot(), "ws/新_名称", "beta").unwrap();
        assert_eq!(n2, "beta-1");
        assert!(std::fs::read_to_string(ws_path.join("beta/cli-main.jsonl"))
            .unwrap()
            .contains("junk"));

        // renaming onto the current name is a no-op
        let (_, _, n3, d3) = rename_session_dir(&reg.snapshot(), "ws/beta-1", "beta-1").unwrap();
        assert_eq!(n3, "beta-1");
        assert_eq!(d3, ws_path.join("beta-1"));

        // bad titles / unknown sessions rejected
        assert!(rename_session_dir(&reg.snapshot(), "ws/beta", "   ").is_err());
        assert!(rename_session_dir(&reg.snapshot(), "ws/beta", ".hidden").is_err());
        assert!(rename_session_dir(&reg.snapshot(), "ws/missing", "x").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_active_session_recomposes_and_updates_registry() {
        // Composes the engine (process-global CELESTEA_SESSION_DIR): serialize
        // with the other compose tests.
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("rename-active");
        let ws_path = dir.join("ws");
        let sess = ws_path.join("alpha");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join(SESSION_FILE), user_line("from-alpha")).unwrap();
        let reg_path = dir.join("workspaces.json");
        let reg = load_registry(reg_path.clone(), &dir.join("sessions")).unwrap();
        reg.register(&ws_path.display().to_string()).unwrap();

        std::env::set_var("W237_REPLAY_KEY", "test-key");
        let profile = celestea_runtime::merge_profile(&json!({
            "model": "deepseek-v4-flash-0731",
            "api_key_env": "W237_REPLAY_KEY",
        }))
        .expect("lenient merge");

        let store = crate::providers::ProvidersStore::empty();
        // initial activation state (the activate tail: env -> recompose -> persist)
        std::env::set_var("CELESTEA_SESSION_DIR", &sess);
        reg.set_active(Some("ws/alpha".to_string())).unwrap();
        let gen_a = crate::build_gen(profile.clone(), &store).unwrap();
        assert_eq!(user_texts(&gen_a.runtime.session), vec!["from-alpha".to_string()]);

        // rename the ACTIVE session (the handler tail: rename -> env ->
        // recompose -> persist) — CJK title kept verbatim
        let (ws, old, new, new_dir) =
            rename_session_dir(&reg.snapshot(), "ws/alpha", "重命名").unwrap();
        assert_eq!((ws.as_str(), old.as_str(), new.as_str()), ("ws", "alpha", "重命名"));
        std::env::set_var("CELESTEA_SESSION_DIR", &new_dir);
        reg.set_active(Some(format!("{ws}/{new}"))).unwrap();
        let gen_b = crate::build_gen(profile, &store).unwrap();
        // the re-composed generation replays the RENAMED dir's history
        assert_eq!(user_texts(&gen_b.runtime.session), vec!["from-alpha".to_string()]);

        // path + registry assertions: env points at the new dir, the registry
        // persisted the new active id, and the old dir is gone
        assert_eq!(
            std::env::var("CELESTEA_SESSION_DIR").unwrap(),
            new_dir.display().to_string()
        );
        let reloaded = load_registry(reg_path, &dir.join("sessions")).unwrap();
        assert_eq!(reloaded.snapshot().active_session.as_deref(), Some("ws/重命名"));
        assert!(new_dir.join(SESSION_FILE).is_file());
        assert!(!sess.exists(), "old session dir moved away");

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W237_REPLAY_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_meta_roundtrip_and_activate_applies_model() {
        // process-global env: serialize with the other compose tests
        let _lock = crate::COMPOSE_ENV_LOCK.lock().unwrap();
        let dir = scratch("meta");
        let ws_path = dir.join("ws");
        let sess = ws_path.join("alpha");
        let other = ws_path.join("beta");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(sess.join(SESSION_FILE), user_line("meta hello")).unwrap();
        std::fs::write(other.join(SESSION_FILE), "x\n").unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        reg.register(&ws_path.display().to_string()).unwrap();

        // write -> read roundtrip; absent file -> None; malformed -> None
        write_session_meta(&sess, Some("test-model-x"), None).unwrap();
        assert_eq!(session_meta(&sess).as_deref(), Some("test-model-x"));
        assert!(sess.join(SESSION_META).is_file());
        // W245: the prompt binding lives in the same file
        write_session_meta(&other, Some("test-model-x"), Some("p1")).unwrap();
        assert_eq!(crate::prompts::session_prompt_id(&other).as_deref(), Some("p1"));
        std::fs::remove_file(other.join(SESSION_META)).unwrap();
        assert_eq!(session_meta(&other), None);
        std::fs::write(other.join(SESSION_META), "not json").unwrap();
        assert_eq!(session_meta(&other), None, "malformed meta is tolerated");

        // activate tail: the meta model rides the post_config/prepare_gen path
        std::env::set_var("W237_REPLAY_KEY", "test-key");
        let profile = celestea_runtime::merge_profile(&json!({
            "model": "deepseek-v4-flash-0731",
            "api_key_env": "W237_REPLAY_KEY",
        }))
        .expect("lenient merge");
        let store = crate::providers::ProvidersStore::empty();
        let mut pj = crate::profile_to_json(&profile);
        if let Some(m) = session_meta(&sess) {
            assert!(crate::api::validate_model_name(&m).is_ok());
            pj["model"] = json!(m);
        }
        std::env::set_var("CELESTEA_SESSION_DIR", &sess);
        let gen = crate::prepare_gen(pj, None, &store).unwrap();
        assert_eq!(gen.model, "test-model-x", "meta model applied at activate");
        assert_eq!(user_texts(&gen.runtime.session), vec!["meta hello".to_string()]);

        // no meta -> the profile model stays (no override)
        std::env::set_var("CELESTEA_SESSION_DIR", &other);
        let gen2 = crate::prepare_gen(crate::profile_to_json(&profile), None, &store).unwrap();
        assert_eq!(gen2.model, "deepseek-v4-flash-0731");

        // invalid meta model is rejected by the same validation
        write_session_meta(&other, Some("bad model!"), None).unwrap();
        let m = session_meta(&other).unwrap();
        assert!(crate::api::validate_model_name(&m).is_err());

        std::env::remove_var("CELESTEA_SESSION_DIR");
        std::env::remove_var("W237_REPLAY_KEY");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branch_copies_history_and_messages_read_back() {
        let dir = scratch("branch");
        let ws_path = dir.join("ws");
        std::fs::create_dir_all(ws_path.join("src")).unwrap();
        let src_file = ws_path.join("src").join(SESSION_FILE);
        std::fs::write(&src_file, user_line("hello from source")).unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        reg.register(&ws_path.display().to_string()).unwrap();

        // default title: "<源名>-分支" + timestamp suffix; content copied byte-exact
        let (ws, name, new_dir) = branch_session_dir(&reg.snapshot(), "ws/src", None).unwrap();
        assert_eq!(ws, "ws");
        assert!(name.starts_with("src-分支-"), "default title '{name}'");
        let branch_file = new_dir.join(SESSION_FILE);
        assert!(branch_file.is_file());
        assert_eq!(
            std::fs::read_to_string(&branch_file).unwrap(),
            std::fs::read_to_string(&src_file).unwrap(),
            "branch is a byte-exact copy"
        );

        // the source is untouched
        assert!(std::fs::read_to_string(&src_file).unwrap().contains("hello from source"));

        // messages endpoint read path (parse + map): the copy is readable
        let text = std::fs::read_to_string(&branch_file).unwrap();
        let events = crate::api::parse_session_jsonl(&text);
        let messages: Vec<serde_json::Value> = events
            .iter()
            .filter_map(crate::api::session_event_to_message)
            .collect();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert!(messages[0]["content"].as_str().unwrap().contains("hello from source"));

        // W244: the optional meta file travels with the branch
        std::fs::write(ws_path.join("src").join(SESSION_META), "{\"model\":\"test-model-x\"}").unwrap();
        let (_, n3, d3) = branch_session_dir(&reg.snapshot(), "ws/src", Some("带元数据")).unwrap();
        assert!(n3.starts_with("带元数据-"));
        assert_eq!(session_meta(&d3).as_deref(), Some("test-model-x"), "meta copied");

        // explicit title (CJK kept) + branch never activates
        let (_, n2, _) = branch_session_dir(&reg.snapshot(), "ws/src", Some("副本")).unwrap();
        assert!(n2.starts_with("副本-"));
        assert_ne!(
            reg.snapshot().active_session.as_deref(),
            Some(format!("ws/{n2}").as_str()),
            "branch does not activate"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_rename_moves_folder_and_updates_registry() {
        let dir = scratch("wsrename");
        let folder_a = dir.join("项目A");
        let folder_b = dir.join("项目B");
        std::fs::create_dir_all(&folder_a).unwrap();
        std::fs::create_dir_all(&folder_b).unwrap();
        std::fs::create_dir_all(folder_a.join("s1")).unwrap();
        std::fs::write(folder_a.join("s1/cli-main.jsonl"), "x\n").unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        reg.register(&folder_a.display().to_string()).unwrap();
        reg.register(&folder_b.display().to_string()).unwrap();
        reg.set_active(Some("项目A/s1".to_string())).unwrap();

        // colliding workspace key -> 409, nothing moved
        let err = reg.rename_workspace("项目A", "项目B").unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert!(folder_a.is_dir());
        // target exists on disk -> 409
        let blocker = dir.join("占位");
        std::fs::create_dir_all(&blocker).unwrap();
        let err = reg.rename_workspace("项目B", "占位").unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert!(folder_b.is_dir());
        // unknown -> 404
        let err = reg.rename_workspace("无", "X").unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);

        // ok: the FOLDER itself is renamed on disk (CJK kept), the registered
        // path + active id are re-pointed, and the sessions travel with it
        reg.rename_workspace("项目A", "新项目").unwrap();
        assert!(!folder_a.exists(), "old folder moved away");
        let new_folder = dir.join("新项目");
        assert!(new_folder.is_dir());
        assert!(new_folder.join("s1/cli-main.jsonl").is_file(), "session moved with the folder");
        let snap = reg.snapshot();
        assert!(snap
            .workspaces
            .iter()
            .any(|w| workspace_basename(&w.path).as_deref() == Some("新项目")));
        assert!(!snap
            .workspaces
            .iter()
            .any(|w| workspace_basename(&w.path).as_deref() == Some("项目A")));
        assert_eq!(snap.active_session.as_deref(), Some("新项目/s1"));
        // renaming onto itself is a no-op success
        assert!(reg.rename_workspace("新项目", "新项目").is_ok());

        // persisted (reload from disk)
        let reloaded = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        assert_eq!(reloaded.snapshot().active_session.as_deref(), Some("新项目/s1"));
        assert!(reloaded
            .snapshot()
            .workspaces
            .iter()
            .any(|w| workspace_basename(&w.path).as_deref() == Some("新项目")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn active_session_cannot_be_archived_or_deleted() {
        let dir = scratch("guard");
        let ws_path = dir.join("wsx");
        let sess = ws_path.join("s1");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join(SESSION_FILE), user_line("keep")).unwrap();
        let reg = load_registry(dir.join("workspaces.json"), &dir.join("sessions")).unwrap();
        reg.register(&ws_path.display().to_string()).unwrap();

        // active session: archive + delete both refused (400)
        reg.set_active(Some("wsx/s1".to_string())).unwrap();
        let data = reg.snapshot();
        let e = move_session_dir(&data, "wsx/s1", MoveOp::Archive).unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);
        assert!(e.1.contains("cannot be archived"));
        let e = move_session_dir(&data, "wsx/s1", MoveOp::Trash).unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);
        assert!(e.1.contains("cannot be deleted"));
        assert!(sess.is_dir(), "refused moves must leave the dir alone");

        // not active: archive -> .celestea-archived/<name>
        reg.set_active(Some("wsx/other".to_string())).unwrap();
        let data = reg.snapshot();
        move_session_dir(&data, "wsx/s1", MoveOp::Archive).unwrap();
        assert!(!sess.exists());
        assert!(ws_path.join(ARCHIVED_DIR).join("s1").is_dir());
        // the moved-away dir is no longer archivable
        let e = move_session_dir(&data, "wsx/s1", MoveOp::Archive).unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);

        // unarchive -> back in place, history intact
        move_session_dir(&data, "wsx/s1", MoveOp::Unarchive).unwrap();
        assert!(sess.join(SESSION_FILE).is_file());
        assert!(std::fs::read_to_string(sess.join(SESSION_FILE)).unwrap().contains("keep"));

        // delete -> .celestea-trash/<name>-<ts> (recoverable on disk)
        move_session_dir(&data, "wsx/s1", MoveOp::Trash).unwrap();
        assert!(!sess.exists());
        let trashed: Vec<String> = std::fs::read_dir(ws_path.join(TRASH_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(trashed.iter().any(|n| n.starts_with("s1-")));

        // traversal / malformed ids are rejected before any fs access
        let data = reg.snapshot();
        for bad in ["W/../etc", "../W/s1", "W//s1", "W/a/b"] {
            assert!(move_session_dir(&data, bad, MoveOp::Archive).is_err(), "{bad:?}");
        }
        let e = move_session_dir(&data, "nope/s1", MoveOp::Archive).unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_browse_rejects_out_of_bounds_and_lists_dirs_only() {
        let dir = scratch("browse");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::create_dir(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("sub"), dir.join("link")).unwrap();

        // absolute + existing dir required
        assert!(browse_dirs(Path::new("relative/x")).is_err());
        assert!(browse_dirs(&dir.join("does-not-exist")).is_err());
        assert!(browse_dirs(&dir.join("file.txt")).is_err(), "files are not browsable");
        // dirs only: file / dot-dir / symlink (to a dir) are all excluded
        let dirs = browse_dirs(&dir).unwrap();
        assert_eq!(dirs, vec!["sub".to_string()]);
        // a symlink pointing outside is never followed
        #[cfg(unix)]
        {
            let outside = scratch("browse-out");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("out-link")).unwrap();
            let dirs = browse_dirs(&dir).unwrap();
            assert_eq!(dirs, vec!["sub".to_string()]);
            let _ = std::fs::remove_dir_all(&outside);
        }

        // entry cap: 200 (sorted, first 200 kept)
        let big = dir.join("big");
        std::fs::create_dir_all(&big).unwrap();
        for i in 0..205 {
            std::fs::create_dir(big.join(format!("d{i:03}"))).unwrap();
        }
        let dirs = browse_dirs(&big).unwrap();
        assert_eq!(dirs.len(), MAX_DIR_ENTRIES);
        assert_eq!(dirs[0], "d000");
        assert_eq!(dirs[199], "d199");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- W239: worker-session visibility ----------------------------------

    #[test]
    fn worker_sid_strips_prefix_only() {
        assert_eq!(worker_sid("worker:session-0"), Some("session-0"));
        assert_eq!(worker_sid("worker:cli-main"), Some("cli-main"));
        assert_eq!(worker_sid("worker:"), Some(""));
        // file-backed ids never carry the scheme
        assert_eq!(worker_sid("默认/cli-main"), None);
        assert_eq!(worker_sid("session-0"), None);
        assert_eq!(worker_sid(""), None);
        assert_eq!(worker_sid("worker-other"), None);
        assert_eq!(worker_sid("Worker:session-1"), None);
    }

    #[test]
    fn render_worker_entry_contract_shape() {
        let v = render_worker_entry("session-7", "W7·Probe", Some("deepseek-v4-pro"), 3);
        assert_eq!(
            v,
            json!({
                "id": "worker:session-7",
                "workspace": "engine",
                "kind": "worker",
                "title": "W7·Probe",
                "model": "deepseek-v4-pro",
                "size": 3,
                "modified": 0,
                "active": false,
            })
        );
        // absent model -> null (never a stringified fallback); zero events ok
        let v2 = render_worker_entry("session-8", "bare", None, 0);
        assert_eq!(v2["id"], "worker:session-8");
        assert_eq!(v2["model"], Value::Null);
        assert_eq!(v2["size"], 0);
        assert_eq!(v2["workspace"], "engine");
        assert_eq!(v2["kind"], "worker");
    }

    #[test]
    fn worker_session_entries_lists_workers_and_skips_cli_main_shadow() {
        let tsv = scratch("workers").join("registry.tsv");
        let reg = WorkerRegistry::new(&tsv);
        // compose-time shadow registration of the host conversation: skipped.
        reg.sessions()
            .register(std::sync::Arc::new(Session::new(SessionMeta {
                id: WORKER_HOST_SHADOW_SID.into(),
                title: WORKER_HOST_SHADOW_SID.into(),
                workspace: None,
                model: Some("deepseek-v4-pro".into()),
            })))
            .unwrap();
        let sid = reg
            .sessions()
            .create(SessionSpec {
                title: "WPROBE·hello".into(),
                workspace: Some("engine".into()),
                model: Some("deepseek-v4-pro".into()),
            });
        let session = reg.sessions().get(&sid).expect("registered");
        session.log.append(SessionEvent::UserMessage { text: "ping".into() });
        session.log.append(SessionEvent::AssistantMessage { text: "pong".into() });

        let entries = worker_session_entries(&reg);
        assert_eq!(entries.len(), 1, "cli-main shadow must never be listed");
        assert_eq!(entries[0]["id"], format!("worker:{sid}"));
        assert_eq!(entries[0]["workspace"], "engine");
        assert_eq!(entries[0]["kind"], "worker");
        assert_eq!(entries[0]["title"], "WPROBE·hello");
        assert_eq!(entries[0]["model"], "deepseek-v4-pro");
        assert_eq!(entries[0]["size"], 2, "size = worker log event count");
        assert_eq!(entries[0]["modified"], 0);
        assert_eq!(entries[0]["active"], false);

        // an empty registry (only the shadow) yields no entries at all
        let reg2 = WorkerRegistry::new(scratch("workers2").join("r.tsv"));
        reg2.sessions()
            .register(std::sync::Arc::new(Session::new(SessionMeta {
                id: WORKER_HOST_SHADOW_SID.into(),
                title: WORKER_HOST_SHADOW_SID.into(),
                workspace: None,
                model: None,
            })))
            .unwrap();
        assert!(worker_session_entries(&reg2).is_empty());
        let _ = std::fs::remove_dir_all(&tsv.parent().unwrap());
    }
}
