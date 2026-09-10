/**
 * Session endpoints, part 1: list / create / transcript / activate
 * (`src/workspaces.rs:1092-1221,1323-1374,1459-1501`).
 *
 * `GET /api/sessions` merges two sources: session directories across every
 * registered workspace, plus the engine's in-memory worker sessions
 * (`worker:<sid>`, pseudo-workspace "engine", `kind:"worker"`), sorted by id.
 * Activation is the only path that re-composes the engine generation, and it
 * is the only place a session-level `model` override is honored.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { EngineError } from "../runtime-adapter.js";
import { readSessionMeta } from "../store/session-meta.js";
import { validateModelName } from "../store/validate.js";
import type { SessionRow } from "../store/sessions.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

function workerRows(deps: Deps): SessionRow[] {
  return deps.runtime.workerSessions() as SessionRow[];
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_sessions");
  app.on(route.method, route.honoPath, (c) =>
    c.json({ sessions: deps.sessions.list(workerRows(deps)), active_session: deps.workspaces.activeSession() }),
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
    for (const f of [title, workspace, model, prompt]) if (!f.ok) return f.response;
    const res = deps.sessions.create({
      title: title.ok ? (title.value ?? "") : "",
      workspace: workspace.ok ? workspace.value : undefined,
      model: model.ok ? model.value : undefined,
      prompt: prompt.ok ? prompt.value : undefined,
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

function registerActivate(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_session_activate");
  app.on(route.method, route.honoPath, async (c) => {
    if (deps.runtime.isBusy()) return failJson(c, 409, "turn in progress; activate applies between turns");
    const id = c.req.param("id") ?? "";
    const resolved = deps.sessions.require(id);
    if (!resolved.ok) return storeFail(c, resolved);
    const model = readSessionMeta(resolved.value.dir)?.model;
    if (model !== undefined && model !== "") {
      const bad = validateModelName(model);
      if (bad !== null) return failJson(c, 400, `invalid session model: ${bad}`);
      try {
        await deps.runtime.configure({ model });
      } catch (e) {
        return failJson(c, 500, `compose failed: ${e instanceof EngineError ? e.message : String(e)}`);
      }
    }
    const saved = deps.workspaces.setActiveSession(resolved.value.id);
    if (!saved.ok) return failJson(c, 500, `cannot persist active session: ${saved.error}`);
    return c.json({ ok: true, active_session: resolved.value.id });
  });
  return route.id;
}

export function registerSessions(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerCreate(app, deps, table), registerMessages(app, deps, table), registerActivate(app, deps, table)];
}
