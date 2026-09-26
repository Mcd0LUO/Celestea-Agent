/**
 * W895-C1 / W9108: the DISPLAY COMPONENTS table (2 endpoints).
 *
 *   GET /api/display-plugins -> `{ok:true, disabled:[...], config:{...}}`
 *   PUT /api/display-plugins -> replace the table, same body shape
 *
 * The server owns the SOURCE OF TRUTH only: it stores/returns ids and the
 * per-plugin settings. Labels and hints are the frontend's i18n and never travel
 * through this endpoint; which plugins/items exist is the frontend's knowledge
 * too, so `config` is stored **opaquely** (see store/display-plugins.ts).
 *
 * W9108 back-compat (both directions, deliberate):
 *   · an older client sends no `config` => the stored settings are PRESERVED
 *     (a switch toggle must never silently wipe the user's settings);
 *   · a newer client sends `config` => it is validated as an object of objects
 *     of strings (422 otherwise) and replaces the stored map wholesale.
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
import { readDisplayPlugins, writeDisplayPlugins, type PluginConfigMap } from "../store/display-plugins.js";
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
    config: read.config,
    ...(read.warnings.length === 0 ? {} : { warnings: read.warnings }),
  };
}

/**
 * Validate the raw `config` field. `undefined` is VALID and means "the client
 * did not send settings" (keep what is stored); anything else must be a map of
 * maps of strings.
 */
function configOrNull(raw: unknown): PluginConfigMap | null | string {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return "field 'config' must be an object of objects of strings";
  }
  const out: PluginConfigMap = {};
  for (const [id, values] of Object.entries(raw as Record<string, unknown>)) {
    if (id.trim() === "") return "field 'config' must not contain an empty plugin id";
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      return "field 'config." + id + "' must be an object of strings";
    }
    const entry: Record<string, string> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (key.trim() === "") return "field 'config." + id + "' must not contain an empty key";
      if (typeof value !== "string") return "field 'config." + id + "." + key + "' must be a string";
      entry[key] = value;
    }
    out[id] = entry;
  }
  return out;
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
    const parsed = configOrNull(body.body["config"]);
    if (typeof parsed === "string") return failJson(c, 422, parsed);
    const dir = dirname(deps.config.paths.workspacesFile);
    try {
      // Serialized: the second PUT waits for the first tmp+rename to settle.
      await writes.run(async () => {
        // W9108: no `config` in the body => keep the stored settings.
        const kept = parsed ?? readDisplayPlugins(dir).config;
        writeDisplayPlugins(dir, raw as string[], kept, nowSec(deps.grants));
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
