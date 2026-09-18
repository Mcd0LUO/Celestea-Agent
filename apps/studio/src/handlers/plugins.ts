/**
 * W860: the host plugin inventory — `GET /api/plugins`.
 *
 * The names are NOT a constant transcribed here: `composeStudio` records what it
 * actually mounted (`StudioServices.hostPluginNames`, built with `pluginNames`
 * over the very `storePlugins` / `hostPlugins` arrays it mounts), and this
 * handler reads that record. Adding a plugin to `plugins.ts` therefore shows up
 * here automatically — there is no second list to forget.
 *
 * Honest boundary (also stated in the contract note): this covers the HOST
 * startup layer only — the store plugins (workspaces, sessions, session-ops,
 * providers, prompts) and the host singletons (bus, runtime, settings).
 * Plugins the ENGINE mounts while composing a session are not listed.
 */

import type { Hono } from "hono";
import type { RouteTable } from "../routes.js";
import type { Deps } from "./common.js";

/** One row of the inventory; `hot` is about runtime mounting, not this value. */
function pluginRows(deps: Deps): Array<{ name: string; layer: "host"; hot: boolean }> {
  return deps.hostPluginNames.map((name) => ({ name, layer: "host", hot: false }));
}

export function registerPlugins(app: Hono, deps: Deps, table: RouteTable): string[] {
  const route = table.get("get_plugins");
  app.on(route.method, route.honoPath, (c) => c.json({ ok: true, plugins: pluginRows(deps) }));
  return [route.id];
}
