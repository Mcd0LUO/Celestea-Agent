/**
 * `workspaces.json` (v2) registry store — `contracts/data-files/workspaces.schema.json`,
 * `src/workspaces.rs:122-140,794-970`.
 *
 * Frozen format facts honored here:
 *   - NO version field; the workspace KEY is the registered path's folder
 *     basename and is never stored;
 *   - v1 `{"name":…}` rows are tolerated and ignored; `active_session` is
 *     rewritten to the basename on load (idempotent);
 *   - unknown fields are tolerated, a malformed file is a HARD error (the
 *     unreadable registry is never overwritten with an empty one);
 *   - write = pretty JSON -> `<file>.json.tmp` -> rename (atomic, no fsync).
 */

import { renameSync } from "node:fs";
import { writeJsonAtomic, isDirectory, isFile, listEntries, readJsonIfExists } from "./fs-json.js";
import { badRequest, conflict, errText, fail, notFound, ok, serverError, type StoreResult } from "./result.js";
import {
  isAbsolutePath,
  joinPath,
  parentDir,
  resolvePath,
  sessionRoots,
  workspaceBasename,
  type PathInputLike,
} from "./session-id.js";

export const SESSION_FILE = "cli-main.jsonl";

export interface RegistryWorkspace {
  path: string;
}

export interface RegistryData {
  workspaces: RegistryWorkspace[];
  active_session: string | null;
}

export interface WorkspaceRow {
  name: string;
  path: string;
  /** LIVE session dirs only (archived / trashed dirs are not counted). */
  sessions: number;
}

export interface WorkspacesView {
  workspaces: WorkspaceRow[];
  active_session: string | null;
}

function parseEntry(row: unknown): RegistryWorkspace | null {
  if (typeof row !== "object" || row === null) return null;
  const path = (row as Record<string, unknown>)["path"];
  return typeof path === "string" && path !== "" ? { path } : null;
}

function parseRegistry(raw: unknown): Omit<RegistryData, "workspaces"> & { workspaces: RegistryWorkspace[] } {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(rec["workspaces"]) ? rec["workspaces"] : [];
  const workspaces: RegistryWorkspace[] = [];
  for (const row of rows) {
    const entry = parseEntry(row);
    if (entry !== null) workspaces.push(entry);
  }
  const active = rec["active_session"];
  return { workspaces, active_session: typeof active === "string" && active !== "" ? active : null };
}

/** Duplicate folder names make the workspace key ambiguous: hard error. */
function assertUniqueBasenames(workspaces: readonly RegistryWorkspace[], input: PathInputLike = undefined): void {
  const seen = new Map<string, string>();
  for (const w of workspaces) {
    const base = workspaceBasename(w.path, input) ?? w.path;
    const other = seen.get(base);
    if (other !== undefined && other !== w.path) {
      throw new Error(`two workspaces resolve to the same folder name '${base}' (workspace keys must be unique basenames; rename one folder)`);
    }
    seen.set(base, w.path);
  }
}

function loadRegistry(file: string, input: PathInputLike = undefined): RegistryData {
  const out = readJsonIfExists(file);
  if (!out.exists) return { workspaces: [], active_session: null };
  if (out.error !== undefined) throw new Error(`workspaces.json '${file}' is malformed: ${out.error}`);
  const data = parseRegistry(out.value);
  assertUniqueBasenames(data.workspaces, input);
  return data;
}

/**
 * W815-9: a registered path is stored normalized (absolute, no trailing slash).
 * `register` used to keep whatever the client sent, so `/tmp/foo/` made the
 * rename target `/tmp/foo/bar` — a child of the source folder (EINVAL).
 */
function normalizeWorkspacePath(path: string, input: PathInputLike = undefined): string {
  return resolvePath(path, input);
}

export class WorkspacesStore {
  private data: RegistryData;

  constructor(
    private readonly file: string,
    /**
     * The path rules of THIS call's platform. Defaults to the host's — production
     * always wants the host — but it is injectable so the win32 branch is
     * unit-tested on Linux (the W885 seam). `register()` used to test
     * `startsWith("/")`, which rejected EVERY Windows absolute path, so a Windows
     * install could never register a workspace and every "new session" ended in
     * `404 unknown workspace ''`.
     */
    private readonly platform: PathInputLike = undefined,
  ) {
    this.data = loadRegistry(file, platform);
  }

  /** Snapshot of the registry (callers must not mutate it). */
  registry(): RegistryData {
    return { workspaces: this.data.workspaces.map((w) => ({ ...w })), active_session: this.data.active_session };
  }

  activeSession(): string | null {
    return this.data.active_session;
  }

  workspacePath(name: string): string | undefined {
    return this.data.workspaces.find((w) => workspaceBasename(w.path, this.platform) === name)?.path;
  }

  private persist(): StoreResult<void> {
    try {
      writeJsonAtomic(this.file, { workspaces: this.data.workspaces, active_session: this.data.active_session });
      return ok(undefined);
    } catch (e) {
      return serverError(errText(e));
    }
  }

  /** Persist `active_session`; the caller owns the 500 wording. */
  setActiveSession(id: string | null): StoreResult<void> {
    this.data.active_session = id;
    return this.persist();
  }

  /**
   * Count LIVE session dirs of a workspace across EVERY layer (W880): the
   * canonical `<CELESTEA_HOME>/.../sessions`, the slice-A
   * `<ws>/.celestea/sessions` and the oldest workspace root. A name present in
   * more than one layer is counted ONCE (the canonical copy wins), matching
   * `SessionsStore.list()`; missing a layer is how the GUI's workspace session
   * count silently drops to 0.
   */
  countSessions(path: string): number {
    const seen = new Set<string>();
    for (const root of sessionRoots(path)) {
      for (const e of listEntries(root)) {
        if (!e.isDir || e.name.startsWith(".") || seen.has(e.name)) continue;
        if (isFile(`${root}/${e.name}/${SESSION_FILE}`)) seen.add(e.name);
      }
    }
    return seen.size;
  }

  view(): WorkspacesView {
    return {
      workspaces: this.data.workspaces.map((w) => {
        const name = workspaceBasename(w.path, this.platform) ?? w.path;
        return { name, path: w.path, sessions: this.countSessions(w.path) };
      }),
      active_session: this.data.active_session,
    };
  }

  /** POST /api/workspaces — register only; the folder is never touched. */
  register(rawPath: string): StoreResult<string> {
    const asked = rawPath.trim();
    if (asked === "") return badRequest("path must not be empty");
    // W885 follow-up: "is this absolute" is a PLATFORM question, not `startsWith("/")`.
    // On Windows every path is `C:\...`, so the old test rejected all of them.
    if (!isAbsolutePath(asked, this.platform)) return badRequest(`path '${asked}' must be absolute`);
    // W815-9: canonicalize before storing (see `normalizeWorkspacePath`).
    const path = normalizeWorkspacePath(asked, this.platform);
    if (!isDirectory(path)) return badRequest(`path '${path}' is not an existing directory`);
    const base = workspaceBasename(path, this.platform);
    if (base === null) return badRequest(`path '${path}' has no folder name`);
    const existing = this.data.workspaces.find((w) => w.path === path);
    if (existing !== undefined) return conflict(`path '${path}' is already registered as workspace '${base}'`);
    const clash = this.data.workspaces.find((w) => workspaceBasename(w.path, this.platform) === base);
    if (clash !== undefined) {
      return conflict(`workspace '${base}' already exists (folder '${path}' and '${clash.path}' share the same folder name; rename one folder first)`);
    }
    this.data.workspaces.push({ path });
    const saved = this.persist();
    if (!saved.ok) return saved;
    return ok(base);
  }

  /** POST /api/workspaces/{name}/delete — deregister only. */
  deregister(name: string): StoreResult<void> {
    const idx = this.data.workspaces.findIndex((w) => workspaceBasename(w.path, this.platform) === name);
    if (idx < 0) return notFound(`unknown workspace '${name}'`);
    const [removed] = this.data.workspaces.splice(idx, 1);
    if (this.data.active_session !== null && this.data.active_session.split("/")[0] === name) {
      this.data.active_session = null;
    }
    void removed;
    return this.persist();
  }

  batchDelete(names: readonly string[]): { deleted: number; failed: Array<{ name: string; error: string }> } {
    let deleted = 0;
    const failed: Array<{ name: string; error: string }> = [];
    for (const name of names) {
      const res = this.deregister(name);
      if (res.ok) deleted += 1;
      else failed.push({ name, error: res.error });
    }
    return { deleted, failed };
  }

  /** POST /api/workspaces/{name}/rename — really renames the FOLDER. */
  renameWorkspace(name: string, newName: string): StoreResult<void> {
    const idx = this.data.workspaces.findIndex((w) => workspaceBasename(w.path, this.platform) === name);
    if (idx < 0) return notFound(`unknown workspace '${name}'`);
    const row = this.data.workspaces[idx];
    if (row === undefined) return notFound(`unknown workspace '${name}'`);
    if (this.data.workspaces.some((w) => workspaceBasename(w.path, this.platform) === newName)) {
      return conflict(`workspace '${newName}' already exists`);
    }
    // W815-9: normalize a legacy row's path before deriving the sibling target.
    const from = normalizeWorkspacePath(row.path, this.platform);
    row.path = from;
    // W885 follow-up: the sibling target is a PLATFORM question too. The old
    // `lastIndexOf("/")` found no separator in `C:\Users\me\proj`, so the
    // "parent" became `C:\Users\me\pro` and the rename moved the folder to a
    // sibling of a NONEXISTENT directory.
    const parent = parentDir(from, this.platform);
    const target = joinPath(this.platform, parent, newName);
    if (target !== row.path && isDirectory(target)) {
      return conflict(`target '${target}' already exists; rename the folder first`);
    }
    const previousActive = this.data.active_session;
    try {
      renameSync(from, target);
    } catch (e) {
      return fail(500, `move failed: ${errText(e)}`);
    }
    row.path = target;
    if (this.data.active_session !== null) {
      const [ws, sess] = this.data.active_session.split("/");
      if (ws === name && sess !== undefined) this.data.active_session = `${newName}/${sess}`;
    }
    const saved = this.persist();
    if (!saved.ok) {
      // W815-10: the registry is the source of truth and it did NOT accept the
      // move — undo the folder rename and the in-memory row so disk and memory
      // cannot diverge (the retired backend's rollback, restored).
      row.path = from;
      this.data.active_session = previousActive;
      try {
        renameSync(target, from);
      } catch (e) {
        return fail(500, `${saved.error}; rollback failed: ${errText(e)}`);
      }
      return saved;
    }
    return saved;
  }
}
