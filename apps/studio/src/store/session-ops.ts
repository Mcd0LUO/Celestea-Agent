/**
 * Session directory moves: rename / branch / archive / trash
 * (`src/workspaces.rs:1228-1311,1506-1650`).
 *
 * All four are plain filesystem moves: archiving is the canonical
 * `<CELESTEA_HOME>/workspaces/<ws>/archive/<name>` (W880; id-preserving and
 * reversible) while deleting moves to `<CELESTEA_HOME>/workspaces/<ws>/trash/<name>-<ts>`
 * (NOT addressable by id afterwards). The legacy `<ws>/.celestea-archived` /
 * `<ws>/.celestea-trash` siblings stay READABLE. The archive state needs no
 * field in `workspaces.json` because the default scanner never lists it.
 *
 * W791: "invisible to the scanner" is about the DEFAULT listing only. An
 * archived session keeps its id, so the three operations that address a session
 * BY ID must agree on where it can be: `unarchive` always did, `trash` now looks
 * in the archive too (B3), and the scanner answers the `?archived=1` listing
 * (`SessionsStore.listArchived`, B1).
 *
 * W794 (裁决: "active 只是状态标记，不是保护理由"): the ACTIVE session is no
 * longer refused by `archive` / `trash` — both move it like any other session.
 * The active MARKER is a view preference, not a lock, so the operation owns the
 * consequence: once the active session has moved away, `active_session` is set
 * to `null` and persisted (it must never keep pointing at an id this call just
 * removed). Cutting the session's in-flight model response and releasing its
 * engine instance is the engine's half of the same removal and happens BEFORE
 * these functions run (see `handlers/session-move.ts`).
 */

import { copyFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDirectory, isFile, removeDir } from "./fs-json.js";
import { badRequest, conflict, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { archiveDirCandidates, archiveRoots, baseName, parentDir, sanitizeComponent, timestampSuffix, trashRoots } from "./session-id.js";
import { readSessionMeta, writeSessionMeta } from "./session-meta.js";
import { SESSION_FILE, type WorkspacesStore } from "./workspaces.js";
import { displayTitle, type ResolvedSession, type SessionsStore } from "./sessions.js";

export interface BatchOutcome {
  count: number;
  failed: Array<{ id: string; error: string }>;
}

/** W885: platform-aware parent (the pre-W885 hardcoded `/` broke on win32). */
function parentOf(path: string): string {
  return parentDir(path);
}

/** W885: platform-aware basename (`dir.slice(lastIndexOf("/") + 1)` before). */
function baseOf(path: string): string {
  return baseName(path);
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
    const title = newTitle.trim();
    const base = sanitizeComponent(title);
    if (base === "" || base === "." || base === "..") return badRequest("new title must not be empty");
    if (base.startsWith(".")) return badRequest(`title '${title}' sanitizes to the hidden name '${base}'`);
    if (base === res.session) return ok(res.id);
    const newDir = this.sessions.uniqueDir(res.wsPath, base, parentOf(res.dir));
    try {
      renameSync(res.dir, newDir);
    } catch (e) {
      return fail(500, `move failed: ${errText(e)}`);
    }
    // W779 T2: the directory name is the sanitized title, so the DISPLAY name
    // lives in session.json — an update that fails reports 500 rather than
    // leaving the session labelled with its old title.
    const titled = this.writeTitle(newDir, title);
    if (!titled.ok) {
      // N1 (W815): a failed meta write must not leave the directory moved — the
      // caller (and `active_session`) still addresses the OLD id, so undo it.
      try {
        renameSync(newDir, res.dir);
      } catch (e) {
        return fail(500, `${titled.error}; rollback failed: ${errText(e)}`);
      }
      return titled;
    }
    return ok(`${res.workspace}/${baseOf(newDir)}`);
  }

  /**
   * W779 T2: `session.json.title` <- [title], keeping every other key. A session
   * that never had a meta file gets a `{title}` one (the title belongs to the
   * session, not to the model/prompt/mode trio).
   */
  private writeTitle(dir: string, title: string): StoreResult<void> {
    try {
      writeSessionMeta(dir, { ...(readSessionMeta(dir) ?? {}), title });
      return ok(undefined);
    } catch (e) {
      return fail(500, `meta write failed: ${errText(e)}`);
    }
  }

  /** POST /api/sessions/{id}/branch — copy the log into a sibling dir. */
  branch(id: string, title?: string): StoreResult<string> {
    const found = this.sessions.require(id);
    if (!found.ok) return found;
    const res = found.value;
    const parent = readSessionMeta(res.dir);
    const asked = (title ?? "").trim();
    // W779 T2: the default name is derived from the PARENT'S DISPLAY NAME, not
    // from its directory (`alpha-1700000000.0-分支` was the old leak).
    const display = asked === "" ? `${displayTitle(parent, res.session)}-分支` : asked;
    const base = sanitizeComponent(display);
    if (base === "" || base === "." || base === "..") return badRequest("title must not be empty");
    if (base.startsWith(".")) return badRequest(`title sanitizes to the hidden name '${base}'`);
    const newDir = this.sessions.uniqueDir(res.wsPath, `${base}-${timestampSuffix(this.now())}`, parentOf(res.dir));
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
    // The branch INHERITS model/prompt/mode and carries its OWN title (the asked
    // one, or `<parent display>-分支`); the log copy above never touches meta.
    try {
      writeSessionMeta(newDir, { ...(parent ?? {}), title: display });
    } catch (e) {
      removeDir(newDir);
      return fail(500, `meta write failed: ${errText(e)}`);
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

  /**
   * POST /api/sessions/{id}/archive — id-preserving move into the archive.
   *
   * W794: the active session is archived like any other; the active MARKER is
   * cleared afterwards (the archived row is not part of the default listing, so a
   * marker still pointing at it would contradict `GET /api/sessions`).
   */
  archive(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    if (!isDirectory(res.dir) || !isFile(`${res.dir}/${SESSION_FILE}`)) return notFound(`unknown session '${id}'`);
    const dst = join(archiveRoots(res.wsPath)[0] ?? res.wsPath, res.session);
    if (archiveDirCandidates(res.wsPath, res.session).some((c) => existsSync(c))) {
      return conflict(`session '${id}' is already archived`);
    }
    const moved = this.move(res, res.dir, dst);
    if (!moved.ok) return moved;
    return this.clearActiveIf(id);
  }

  unarchive(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    const src = archiveDirCandidates(res.wsPath, res.session).find((c) => isDirectory(c));
    if (src === undefined) return notFound(`session '${id}' is not archived`);
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

  /**
   * The session's directory wherever it currently IS: the live location first,
   * else the archive (W791 B3).
   *
   * Deleting an ARCHIVED session used to answer `unknown session '<id>'`: the
   * operation only ever looked at `<ws>/<session>`, which is exactly where an
   * archived session is NOT. The id is unchanged by archiving, so the archive is
   * the only other place it can be — and both a live and an archived copy is
   * impossible (`unarchive` refuses to overwrite a live session).
   */
  private locate(res: ResolvedSession): string | null {
    if (isDirectory(res.dir) && isFile(`${res.dir}/${SESSION_FILE}`)) return res.dir;
    const archived = archiveDirCandidates(res.wsPath, res.session).find((c) => isDirectory(c) && isFile(`${c}/${SESSION_FILE}`));
    return archived ?? null;
  }

  /**
   * One session into `<ws>/.celestea-trash/<session>-<ts>`.
   *
   * W794: no active-session guard. Deleting the focused session is a normal
   * operation — the marker is cleared instead, in the same atomic write the
   * registry uses for every other `active_session` change.
   */
  private trash(id: string): StoreResult<void> {
    const resolved = this.sessions.resolve(id);
    if (!resolved.ok) return resolved;
    const res = resolved.value;
    const from = this.locate(res);
    if (from === null) return notFound(`unknown session '${id}'`);
    const dst = join(trashRoots(res.wsPath)[0] ?? res.wsPath, `${res.session}-${timestampSuffix(this.now())}`);
    const moved = this.move(res, from, dst);
    if (!moved.ok) return moved;
    return this.clearActiveIf(id);
  }

  /**
   * W794: `active_session` must not survive the session it names.
   *
   * Called only AFTER the directory has actually moved (a failure to move leaves
   * the registry untouched — the session is still there and still active). The
   * value becomes `null`: no other session is silently promoted, so the UI shows
   * what is true (nothing is focused) instead of a session the user never chose.
   * A failed persist is a 500 — the caller's `failed[]` / error then says the
   * registry could not be updated, rather than pretending the id is gone.
   */
  private clearActiveIf(id: string): StoreResult<void> {
    if (this.ws.activeSession() !== id.trim()) return ok(undefined);
    return this.ws.setActiveSession(null);
  }
}
