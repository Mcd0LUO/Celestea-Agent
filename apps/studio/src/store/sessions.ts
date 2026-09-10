/**
 * Session listing / creation / transcript reader (`src/workspaces.rs:1092-1221,1459-1501`).
 *
 * A "session" is a directory directly inside a registered workspace path that
 * holds `cli-main.jsonl`. The id is `<workspace-basename>/<dir>`; the
 * `worker:<sid>` space is served by the engine (RuntimeAdapter) instead.
 *
 * The transcript endpoint is a pure projection of the append-only log
 * (`projectMessages` from `@celestea/session`), stopping at the first
 * unparsable line so a torn tail is dropped rather than reported.
 */

import { readFileSync } from "node:fs";
import { parseSessionJsonl, projectMessages } from "@celestea/session";
import type { StudioMessage } from "@celestea/core";
import { isDirectory, isFile, listEntries, statOf, writeFileRaw, removeDir, ensureDir } from "./fs-json.js";
import { badRequest, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { readSessionMeta, writeSessionMeta } from "./session-meta.js";
import { sessionDirName, sanitizeComponent, workspaceBasename } from "./session-id.js";
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

export interface SessionRow {
  id: string;
  workspace: string;
  title: string;
  model: string | null;
  size: number;
  modified: number;
  active: boolean;
  /** Present only for engine worker sessions (`workspace: "engine"`). */
  kind?: "worker";
}

export interface SessionCreateRequest {
  workspace?: string;
  title: string;
  model?: string;
  prompt?: string;
}

export class SessionsStore {
  constructor(private readonly ws: WorkspacesStore, private readonly now: () => number = Date.now) {}

  /** Every filesystem session plus the engine rows handed in by the caller. */
  list(extra: readonly SessionRow[] = []): SessionRow[] {
    const active = this.ws.activeSession();
    const rows: SessionRow[] = [];
    for (const w of this.ws.registry().workspaces) {
      const name = workspaceBasename(w.path) ?? w.path;
      for (const e of listEntries(w.path)) {
        if (!e.isDir || e.name.startsWith(".")) continue;
        const log = `${w.path}/${e.name}/${SESSION_FILE}`;
        if (!isFile(log)) continue;
        const st = statOf(log);
        rows.push({
          id: `${name}/${e.name}`,
          workspace: name,
          title: e.name,
          model: readSessionMeta(`${w.path}/${e.name}`)?.model ?? null,
          size: st?.size ?? 0,
          modified: st?.modified ?? 0,
          active: active === `${name}/${e.name}`,
        });
      }
    }
    rows.push(...extra);
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  /** Registry lookup + sanitization, no existence check. */
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
    const dir = `${wsPath}/${session}`;
    if (!dir.startsWith(`${wsPath}/`)) return badRequest(`invalid session id '${id}'`);
    return ok({ workspace: wsName, session, id: `${wsName}/${session}`, wsPath, dir });
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
    const dir = this.uniqueDir(wsPath, sessionDirName(req.title, this.now()));
    try {
      ensureDir(dir);
      writeFileRaw(`${dir}/${SESSION_FILE}`, "");
    } catch (e) {
      return fail(500, `create failed: ${errText(e)}`);
    }
    try {
      writeSessionMeta(dir, { model, prompt });
    } catch (e) {
      removeDir(dir);
      return fail(500, `meta write failed: ${errText(e)}`);
    }
    return ok(`${wsName}/${dir.slice(dir.lastIndexOf("/") + 1)}`);
  }

  /** `<base>`, then `<base>-1`, `<base>-2`, … until the name is free. */
  uniqueDir(wsPath: string, base: string): string {
    let candidate = `${wsPath}/${base}`;
    let n = 1;
    while (isFile(`${candidate}/${SESSION_FILE}`) || isDirectory(candidate)) {
      candidate = `${wsPath}/${base}-${n}`;
      n += 1;
      if (n > 1000) break;
    }
    return candidate;
  }

  /** Transcript projection: torn tail dropped, no pairing logic. */
  messages(resolved: ResolvedSession): StudioMessage[] {
    const text = readFileSync(`${resolved.dir}/${SESSION_FILE}`, "utf8");
    return projectMessages(parseSessionJsonl(text).events);
  }

  /** POST /api/clear — truncate the log (no backup, no 409 guard). */
  truncate(resolved: ResolvedSession): StoreResult<void> {
    try {
      writeFileRaw(`${resolved.dir}/${SESSION_FILE}`, "");
      return ok(undefined);
    } catch (e) {
      return fail(500, errText(e));
    }
  }
}
