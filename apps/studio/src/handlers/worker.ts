/**
 * Worker orchestration — `src/api.rs:437-503`.
 *
 * The three endpoints proxy the engine's worker tools so the HTTP surface and
 * the agent tool surface cannot drift. A tool-level refusal (`{ok:false,…}`) is
 * still HTTP 200; only a HARD dispatch failure is 502, and a tool that returns
 * no value at all is 500.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { failJson, readJsonBody, strField, type Deps } from "./common.js";

function registerSpawn(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_worker_spawn");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const wid = strField(c, read.body, "wid");
    const brief = strField(c, read.body, "brief");
    const title = strField(c, read.body, "title");
    const model = strField(c, read.body, "model");
    const reportTo = strField(c, read.body, "report_to");
    for (const f of [wid, brief, title, model, reportTo]) if (!f.ok) return f.response;
    if ((wid.ok ? wid.value : undefined) === undefined || (brief.ok ? brief.value : undefined) === undefined) {
      return failJson(c, 422, "fields 'wid' and 'brief' are required");
    }
    const out = await deps.runtime.workerSpawn({
      wid: wid.ok ? (wid.value as string) : "",
      brief: brief.ok ? (brief.value as string) : "",
      title: title.ok ? title.value : undefined,
      model: model.ok ? model.value : undefined,
      report_to: reportTo.ok ? reportTo.value : undefined,
    });
    if (out.ok) return c.json({ ok: true, sessionId: out.sessionId, title: out.title, wid: out.wid });
    if (out.error === undefined && out.value === undefined) return failJson(c, 500, "tool returned no value");
    return failJson(c, 502, out.error ?? "worker spawn failed", out.value === undefined ? undefined : { value: out.value });
  });
  return route.id;
}

function registerSend(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_worker_send");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const target = strField(c, read.body, "target");
    const content = strField(c, read.body, "content");
    for (const f of [target, content]) if (!f.ok) return f.response;
    if ((target.ok ? target.value : undefined) === undefined || (content.ok ? content.value : undefined) === undefined) {
      return failJson(c, 422, "fields 'target' and 'content' are required");
    }
    const out = await deps.runtime.workerSend({ target: target.ok ? (target.value as string) : "", content: content.ok ? (content.value as string) : "" });
    return c.json(out);
  });
  return route.id;
}

function registerStatus(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_worker_status");
  app.on(route.method, route.honoPath, (c) => {
    const wid = c.req.query("wid");
    return c.json(deps.runtime.workerStatus(wid === undefined || wid === "" ? undefined : wid));
  });
  return route.id;
}

export function registerWorker(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerSpawn(app, deps, table), registerSend(app, deps, table), registerStatus(app, deps, table)];
}
