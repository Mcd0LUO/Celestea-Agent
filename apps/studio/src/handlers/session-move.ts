/**
 * Session endpoints, part 2: rename / branch / compact / archive / unarchive /
 * batch-archive / batch-delete (`src/workspaces.rs:1382-1454,1580-1650`,
 * `src/compact.rs:505-519`).
 *
 * Renaming the ACTIVE session takes the busy slot and re-persists
 * `active_session`; archiving moves the directory into `.celestea-archived/`
 * (id-preserving, reversible) while deleting moves it into `.celestea-trash/`
 * with a timestamp suffix (recoverable, no longer addressable by id).
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { EngineError } from "../runtime-adapter.js";
import { strArrayField, strField, readJsonBody, failJson, storeFail, type Deps } from "./common.js";

function isActive(deps: Deps, id: string): boolean {
  return deps.workspaces.activeSession() === id.trim();
}

function registerRename(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_rename");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    if (deps.runtime.isBusy(id)) return failJson(c, 409, "turn in progress; rename applies between turns");
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const title = strField(c, read.body, "new_title");
    if (!title.ok) return title.response;
    const res = deps.sessionOps.rename(id, title.value ?? "");
    if (!res.ok) return storeFail(c, res);
    if (isActive(deps, id)) {
      const saved = deps.workspaces.setActiveSession(res.value);
      if (!saved.ok) return failJson(c, 500, `cannot persist active session: ${saved.error}`);
    }
    return c.json({ ok: true, id: res.value });
  });
  return route.id;
}

function registerBranch(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_branch");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c, false);
    if (!read.ok) return read.response;
    const title = strField(c, read.body, "title");
    if (!title.ok) return title.response;
    const res = deps.sessionOps.branch(c.req.param("id") ?? "", title.value);
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true, id: res.value });
  });
  return route.id;
}

function registerCompact(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_compact");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    if (deps.runtime.isBusy(id)) return failJson(c, 409, "turn 进行中，无法压缩");
    const resolved = deps.sessions.require(id);
    if (!resolved.ok) return storeFail(c, resolved);
    try {
      const out = await deps.runtime.compact(resolved.value.id);
      deps.bus.emit("compact", 0, { session: out.session, kept_turns: out.kept_turns ?? 0, note: out.note, rebound: out.rebound });
      const body: Record<string, unknown> = { ok: true, compacted: out.compacted, note: out.note };
      if (out.compacted) body["kept_turns"] = out.kept_turns ?? 0;
      return c.json(body);
    } catch (e) {
      return failJson(c, 500, e instanceof EngineError ? e.message : String(e));
    }
  });
  return route.id;
}

function registerMove(app: Hono, deps: Deps, table: RouteTable, id: "post_session_archive" | "post_session_unarchive"): string {
  const route = table.get(id);
  app.on(route.method, route.honoPath, (c) => {
    const res = id === "post_session_archive" ? deps.sessionOps.archive(c.req.param("id") ?? "") : deps.sessionOps.unarchive(c.req.param("id") ?? "");
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true });
  });
  return route.id;
}

function registerBatch(app: Hono, deps: Deps, table: RouteTable, id: "post_sessions_batch_archive" | "post_sessions_batch_delete"): string {
  const route = table.get(id);
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const ids = strArrayField(c, read.body, "ids");
    if (!ids.ok) return ids.response;
    if (ids.value === undefined) return failJson(c, 422, "field 'ids' must be an array of strings");
    if (id === "post_sessions_batch_archive") {
      const out = deps.sessionOps.batchArchive(ids.value);
      return c.json({ ok: true, archived: out.archived, failed: out.failed });
    }
    const out = deps.sessionOps.batchDelete(ids.value);
    return c.json({ ok: true, deleted: out.deleted, failed: out.failed });
  });
  return route.id;
}

export function registerSessionMoves(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [
    registerRename(app, deps, table),
    registerBranch(app, deps, table),
    registerCompact(app, deps, table),
    registerMove(app, deps, table, "post_session_archive"),
    registerMove(app, deps, table, "post_session_unarchive"),
    registerBatch(app, deps, table, "post_sessions_batch_archive"),
    registerBatch(app, deps, table, "post_sessions_batch_delete"),
  ];
}
