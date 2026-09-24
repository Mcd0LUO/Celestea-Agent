/**
 * Session listing / creation / transcript reader (`src/workspaces.rs:1092-1221,1459-1501`).
 *
 * A "session" is a directory holding `cli-main.jsonl`. The id is
 * `<workspace-basename>/<dir>`; the `worker:<sid>` space is served by the engine
 * (RuntimeAdapter) instead.
 *
 * W880: NEW sessions land in `<CELESTEA_HOME>/workspaces/<ws>/sessions/<dir>`
 * (outside the workspace). `resolve()`/`list()` still read the two legacy
 * layouts (slice-A `<ws>/.celestea/sessions/`, then `<ws>/`) with the canonical
 * container winning. W791: the ARCHIVED sessions (canonical
 * `<home>/.../archive/<dir>`, legacy `<ws>/.celestea-archived/<dir>`, see
 * `session-ops.ts`) are a second source of the same row shape — `listArchived()`
 * — because `list()` skips dot-directories by design.
 *
 * The transcript endpoint is a pure projection of the append-only log
 * (`projectMessages` from `@celestea/session`), stopping at the first
 * unparsable line so a torn tail is dropped rather than reported.
 */

import type { StudioMessage } from "@celestea/core";
import type { SessionWorkspace } from "@celestea/runtime";
import { isDirectory, isFile, listEntries, statOf, writeFileRaw, removeDir, ensureDir } from "./fs-json.js";
import { TranscriptMemo } from "./session-log-memo.js";
import { badRequest, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { DEFAULT_SESSION_MODE, parseMode, validateMode, type SessionMode } from "./mode.js";
import { readSessionMeta, writeSessionMeta, type SessionMeta } from "./session-meta.js";
import { archiveRoots, baseName, liveDirCandidates, sessionDirName, sanitizeComponent, sessionRoots, sessionsRoot, stripCreationSuffix, workspaceBasename } from "./session-id.js";
import { validateModelName, validatePromptId } from "./validate.js";
import { SESSION_FILE, type WorkspacesStore } from "./workspaces.js";

export interface ResolvedSession {
  workspace: string;
  session: string;
  /** Canonical `<workspace>/<session>`. */
  id: string;
  wsPath: string;
  dir: string;
}

/**
 * W768 — THE single resolution of a session's workspace.
 *
 * Everything that needs to know "which workspace is this session in" goes
 * through here: the system prompt's `{{workspace}}` / `{{workspace_dir}}`
 * variables AND the per-session sandbox cwd / path-guard root. They used to be
 * two independent derivations (a store lookup for the prompt, a process-wide env
 * knob for the tools), which is exactly how the prompt ended up naming one
 * workspace while `pwd` reported another.
 *
 * Pure projection of the store's own record: no second lookup, no re-parsing of
 * the session id, nothing that could disagree with `resolve()`.
 */
export function sessionWorkspaceOf(resolved: ResolvedSession | null): SessionWorkspace | null {
  if (resolved === null) return null;
  return { name: resolved.workspace, path: resolved.wsPath };
}

/**
 * W779 T2 — the session's DISPLAY name.
 *
 * `session.json.title` when the session declared one (the original, un-sanitized
 * title), else the directory name WITHOUT its `-<secs>.<nanos>[-N]` creation
 * suffix. ONE rule, used by `list()` and by `branch()`'s default title, so the
 * GUI never has to know how a session directory is named.
 */
export function displayTitle(meta: SessionMeta | null, dirName: string): string {
  const declared = meta?.title ?? "";
  return declared === "" ? stripCreationSuffix(dirName) : declared;
}

export interface SessionRow {
  id: string;
  workspace: string;
  /**
   * W779 T2: the display name — `session.json.title`, else the directory name
   * with its creation suffix stripped (never `main-1789192174.492000000`).
   */
  title: string;
  model: string | null;
  /**
   * W729: the session's working mode. A session without `session.json.mode`
   * (and every worker row) reads as `standard` — the P0 default (K8/M3).
   */
  mode: SessionMode;
  size: number;
  modified: number;
  active: boolean;
  /**
   * W791: present (and `true`) ONLY on rows produced by `listArchived()` — the
   * default listing never carries the key, so the frozen response body of
   * `GET /api/sessions` is unchanged for every pre-W791 client.
   */
  archived?: true;
  /**
   * W513 row kind: `session` = a filesystem session directory, `worker` = an
   * engine-memory worker conversation (`workspace: "engine"`).
   */
  kind?: "session" | "worker";
  /** W513: this session has an in-flight turn (its OWN slot, not the process's). */
  busy?: boolean;
}

export interface SessionCreateRequest {
  workspace?: string;
  title: string;
  model?: string;
  prompt?: string;
  /** W729: optional at creation; absent = `standard` and NOT written (K8). */
  mode?: string;
}

export class SessionsStore {
  /**
   * W1504: the transcript projection memo. Process-wide because the store is
   * (one instance per process, `plugins.ts`), and bounded (see the module).
   */
  private readonly transcripts = new TranscriptMemo();

  constructor(private readonly ws: WorkspacesStore, private readonly now: () => number = Date.now) {}

  /**
   * Every filesystem session plus the engine rows handed in by the caller.
   *
   * W877 (slice A): sessions are scanned in BOTH layouts — the new
   * `<ws>/.celestea/sessions/` root first, then the legacy workspace root. A
   * directory name present in both is emitted ONCE and the new-layout row wins.
   * Dot-directories stay invisible in either root (that is what keeps
   * `.celestea`, `.celestea-archived` and `.celestea-trash` out of the
   * default listing).
   */
  list(extra: readonly SessionRow[] = []): SessionRow[] {
    const active = this.ws.activeSession();
    const rows: SessionRow[] = [];
    for (const w of this.ws.registry().workspaces) {
      const name = workspaceBasename(w.path) ?? w.path;
      const seen = new Set<string>();
      // Canonical container FIRST, then the slice-A transitional root, then the
      // oldest workspace root. Only a REAL session (a dir holding the log)
      // shadows a lower layer: a stray empty dir must not hide a live session.
      for (const root of sessionRoots(w.path)) {
        for (const e of listEntries(root)) {
          if (!e.isDir || e.name.startsWith(".") || seen.has(e.name)) continue;
          const log = `${root}/${e.name}/${SESSION_FILE}`;
          if (!isFile(log)) continue;
          seen.add(e.name);
          const row = this.rowOf(name, e.name, readSessionMeta(`${root}/${e.name}`), statOf(log));
          rows.push({ ...row, active: active === row.id });
        }
      }
    }
    rows.push(...extra);
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  /**
   * W791 (B1): every ARCHIVED session of every registered workspace.
   *
   * Archiving MOVES a session directory to `<ws>/.celestea-archived/<name>` and
   * keeps its id (`<wsName>/<session>`) — it is the same session, parked in a
   * hidden sibling. `list()` deliberately skips dot-directories, so before this
   * method the ONLY endpoint that could name an archived session was
   * `unarchive`; the GUI's archive panel (`?archived=1`) and the
   * delete-an-archived-session path both need to enumerate them.
   *
   * The rows have EXACTLY the shape `list()` produces — same id/workspace/title/
   * model/mode/size/modified derivation, same sort — plus `archived: true` and
   * `active: false` (an archived session can never be the active one: archiving
   * refuses the active session).
   */
  listArchived(): SessionRow[] {
    const rows: SessionRow[] = [];
    for (const w of this.ws.registry().workspaces) {
      const name = workspaceBasename(w.path) ?? w.path;
      const seen = new Set<string>();
      for (const root of archiveRoots(w.path)) {
        for (const e of listEntries(root)) {
          if (!e.isDir || e.name.startsWith(".") || seen.has(e.name)) continue;
          const log = `${root}/${e.name}/${SESSION_FILE}`;
          if (!isFile(log)) continue;
          seen.add(e.name);
          rows.push({ ...this.rowOf(name, e.name, readSessionMeta(`${root}/${e.name}`), statOf(log)), archived: true });
        }
      }
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  /** One row of the frozen shape (shared by `list` and `listArchived`). */
  private rowOf(workspace: string, dirName: string, meta: SessionMeta | null, st: { size: number; modified: number } | null): SessionRow {
    return {
      id: `${workspace}/${dirName}`,
      workspace,
      kind: "session" as const,
      title: displayTitle(meta, dirName),
      model: meta?.model ?? null,
      mode: meta?.mode ?? DEFAULT_SESSION_MODE,
      size: st?.size ?? 0,
      modified: st?.modified ?? 0,
      active: false,
    };
  }

  /**
   * Registry lookup + sanitization. The physical dir is probed in BOTH layouts
   * (W877 slice A): the new `<ws>/.celestea/sessions/<session>` wins when it
   * exists, the legacy `<ws>/<session>` is the fallback, and when NEITHER exists
   * the new layout is returned so every write path stays consistent with
   * `create()`. No registry entry is created here.
   */
  resolve(id: string): StoreResult<ResolvedSession> {
    const slash = id.trim().indexOf("/");
    if (slash <= 0) return badRequest(`invalid session id '${id}': expected '<workspace>/<session>'`);
    const wsName = id.trim().slice(0, slash);
    const wsPath = this.ws.workspacePath(wsName);
    if (wsPath === undefined) return notFound(`unknown workspace '${wsName}'`);
    const session = sanitizeComponent(id.trim().slice(slash + 1));
    if (session === "" || session === "." || session === ".." || session.startsWith(".")) {
      return badRequest(`invalid session id '${id}'`);
    }
    // W880: the canonical candidate lives under CELESTEA_HOME, OUTSIDE the
    // workspace, so the old `startsWith(wsPath/)` guard no longer applies. The
    // session segment is already sanitized (no separators, never hidden) and
    // every candidate is derived from the registered wsPath, so the result
    // cannot escape either root.
    const candidates = liveDirCandidates(wsPath, session);
    const dir = candidates.find((c) => this.isSessionDir(c)) ?? (candidates[0] as string);
    return ok({ workspace: wsName, session, id: `${wsName}/${session}`, wsPath, dir });
  }

  /** A real live session dir: a directory holding the session log. */
  private isSessionDir(dir: string): boolean {
    return isDirectory(dir) && isFile(`${dir}/${SESSION_FILE}`);
  }

  /** Resolve + require the session directory to hold a log file. */
  require(id: string): StoreResult<ResolvedSession> {
    const res = this.resolve(id);
    if (!res.ok) return res;
    if (!isDirectory(res.value.dir) || !isFile(`${res.value.dir}/${SESSION_FILE}`)) {
      return notFound(`unknown session '${id}'`);
    }
    return res;
  }

  private pickWorkspace(requested: string | undefined): string | null {
    const asked = (requested ?? "").trim();
    if (asked !== "") return asked;
    const active = this.ws.activeSession();
    if (active !== null && active.includes("/")) return active.slice(0, active.indexOf("/"));
    const first = this.ws.registry().workspaces[0];
    return first === undefined ? null : workspaceBasename(first.path);
  }

  /** POST /api/sessions — create a session dir; NEVER activates it. */
  create(req: SessionCreateRequest): StoreResult<string> {
    const wsName = this.pickWorkspace(req.workspace);
    if (wsName === null) return notFound(`unknown workspace '${(req.workspace ?? "").trim()}'`);
    const wsPath = this.ws.workspacePath(wsName);
    if (wsPath === undefined) return notFound(`unknown workspace '${wsName}'`);
    if (!isDirectory(wsPath)) return notFound(`workspace path '${wsPath}' is not accessible`);
    if (req.title.trim() === "") return badRequest("title must not be empty");
    const base = sanitizeComponent(req.title);
    if (base.startsWith(".") || base === "") {
      return badRequest(`title '${req.title}' sanitizes to the hidden name '${base}'`);
    }
    const model = req.model ?? "";
    if (model !== "") {
      const bad = validateModelName(model);
      if (bad !== null) return badRequest(`invalid model: ${bad}`);
    }
    const prompt = req.prompt ?? "";
    if (prompt !== "") {
      const bad = validatePromptId(prompt);
      if (bad !== null) return badRequest(`invalid prompt: ${bad}`);
    }
    const mode = req.mode ?? "";
    if (mode !== "") {
      const bad = validateMode(mode);
      if (bad !== null) return badRequest(bad);
    }
    // W880: NEW sessions land in <CELESTEA_HOME>/workspaces/<ws>/sessions/
    // (ensureDir below creates the container recursively); the id stays
    // <wsName>/<dirName>. Nothing is created under the workspace root.
    const dir = this.uniqueDir(wsPath, sessionDirName(req.title, this.now()));
    try {
      ensureDir(dir);
      writeFileRaw(`${dir}/${SESSION_FILE}`, "");
    } catch (e) {
      return fail(500, `create failed: ${errText(e)}`);
    }
    try {
      // W779 T2: the ORIGINAL title (trimmed, CJK/spaces preserved) is what the
      // GUI shows; the directory name stays the sanitized+timestamped form.
      writeSessionMeta(dir, {
        title: req.title.trim(),
        model,
        prompt,
        ...(mode === "" ? {} : { mode: parseMode(mode) ?? DEFAULT_SESSION_MODE }),
      });
    } catch (e) {
      removeDir(dir);
      return fail(500, `meta write failed: ${errText(e)}`);
    }
    // W885: the directory's own basename, per the platform (a win32 realpath
    // returns backslashes, so `lastIndexOf("/")` produced the whole path —
    // W883 E2).
    return ok(`${wsName}/${baseName(dir)}`);
  }

  /**
   * `<base>`, then `<base>-1`, `<base>-2`, … until the name is free, returned
   * inside `writeRoot`.
   *
   * `writeRoot` defaults to the canonical container (`create()`), while
   * `rename`/`branch` pass the parent of the session's CURRENT dir so a session
   * is renamed inside the layer it already lives in.
   *
   * Collision detection spans EVERY live-session layer: a name already taken by
   * a legacy session must not be minted again in the canonical container (and
   * vice versa), because `list()` and `resolve()` would then have two different
   * physical dirs for one id.
   */
  uniqueDir(wsPath: string, base: string, writeRoot: string = sessionsRoot(wsPath)): string {
    const roots = [writeRoot, ...sessionRoots(wsPath)];
    let name = base;
    let n = 1;
    while (roots.some((root) => isFile(`${root}/${name}/${SESSION_FILE}`) || isDirectory(`${root}/${name}`))) {
      name = `${base}-${n}`;
      n += 1;
      if (n > 1000) break;
    }
    return `${writeRoot}/${name}`;
  }

  /**
   * Transcript projection: torn tail dropped, no pairing logic.
   *
   * W1504: memoized on `(mtimeMs, size)` (see `session-log-memo.ts`). The
   * RESULT is byte-for-byte what the unmemoized read produced — same function,
   * same input — so this is a pure cache, not a semantic change.
   */
  messages(resolved: ResolvedSession): StudioMessage[] {
    return this.transcripts.read(`${resolved.dir}/${SESSION_FILE}`);
  }

  /** POST /api/clear — truncate the log (no backup, no 409 guard). */
  truncate(resolved: ResolvedSession): StoreResult<void> {
    try {
      writeFileRaw(`${resolved.dir}/${SESSION_FILE}`, "");
      // W1504: drop the entry instead of trusting the revision guard to notice.
      // `truncate` always SHRINKS the file, so today the guard does catch every
      // observable clear (mutation M10: deleting this line keeps the integration
      // test green) — but that is an argument about size arithmetic, not a
      // property of the cache, and the entry (up to a whole projection) would
      // otherwise occupy an LRU slot until the cleared session is read again,
      // which may be never.
      this.transcripts.forget(`${resolved.dir}/${SESSION_FILE}`);
      return ok(undefined);
    } catch (e) {
      return fail(500, errText(e));
    }
  }
}
