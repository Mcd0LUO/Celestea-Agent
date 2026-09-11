/**
 * Session endpoints, part 1: list / create / transcript / activate / context.
 *
 * `GET /api/sessions` merges two sources: session directories across every
 * registered workspace, plus the engine's in-memory worker sessions
 * (`worker:<sid>`, pseudo-workspace "engine", `kind:"worker"`), sorted by id.
 * W513: every row carries `kind` (`session` | `worker`) and `busy` (that
 * session's own turn slot), and worker rows carry `wid` / `status` / `state` /
 * `host_session`, so the UI can list and open them.
 *
 * `POST /api/sessions/{id}/activate` is "open this view + make sure the session
 * HAS a runtime": it composes the instance on demand, persists the active
 * session as a view preference, and NEVER returns 409 — a session that is
 * already running is perfectly fine (that is the point of session independence).
 *
 * W725: `GET /api/sessions/{id}/context` is the read-only "what does the model
 * actually see" snapshot. The body is assembled by the ENGINE (the agent loop's
 * own `buildRequest`, reached through `runtime.sessionContext`) and the usage
 * block is the statusline's existing `context_usage`口径 — this handler adds
 * only the 20k-per-entry wire guard.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { CapacityError, EngineError, type SessionRuntimeInfo } from "../runtime-adapter.js";
import { readSessionMeta } from "../store/session-meta.js";
import { validateModelName } from "../store/validate.js";
import type { SessionRow } from "../store/sessions.js";
import { capacityJson, failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";
import { contextPayload, type ContextUsage } from "./context-shape.js";

function workerRows(deps: Deps): SessionRow[] {
  return deps.runtime.workerSessions() as SessionRow[];
}

/** W513: `busy` is the session's OWN turn slot, never a process-wide flag. */
function withBusy(deps: Deps, row: SessionRow): SessionRow {
  return row.kind === "worker" ? row : { ...row, busy: deps.runtime.isBusy(row.id) };
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_sessions");
  app.on(route.method, route.honoPath, (c) =>
    c.json({
      sessions: deps.sessions.list(workerRows(deps)).map((row) => withBusy(deps, row)),
      active_session: deps.workspaces.activeSession(),
    }),
  );
  return route.id;
}

function registerCreate(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_sessions");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const title = strField(c, read.body, "title");
    const workspace = strField(c, read.body, "workspace");
    const model = strField(c, read.body, "model");
    const prompt = strField(c, read.body, "prompt");
    const mode = strField(c, read.body, "mode");
    for (const f of [title, workspace, model, prompt, mode]) if (!f.ok) return f.response;
    const res = deps.sessions.create({
      title: title.ok ? (title.value ?? "") : "",
      workspace: workspace.ok ? workspace.value : undefined,
      model: model.ok ? model.value : undefined,
      prompt: prompt.ok ? prompt.value : undefined,
      mode: mode.ok ? mode.value : undefined,
    });
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true, id: res.value });
  });
  return route.id;
}

function registerMessages(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_messages");
  app.on(route.method, route.honoPath, (c) => {
    const id = c.req.param("id") ?? "";
    if (id.startsWith("worker:")) {
      const messages = deps.runtime.workerMessages(id);
      if (messages === null) return failJson(c, 404, `unknown session '${id}'`);
      return c.json({ ok: true, session: id, messages });
    }
    const resolved = deps.sessions.require(id);
    if (!resolved.ok) return storeFail(c, resolved);
    return c.json({ ok: true, session: id, messages: deps.sessions.messages(resolved.value) });
  });
  return route.id;
}

/** The session-level model override problem, or null when it is usable. */
function invalidSessionModel(dir: string): string | null {
  const model = readSessionMeta(dir)?.model;
  if (model === undefined || model === "") return null;
  return validateModelName(model);
}

function registerActivate(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_activate");
  app.on(route.method, route.honoPath, (c) => {
    const id = c.req.param("id") ?? "";
    const resolved = deps.sessions.require(id);
    if (!resolved.ok) return storeFail(c, resolved);
    const bad = invalidSessionModel(resolved.value.dir);
    if (bad !== null) return failJson(c, 400, `invalid session model: ${bad}`);
    let info: SessionRuntimeInfo;
    try {
      info = deps.runtime.ensureSession(resolved.value.id);
    } catch (e) {
      if (e instanceof CapacityError) return capacityJson(c, e);
      return failJson(c, 500, `compose failed: ${e instanceof EngineError ? e.message : String(e)}`);
    }
    const saved = deps.workspaces.setActiveSession(resolved.value.id);
    if (!saved.ok) return failJson(c, 500, `cannot persist active session: ${saved.error}`);
    return c.json({ ok: true, active_session: resolved.value.id, runtime: info.runtime, busy: info.busy, rebuilt: info.rebuilt });
  });
  return route.id;
}

/**
 * GET /api/sessions/{id}/context (W725) — the engine's model-visible context.
 *
 * A session with no live instance is composed on demand (the same `entryFor`
 * path activate and a turn use), so the endpoint works on a cold session and
 * never drives a turn.
 */
function registerContext(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_context");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const session = resolved.value.id;
    try {
      const view = deps.runtime.sessionContext(session);
      return c.json(contextPayload({ session, view, usage: contextUsageOf(deps, session) }));
    } catch (e) {
      if (e instanceof CapacityError) return capacityJson(c, e);
      return failJson(c, 500, `context snapshot failed: ${e instanceof EngineError ? e.message : String(e)}`);
    }
  });
  return route.id;
}

/** The statusline's context口径 (W263) with the `method` discriminator dropped. */
function contextUsageOf(deps: Deps, session: string): ContextUsage {
  const usage = deps.runtime.statusline(session).context_usage;
  return { used: usage.used, window: usage.window, ratio: usage.ratio, estimated: usage.estimated };
}

export function registerSessions(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [
    registerList(app, deps, table),
    registerCreate(app, deps, table),
    registerMessages(app, deps, table),
    registerActivate(app, deps, table),
    registerContext(app, deps, table),
  ];
}
