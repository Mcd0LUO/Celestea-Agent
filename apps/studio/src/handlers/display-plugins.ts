/**
 * W895-C1: the DISPLAY COMPONENTS enabled table (2 endpoints).
 *
 *   GET /api/display-plugins -> `{ok:true, disabled:[...]}`
 *   PUT /api/display-plugins -> replace the disabled list, same body shape
 *
 * The server owns the SOURCE OF TRUTH only: it stores/returns ids. Labels and
 * hints are the frontend's i18n and never travel through this endpoint. The
 * payload mirrors the retired localStorage value (a disabled-id array), so the
 * one-time client migration is an identity mapping.
 *
 * Storage is `store/display-plugins.ts`; the write is serialized through a
 * dedicated [SerialQueue] so two concurrent PUTs cannot interleave their
 * tmp+rename and lose the later update.
 */

import type { Hono } from "hono";
import { dirname } from "node:path";
import type { RouteTable } from "../routes.js";
import { SerialQueue } from "../serial-queue.js";
import { nowSec } from "../store/grants-service.js";
import { readDisplayPlugins, writeDisplayPlugins } from "../store/display-plugins.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, type Deps } from "./common.js";

/** One queue per process: the display-plugins writes are a single resource. */
const writes = new SerialQueue();

/** The frozen response body of both endpoints (one shape, one construction). */
function bodyOf(deps: Deps): Record<string, unknown> {
  const read = readDisplayPlugins(dirname(deps.config.paths.workspacesFile));
  return {
    ok: true,
    disabled: [...read.disabled],
    ...(read.warnings.length === 0 ? {} : { warnings: read.warnings }),
  };
}

function registerGet(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_display_plugins");
  app.on(route.method, route.honoPath, (c) => c.json(bodyOf(deps)));
  return route.id;
}

function registerPut(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_display_plugins");
  app.on(route.method, route.honoPath, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const raw = body.body["disabled"];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
      return failJson(c, 422, "field 'disabled' must be an array of strings");
    }
    if (raw.some((id) => (id as string).trim() === "")) {
      return failJson(c, 422, "field 'disabled' must not contain an empty id");
    }
    const dir = dirname(deps.config.paths.workspacesFile);
    try {
      // Serialized: the second PUT waits for the first tmp+rename to settle.
      await writes.run(async () => {
        writeDisplayPlugins(dir, raw as string[], nowSec(deps.grants));
      });
    } catch (e) {
      return failJson(c, 500, "cannot persist display plugins: " + errText(e));
    }
    return c.json(bodyOf(deps));
  });
  return route.id;
}

export function registerDisplayPlugins(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerGet(app, deps, table), registerPut(app, deps, table)];
}
