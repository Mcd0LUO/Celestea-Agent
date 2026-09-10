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
import { workspaceBasename } from "./session-id.js";

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
function assertUniqueBasenames(workspaces: readonly RegistryWorkspace[]): void {
  const seen = new Map<string, string>();
  for (const w of workspaces) {
    const base = workspaceBasename(w.path) ?? w.path;
    const other = seen.get(base);
    if (other !== undefined && other !== w.path) {
      throw new Error(`two workspaces resolve to the same folder name '${base}' (workspace keys must be unique basenames; rename one folder)`);
    }
    seen.set(base, w.path);
  }
}

function loadRegistry(file: string): RegistryData {
  const out = readJsonIfExists(file);
  if (!out.exists) return { workspaces: [], active_session: null };
  if (out.error !== undefined) throw new Error(`workspaces.json '${file}' is malformed: ${out.error}`);
  const data = parseRegistry(out.value);
  assertUniqueBasenames(data.workspaces);
  return data;
}

export class WorkspacesStore {
  private data: RegistryData;

  constructor(private readonly file: string) {
    this.data = loadRegistry(file);
  }

  /** Snapshot of the registry (callers must not mutate it). */
  registry(): RegistryData {
    return { workspaces: this.data.workspaces.map((w) => ({ ...w })), active_session: this.data.active_session };
  }

  activeSession(): string | null {
    return this.data.active_session;
  }

  workspacePath(name: string): string | undefined {
    return this.data.workspaces.find((w) => workspaceBasename(w.path) === name)?.path;
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

  /** Count session dirs directly under a workspace path (live only). */
  countSessions(path: string): number {
    let n = 0;
    for (const e of listEntries(path)) {
      if (!e.isDir || e.name.startsWith(".")) continue;
      if (isFile(`${path}/${e.name}/${SESSION_FILE}`)) n += 1;
    }
    return n;
  }

  view(): WorkspacesView {
    return {
      workspaces: this.data.workspaces.map((w) => {
        const name = workspaceBasename(w.path) ?? w.path;
        return { name, path: w.path, sessions: this.countSessions(w.path) };
      }),
      active_session: this.data.active_session,
    };
  }

  /** POST /api/workspaces — register only; the folder is never touched. */
  register(rawPath: string): StoreResult<string> {
    const path = rawPath.trim();
    if (path === "") return badRequest("path must not be empty");
    if (!path.startsWith("/")) return badRequest(`path '${path}' must be absolute`);
    if (!isDirectory(path)) return badRequest(`path '${path}' is not an existing directory`);
    const base = workspaceBasename(path);
    if (base === null) return badRequest(`path '${path}' has no folder name`);
    const existing = this.data.workspaces.find((w) => w.path === path);
    if (existing !== undefined) return conflict(`path '${path}' is already registered as workspace '${base}'`);
    const clash = this.data.workspaces.find((w) => workspaceBasename(w.path) === base);
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
    const idx = this.data.workspaces.findIndex((w) => workspaceBasename(w.path) === name);
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
    const idx = this.data.workspaces.findIndex((w) => workspaceBasename(w.path) === name);
    if (idx < 0) return notFound(`unknown workspace '${name}'`);
    const row = this.data.workspaces[idx];
    if (row === undefined) return notFound(`unknown workspace '${name}'`);
    if (this.data.workspaces.some((w) => workspaceBasename(w.path) === newName)) {
      return conflict(`workspace '${newName}' already exists`);
    }
    const parent = row.path.slice(0, row.path.lastIndexOf("/")) || "/";
    const target = `${parent === "/" ? "" : parent}/${newName}`;
    if (target !== row.path && isDirectory(target)) {
      return conflict(`target '${target}' already exists; rename the folder first`);
    }
    try {
      renameSync(row.path, target);
    } catch (e) {
      return fail(500, `move failed: ${errText(e)}`);
    }
    row.path = target;
    if (this.data.active_session !== null) {
      const [ws, sess] = this.data.active_session.split("/");
      if (ws === name && sess !== undefined) this.data.active_session = `${newName}/${sess}`;
    }
    return this.persist();
  }

  /** Roll a rename back (compose/persist failure paths). */
  rollbackRename(from: string, to: string): void {
    const res = this.renameWorkspace(from, to);
    void res;
  }
}
