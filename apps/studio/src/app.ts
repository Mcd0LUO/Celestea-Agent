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
 * The engine is injected: `opts.runtime` is a `RuntimeAdapter` (or a factory
 * over the composed stores, which is what the REAL adapter needs to resolve
 * session directories). With nothing injected the app mounts the real runtime
 * (`runtime/`), so the default deployment is the engine, not a fake; the P4 fake
 * stays available to tests through `harness.test-util.ts`.
 */

import { Hono } from "hono";
import { dirname, join } from "node:path";
import { API_ENDPOINT_COUNT, routeTable, type RegisteredRoute } from "./routes.js";
import { loadStudioConfig, type StudioConfig } from "./config.js";
import { composeStudio, type EngineFactory, type StudioServices } from "./plugins.js";
import { registerHandlers } from "./handlers/index.js";
import { assembleSystemPromptFor } from "./handlers/config-shape.js";
import { registerStatic } from "./static.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { createRealRuntimeAdapter, defaultEngineProfile } from "./runtime/index.js";

export interface StudioAppOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: StudioConfig;
  /** Engine seam (or a factory over the stores); defaults to the REAL runtime. */
  runtime?: RuntimeAdapter | EngineFactory;
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

/**
 * The production engine: the real runtime over the offline LLM seam. The factory
 * form lets the adapter resolve `<workspace>/<session>` through the session
 * store, and worker receipts land under `<data dir>/worker-results`.
 */
function defaultRuntime(config: StudioConfig, env: NodeJS.ProcessEnv): EngineFactory {
  return (stores) =>
    createRealRuntimeAdapter({
      profile: defaultEngineProfile(env, config.apiKeyEnv),
      env,
      resultsDir: join(dirname(config.paths.workspacesFile), "worker-results"),
      resolveSession: (id) => {
        const resolved = stores.sessions.resolve(id);
        return resolved.ok ? { sessionId: id, dir: resolved.value.dir } : null;
      },
      activeSession: () => stores.workspaces.activeSession(),
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

/**
 * Hand the engine the system prompt the HOST assembles (prompt registry +
 * settings override). Rust does this inside `build_gen`; here the engine is
 * primed once at startup, and the next composed generation picks it up.
 */
function primeEnginePrompt(services: StudioServices): void {
  services.runtime.primeSystemPrompt?.(assembleSystemPromptFor(services));
}

export function createStudioApp(opts: StudioAppOptions = {}): StudioApp {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadStudioConfig({ cwd: opts.cwd, env });
  const runtime = opts.runtime ?? defaultRuntime(config, env);
  const services = composeStudio({ config, runtime, now: opts.now });
  const table = routeTable();
  const app = new Hono();

  primeEnginePrompt(services);
  const endpointIds = registerHandlers(app, services, table);
  assertCoverage(table.routes, endpointIds);

  // Unknown API paths are 404 JSON, never the SPA (frozen static contract).
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  registerStatic(app, config.paths.staticRoot);

  return { app, routes: table.routes, services, endpointIds };
}
