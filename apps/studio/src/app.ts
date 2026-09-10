/**
 * Hono application factory — P4.
 *
 * Wiring order is contract order:
 *   1. compose the studio context (store plugins + bus + injected runtime);
 *   2. register all 39 contract endpoints and assert full coverage;
 *   3. `/api/*` fallback = 404 JSON (an unknown API path must NEVER fall
 *      through to the static/SPA handler);
 *   4. static files + SPA fallback from the read-only Vite build.
 *
 * The engine is injected: `opts.runtime` is a `RuntimeAdapter`. With no adapter
 * the app mounts the fake one, which is what P4's contract tests exercise.
 */

import { Hono } from "hono";
import { API_ENDPOINT_COUNT, routeTable, type RegisteredRoute } from "./routes.js";
import { loadStudioConfig, type StudioConfig } from "./config.js";
import { createFakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { composeStudio, type StudioServices } from "./plugins.js";
import { registerHandlers } from "./handlers/index.js";
import { registerStatic } from "./static.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

export interface StudioAppOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: StudioConfig;
  /** Engine seam; defaults to the fake adapter (P4). */
  runtime?: RuntimeAdapter;
  /** Deterministic clock for session dir suffixes / trash stamps. */
  now?: () => number;
}

export interface StudioApp {
  app: Hono;
  routes: RegisteredRoute[];
  services: StudioServices;
  /** Contract ids bound by handlers (39 on success). */
  endpointIds: string[];
}

function defaultRuntime(config: StudioConfig, env: NodeJS.ProcessEnv): RuntimeAdapter {
  return createFakeRuntimeAdapter({
    profile: {
      model: env["CELESTEA_MODEL"] ?? "unknown",
      base_url: env["CELESTEA_BASE_URL"] ?? "http://127.0.0.1:3001/v1",
      api_key_env: config.apiKeyEnv,
    },
  });
}

/** Every contract endpoint must be bound exactly once, or startup fails. */
function assertCoverage(routes: readonly RegisteredRoute[], ids: readonly string[]): void {
  const bound = new Set(ids);
  const missing = routes.filter((r) => !bound.has(r.id)).map((r) => r.id);
  if (missing.length > 0) throw new Error(`unbound contract endpoints: ${missing.join(", ")}`);
  if (ids.length !== API_ENDPOINT_COUNT) {
    throw new Error(`expected ${API_ENDPOINT_COUNT} contract endpoints, got ${ids.length}`);
  }
}

export function createStudioApp(opts: StudioAppOptions = {}): StudioApp {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadStudioConfig({ cwd: opts.cwd, env });
  const runtime = opts.runtime ?? defaultRuntime(config, env);
  const services = composeStudio({ config, runtime, now: opts.now });
  const table = routeTable();
  const app = new Hono();

  const endpointIds = registerHandlers(app, services, table);
  assertCoverage(table.routes, endpointIds);

  // Unknown API paths are 404 JSON, never the SPA (frozen static contract).
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  registerStatic(app, config.paths.staticRoot);

  return { app, routes: table.routes, services, endpointIds };
}
