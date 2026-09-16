/**
 * Session endpoints, part 2: rename / branch / compact / archive / unarchive /
 * batch-archive / batch-delete (`src/workspaces.rs:1382-1454,1580-1650`,
 * `src/compact.rs:505-519`).
 *
 * Renaming the ACTIVE session takes the busy slot and re-persists
 * `active_session`; archiving moves the directory into `.celestea-archived/`
 * (id-preserving, reversible) while deleting moves it into `.celestea-trash/`
 * with a timestamp suffix (recoverable, no longer addressable by id).
 *
 * W794 (裁决: the active marker is a state label, not a protection): archiving or
 * deleting the ACTIVE session SUCCEEDS, and the two operations that take a
 * session's directory away first call `releaseSession` — the engine's own
 * cut-then-detach — so the model response in flight for that session is aborted
 * (the same cooperative cancel `POST /api/cancel` sends) and its instance is
 * released before the directory moves. Every id of a batch is cut the same way,
 * and the response contract is untouched: still one 200 with per-id `failed[]`.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { EngineError } from "../runtime-adapter.js";
import { strArrayField, strField, readJsonBody, failJson, storeFail, type Deps } from "./common.js";

function isActive(deps: Deps, id: string): boolean {
  return deps.workspaces.activeSession() === id.trim();
}

/**
 * W794: the engine-side half of taking a session's directory away.
 *
 * `releaseSession` (when the injected adapter has one) aborts the session's
 * in-flight model response and disposes THAT session's instance; it is a no-op
 * for an id with no live instance, which is why it is safe to call for every id
 * of a batch — including the unknown ones, whose per-id `failed[]` row below is
 * exactly what the contract promises.
 *
 * A failure inside the engine must not turn a deletion into a 5xx/failed row:
 * the removal (the directory move) is what the caller asked for and what the
 * per-id result reports. The instance is released — or, when the teardown threw
 * halfway, recomposed on demand by the next activate/turn — either way the
 * session is gone from the listing, which is the observable contract.
 */
async function cutEngineSession(deps: Deps, id: string): Promise<void> {
  try {
    await deps.runtime.releaseSession?.(id);
  } catch {
    // Swallowed on purpose — see above.
  }
}

function registerRename(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_rename");
  app.on(route.method, route.honoPath, async (c) => {
    // W815-5: canonical id BEFORE the busy guard (raw `%2F`/`%20` segments
    // bypassed the guard because the runtime keys instances by canonical id).
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    if (deps.runtime.isBusy(session)) return failJson(c, 409, "turn in progress; rename applies between turns");
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const title = strField(c, read.body, "new_title");
    if (!title.ok) return title.response;
    const res = deps.sessionOps.rename(session, title.value ?? "");
    if (!res.ok) return storeFail(c, res);
    if (isActive(deps, session)) {
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
    // W815-5: canonical id before the two guards.
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    if (deps.runtime.isBusy(session)) return failJson(c, 409, "turn 进行中，无法压缩");
    // W825 P0: a session with LIVE worker work is PINNED — its instance may not
    // be evicted, so compacting it would rewrite the log under a live descriptor
    // (the old fd survives the rename and every later append is lost). Refuse up
    // front, exactly like the busy guard above; the lifecycle refuses again if a
    // worker appears between this check and the eviction. `workerSessions()` only
    // reports LIVE instances, which is exactly when a descriptor can be orphaned.
    if (deps.runtime.workerSessions().some((row) => row.host_session === session && row.status === "RUNNING")) {
      return failJson(c, 409, "worker 进行中，无法压缩");
    }
    try {
      const out = await deps.runtime.compact(session);
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
  app.on(route.method, route.honoPath, async (c) => {
    const raw = c.req.param("id") ?? "";
    // W815-5: the engine cut must name the CANONICAL session. `unarchive` may
    // address an id whose live dir is absent, so `resolve` (not `require`) is the
    // right canonicalization; an unresolvable id falls through to the store's own
    // (identical) error.
    const resolved = deps.sessions.resolve(raw);
    const target = resolved.ok ? resolved.value.id : raw;
    // W794: archiving a LIVE session moves its directory away too, so it cuts the
    // same way a delete does. `unarchive` restores a directory that has no live
    // instance by construction (archiving released it) — nothing to cut.
    if (id === "post_session_archive") await cutEngineSession(deps, target);
    const res = id === "post_session_archive" ? deps.sessionOps.archive(target) : deps.sessionOps.unarchive(target);
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
    // W794: cut every id before any directory moves. The response shape is
    // unchanged — one 200, `deleted`/`archived` count plus the per-id `failed[]`
    // (unknown ids included), so the client's optimistic update can rely on it.
    // W815-5: cut each id by its CANONICAL form; the store still receives the
    // caller's ids so the per-id `failed[]` row keeps the id the caller sent.
    const canonical = ids.value.map((one) => {
      const resolved = deps.sessions.resolve(one);
      return resolved.ok ? resolved.value.id : one;
    });
    for (const one of canonical) await cutEngineSession(deps, one);
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
