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
 * session directories AND the provider target). With nothing injected the app
 * mounts the real runtime (`runtime/`) wired to the real LLM, so the default
 * deployment is the engine over a live provider, not a fake; the P4 fake stays
 * available to tests through `harness.test-util.ts`.
 *
 * W743 (W732 A1): the engine assembly itself lives in `createStudioEngine()`
 * below — the ONE factory — and `defaultRuntime()` is just the production
 * binding of its injected values. The real-engine test harness
 * (`runtime/test-util.ts`) calls the same function, so "the tests run the real
 * engine" now also means "the tests run the real grants boundary and the real
 * usage ledger".
 */

import { Hono } from "hono";
import { dirname, join } from "node:path";
import type { Llm } from "@celestea/core";
import { createUsageLedgerFile, type Profile } from "@celestea/runtime";
import { API_ENDPOINT_COUNT, routeTable, type RegisteredRoute } from "./routes.js";
import { loadStudioConfig, type StudioConfig } from "./config.js";
import { composeStudio, type EngineFactory, type StudioServices } from "./plugins.js";
import { registerHandlers } from "./handlers/index.js";
import { assembleSystemPromptFor } from "./handlers/config-shape.js";
import { registerStatic } from "./static.js";
import type { EngineProfile, RuntimeAdapter } from "./runtime-adapter.js";
import type { StoreServices } from "./plugins.js";
import { DEFAULT_SESSION_MODE } from "./store/mode.js";
import { readSessionMeta, type SessionMeta } from "./store/session-meta.js";
import { createSessionGrants } from "./runtime/session-grants.js";
import { grantsEnv } from "./store/grants-service.js";
import { createRealRuntimeAdapter, startupEngineProfile } from "./runtime/index.js";
import { recoverActiveSessionOnBoot } from "./runtime/boot-recovery.js";

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
 * Everything ONE engine build needs, resolved from the composed stores.
 *
 * W743 (closes W732 A1): this is the SINGLE engine assembly. The production app
 * and the real-engine test harness both call it, so the two can no longer drift
 * apart — the only thing a caller injects is PATHS, ENV and the LLM/profile
 * seam; grants, the usage ledger, the worker receipt dir, session resolution and
 * the three per-session profile hooks are assembled here exactly once.
 *
 * Note on placement: the factory cannot live in `packages/runtime` because it
 * builds the HOST's adapter (`real-runtime-adapter.ts`, an L3 module) and needs
 * the composed stores — `packages/*` must never depend on `apps/*`
 * (ARCHITECTURE.md §1, K1/K2). It therefore stays in the L3 composition root and
 * every other assembly (tests included) reuses THIS function.
 *
 * The dependency is a FUNCTION of `stores` because the engine factory runs
 * INSIDE `composeStudio`: the test harness only learns its throwaway data dir
 * once the workspace it registered is mounted.
 */
export interface StudioEngineInput {
  /** The data file the host ACTUALLY composed (`<data dir>/workspaces.json`). */
  workspacesFile: string;
  /** Process environment (provider keys, tool roots, resource caps, grants). */
  env: NodeJS.ProcessEnv;
  /** Startup engine profile. */
  profile: EngineProfile;
  /** Provider row the profile came from, recorded as the ledger's `provider`. */
  providerLabel: string | null;
  /** Late-bound host services (per-session prompt assembly; see [HostRef]). */
  host: HostRef;
  /**
   * LLM seam override. Absent = the live provider assembled from the profile
   * (production); the real-engine tests inject the deterministic OFFLINE engine.
   */
  llm?: (profile: Profile) => Llm;
}

/** Resolves the injected values of one engine build from the composed stores. */
export type StudioEngineDeps = (stores: StoreServices) => StudioEngineInput;

/**
 * The ONE engine factory. The factory form is what makes the production path
 * possible — providers.json is composed before the engine, so the startup
 * profile is resolved from the operator's provider registry — and it is also
 * what the test harness reuses. Worker receipts land under
 * `<data dir>/worker-results`.
 */
export function createStudioEngine(deps: StudioEngineDeps): EngineFactory {
  return (stores) => {
    const input = deps(stores);
    const dataDir = dirname(input.workspacesFile);
    return createRealRuntimeAdapter({
      profile: input.profile,
      env: input.env,
      resultsDir: join(dataDir, "worker-results"),
      // W516: every instance reads its session's grants at compose time. The env
      // is pinned to the workspaces file the host ACTUALLY composed, so the
      // fail-closed root rules resolve the same data dir (grants-service.ts).
      grants: createSessionGrants({ dataDir, env: grantsEnv(input.env, input.workspacesFile) }),
      // W728 §3 P0: ONE append-only usage ledger per process (`<data dir>`),
      // shared by every session instance; `CELESTEA_USAGE_LEDGER=off` disables.
      ledgerFile: createUsageLedgerFile({ dataDir, env: input.env }),
      providerLabel: input.providerLabel,
      ...(input.llm === undefined ? {} : { llm: input.llm }),
      resolveSession: (id) => {
        const resolved = stores.sessions.resolve(id);
        return resolved.ok ? { sessionId: id, dir: resolved.value.dir } : null;
      },
      // W513: the session-level model override is applied to that session's own
      // instance (it no longer rewrites a global engine profile).
      sessionModel: (id) => sessionMetaAt(stores, id)?.model ?? null,
      // W729 (§5.1 #4, R3): the session's mode is fixed at creation and the
      // PROMPT assembly is therefore per instance, not per process. Both hooks
      // read `session.json` of the session being composed, so a standard and an
      // execution session in the same process get their own system prompt.
      sessionMode: (id) => sessionMetaAt(stores, id)?.mode ?? null,
      sessionSystemPrompt: (id) => sessionPromptAt(input.host, stores, id),
    });
  };
}

/** The production engine: [createStudioEngine] over the REAL provider registry. */
function defaultRuntime(config: StudioConfig, env: NodeJS.ProcessEnv, host: HostRef): EngineFactory {
  return createStudioEngine((stores) => {
    const startup = startupEngineProfile(stores.providers, env, config.apiKeyEnv);
    return {
      workspacesFile: config.paths.workspacesFile,
      env,
      profile: startup.profile,
      providerLabel: startup.target.provider_id,
      host,
    };
  });
}

/** `session.json` of one session (null when the id does not resolve). */
function sessionMetaAt(stores: StoreServices, id: string): SessionMeta | null {
  const resolved = stores.sessions.resolve(id);
  return resolved.ok ? readSessionMeta(resolved.value.dir) : null;
}

/**
 * W729/K8: the per-session prompt override applies ONLY to a session that
 * DECLARED a mode. A session without `session.json.mode` keeps the primed base
 * prompt — the exact pre-W729 code path — so "no mode key" really is
 * byte-for-byte the old behaviour, while every mode-bearing session gets its own
 * assembly (which is the whole point of R3).
 */
function sessionPromptAt(host: HostRef, stores: StoreServices, id: string): string | null {
  if (sessionMetaAt(stores, id)?.mode === undefined || host.services === null) return null;
  return assembleSystemPromptFor(host.services, id);
}

/**
 * W729: the host services exist only AFTER `composeStudio` ran, but the engine
 * factory runs INSIDE it (the adapter is built while the stores are mounted).
 * The per-session prompt hook is therefore late-bound through this ref; it is
 * only ever called while composing a NAMED session, which happens on the first
 * turn / activate — long after startup filled the ref in.
 */
export interface HostRef {
  services: StudioServices | null;
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
 * Hand the engine the BASE system prompt the HOST assembles (prompt registry +
 * settings override). Rust does this inside `build_gen`; here the engine is
 * primed once at startup and the next composed generation picks it up.
 *
 * W729: this primes the DEFAULT (detached) generation only. A named session's
 * prompt is assembled per instance through the composer's `sessionSystemPrompt`
 * hook, so priming can never leak one session's mode into another's instance.
 */
function primeEnginePrompt(services: StudioServices): void {
  // The BASE (detached) generation is always the DEFAULT mode, whatever mode the
  // session left active in workspaces.json happens to declare.
  services.runtime.primeSystemPrompt?.(assembleSystemPromptFor(services, null, DEFAULT_SESSION_MODE));
}

export function createStudioApp(opts: StudioAppOptions = {}): StudioApp {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadStudioConfig({ cwd: opts.cwd, env });
  // Filled in right after composition; the engine reads it lazily (see HostRef).
  const host: HostRef = { services: null };
  const runtime = opts.runtime ?? defaultRuntime(config, env, host);
  const services = composeStudio({ config, runtime, env, now: opts.now });
  host.services = services;
  const table = routeTable();
  const app = new Hono();

  primeEnginePrompt(services);
  // E §1.3 P0 ③: close the turn the previous process died inside — BEFORE any
  // instance of the active session is composed, because composing one replays the
  // log and takes its turn counter from it. A clean log, a missing checkpoint or
  // an unresolvable active session are all no-ops (fail-safe).
  recoverActiveSessionOnBoot({ workspaces: services.workspaces, sessions: services.sessions });
  const endpointIds = registerHandlers(app, services, table);
  assertCoverage(table.routes, endpointIds);

  // Unknown API paths are 404 JSON, never the SPA (frozen static contract).
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
  registerStatic(app, config.paths.staticRoot);

  return { app, routes: table.routes, services, endpointIds };
}
