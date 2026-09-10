/**
 * Session directory moves: rename / branch / archive / trash
 * (`src/workspaces.rs:1228-1311,1506-1650`).
 *
 * All four are plain filesystem moves next to the registry: archiving is
 * `<ws>/.celestea-archived/<name>` (id-preserving and reversible) while
 * deleting moves to `<ws>/.celestea-trash/<name>-<ts>` (NOT addressable by id
 * afterwards). Dot-dirs are invisible to the session scanner, which is the
 * whole reason the archive state needs no field in `workspaces.json`.
 */

import { copyFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { isDirectory, isFile, removeDir } from "./fs-json.js";
import { badRequest, conflict, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { sanitizeComponent, timestampSuffix } from "./session-id.js";
import { SESSION_META } from "./session-meta.js";
import { SESSION_FILE, type WorkspacesStore } from "./workspaces.js";
import type { ResolvedSession, SessionsStore } from "./sessions.js";

export const ARCHIVED_DIR = ".celestea-archived";
export const TRASH_DIR = ".celestea-trash";

export interface BatchOutcome {
  count: number;
  failed: Array<{ id: string; error: string }>;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export class SessionOps {
  constructor(
    private readonly ws: WorkspacesStore,
    private readonly sessions: SessionsStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** POST /api/sessions/{id}/rename — same name is a no-op success. */
  rename(id: string, newTitle: string): StoreResult<string> {
    const found = this.sessions.require(id);
    if (!found.ok) return found;
    const res = found.value;
    const base = sanitizeComponent(newTitle.trim());
    if (base === "" || base === "." || base === "..") return badRequest("new title must not be empty");
    if (base.startsWith(".")) {
      return badRequest(`title '${newTitle.trim()}' sanitizes to the hidden name '${base}'`);
    }
    if (base === res.session) return ok(res.id);
    const newDir = this.sessions.uniqueDir(res.wsPath, base);
    try {
      renameSync(res.dir, newDir);
    } catch (e) {
      return fail(500, `move failed: ${errText(e)}`);
    }
    return ok(`${res.workspace}/${baseOf(newDir)}`);
  }

  /** POST /api/sessions/{id}/branch — copy the log into a sibling dir. */
  branch(id: string, title?: string): StoreResult<string> {
    const found = this.sessions.require(id);
    if (!found.ok) return found;
    const res = found.value;
    const asked = (title ?? "").trim();
    const base = asked === "" ? `${res.session}-分支` : sanitizeComponent(asked);
    if (base === "" || base === "." || base === "..") return badRequest("title must not be empty");
    if (base.startsWith(".")) return badRequest(`title sanitizes to the hidden name '${base}'`);
    const newDir = this.sessions.uniqueDir(res.wsPath, `${base}-${timestampSuffix(this.now())}`);
    try {
      mkdirSync(newDir, { recursive: false });
    } catch (e) {
      return fail(500, `create failed: ${errText(e)}`);
    }
    try {
      copyFileSync(`${res.dir}/${SESSION_FILE}`, `${newDir}/${SESSION_FILE}`);
    } catch (e) {
      removeDir(newDir);
      return fail(500, `copy failed: ${errText(e)}`);
    }
    if (isFile(`${res.dir}/${SESSION_META}`)) {
      try {
        copyFileSync(`${res.dir}/${SESSION_META}`, `${newDir}/${SESSION_META}`);
      } catch (e) {
        removeDir(newDir);
        return fail(500, `meta copy failed: ${errText(e)}`);
      }
    }
    return ok(`${res.workspace}/${baseOf(newDir)}`);
  }

  private move(res: ResolvedSession, from: string, to: string): StoreResult<void> {
    try {
      mkdirSync(parentOf(to), { recursive: true });
      renameSync(from, to);
      return ok(undefined);
    } catch (e) {
      return fail(500, `move failed: ${errText(e)}`);
    }
  }

  archive(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    if (this.ws.activeSession() === id.trim()) return badRequest(`active session '${id}' cannot be archived`);
    if (!isDirectory(res.dir) || !isFile(`${res.dir}/${SESSION_FILE}`)) return notFound(`unknown session '${id}'`);
    const dst = `${res.wsPath}/${ARCHIVED_DIR}/${res.session}`;
    if (existsSync(dst)) return conflict(`session '${id}' is already archived`);
    return this.move(res, res.dir, dst);
  }

  unarchive(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    const src = `${res.wsPath}/${ARCHIVED_DIR}/${res.session}`;
    if (!isDirectory(src)) return notFound(`session '${id}' is not archived`);
    if (existsSync(res.dir)) return conflict(`a live session already exists at '${id}'`);
    return this.move(res, src, res.dir);
  }

  /** POST /api/sessions/batch-archive — per-id, always 200. */
  batchArchive(ids: readonly string[]): { archived: number; failed: Array<{ id: string; error: string }> } {
    const out = this.batch(ids, (id) => this.archive(id));
    return { archived: out.count, failed: out.failed };
  }

  /** POST /api/sessions/batch-delete — per-id move to `.celestea-trash`. */
  batchDelete(ids: readonly string[]): { deleted: number; failed: Array<{ id: string; error: string }> } {
    const out = this.batch(ids, (id) => this.trash(id));
    return { deleted: out.count, failed: out.failed };
  }

  private batch(ids: readonly string[], op: (id: string) => StoreResult<void>): BatchOutcome {
    let count = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      const res = op(id);
      if (res.ok) count += 1;
      else failed.push({ id, error: res.error });
    }
    return { count, failed };
  }

  private trash(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    if (this.ws.activeSession() === id.trim()) return badRequest(`active session '${id}' cannot be deleted`);
    if (!isDirectory(res.dir) || !isFile(`${res.dir}/${SESSION_FILE}`)) return notFound(`unknown session '${id}'`);
    const dst = `${res.wsPath}/${TRASH_DIR}/${res.session}-${timestampSuffix(this.now())}`;
    return this.move(res, res.dir, dst);
  }
}
