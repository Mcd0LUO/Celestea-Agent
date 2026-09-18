/**
 * W860: the session-level TOOL SWITCH endpoints (2).
 *
 *   GET /api/sessions/{id}/tools -> the stored disabled list + the EFFECTIVE
 *                                   deny (preset `toolDeny` unioned with it);
 *   PUT /api/sessions/{id}/tools -> replace the disabled list (validated,
 *                                   normalized, atomic 0600) and invalidate the
 *                                   session — the SAME next-turn-boundary hook
 *                                   `PUT /api/sessions/{id}/permission` uses.
 *
 * Storage is `store/session-tools.ts`; the union itself lives in the engine's
 * ONE grant reader (`runtime/engine-grants.ts`), so this module is the HTTP face
 * only and the reported `effective.toolDeny` is read back through that reader —
 * the endpoint cannot drift from what the next turn will actually offer.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { effectiveGrantsOf } from "../runtime/engine-grants.js";
import { nowSec } from "../store/grants-service.js";
import { errText } from "../store/result.js";
import { readSessionTools, writeSessionTools } from "../store/session-tools.js";
import { failJson, readJsonBody, storeFail, type Deps } from "./common.js";

/** The frozen response body of both endpoints (one shape, one construction). */
function sessionToolsBody(deps: Deps, session: string, dir: string): Record<string, unknown> {
  const read = readSessionTools(dir, session);
  const effective = effectiveGrantsOf(dir, session, deps.grants.env, nowSec(deps.grants));
  const warnings = [...new Set([...read.warnings, ...effective.warnings])];
  return {
    ok: true,
    session,
    disabled: [...read.disabled],
    effective: { toolDeny: [...effective.grants.toolDeny] },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

function registerGetSessionTools(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_tools");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    return c.json(sessionToolsBody(deps, resolved.value.id, resolved.value.dir));
  });
  return route.id;
}

function registerPutSessionTools(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_session_tools");
  app.on(route.method, route.honoPath, async (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const raw = body.body["disabled"];
    if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string")) {
      return failJson(c, 422, "field 'disabled' must be an array of strings");
    }
    if (raw.some((name) => (name as string).trim() === "")) {
      return failJson(c, 422, "field 'disabled' must not contain an empty tool name");
    }
    try {
      writeSessionTools(resolved.value.dir, resolved.value.id, raw as string[], nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist session tools: " + errText(e));
    }
    // W860: recompose the session at the next boundary — the same hook the
    // permission switch and the grants writer use (nothing else is touched).
    deps.runtime.invalidateSession?.(resolved.value.id);
    return c.json(sessionToolsBody(deps, resolved.value.id, resolved.value.dir));
  });
  return route.id;
}

export function registerSessionTools(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerGetSessionTools(app, deps, table), registerPutSessionTools(app, deps, table)];
}
