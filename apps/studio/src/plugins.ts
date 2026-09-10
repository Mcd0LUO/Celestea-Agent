/**
 * Studio store plugins — "everything is a plugin" at the host layer.
 *
 * Each store is mounted as a `Plugin` that `provide`s exactly one service into
 * the shared `Context`; nothing is `new`ed by a consumer, so a test can mount a
 * store over a temp directory and the handlers never learn the difference.
 * Mount order is semantic (a later plugin consumes an earlier service):
 *
 *   workspaces  -> registry (also the workspace-name -> path lookup)
 *   sessions    -> session scan / resolve / transcript (consumes workspaces)
 *   sessionOps  -> rename / branch / archive / trash (consumes both)
 *   providers   -> providers.json + public_view
 *   prompts     -> prompts.json registries
 *   bus         -> the SSE bus (the RuntimeAdapter attaches to it)
 *   runtime     -> the injected RuntimeAdapter (engine seam)
 *   settings    -> host-side overrides (system_prompt / base_url)
 */

import { Context, definePlugin, mountPlugins, type Plugin } from "@celestea/core";
import { createStudioBus, type StudioBus } from "./sse.js";
import { SessionOps } from "./store/session-ops.js";
import { SessionsStore } from "./store/sessions.js";
import { ProvidersStore } from "./store/providers.js";
import { PromptsStore } from "./store/prompts.js";
import { WorkspacesStore } from "./store/workspaces.js";
import { StudioSettings } from "./settings.js";
import type { StudioConfig } from "./config.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";

/** Service tokens: the typed keys of the studio Context. */
export const WORKSPACES_SERVICE = "studio.workspaces";
export const SESSIONS_SERVICE = "studio.sessions";
export const SESSION_OPS_SERVICE = "studio.sessionOps";
export const PROVIDERS_SERVICE = "studio.providers";
export const PROMPTS_SERVICE = "studio.prompts";
export const BUS_SERVICE = "studio.bus";
export const RUNTIME_SERVICE = "studio.runtime";
export const SETTINGS_SERVICE = "studio.settings";

export interface ComposeInput {
  config: StudioConfig;
  /** Injected engine seam; defaults to the fake adapter at the app edge. */
  runtime: RuntimeAdapter;
  /** Deterministic clock for tests (session dir suffixes, trash stamps). */
  now?: () => number;
}

export interface StudioServices {
  ctx: Context;
  config: StudioConfig;
  bus: StudioBus;
  runtime: RuntimeAdapter;
  settings: StudioSettings;
  workspaces: WorkspacesStore;
  sessions: SessionsStore;
  sessionOps: SessionOps;
  providers: ProvidersStore;
  prompts: PromptsStore;
}

/**
 * Store plugins. `workspaces/sessions/sessionOps` share one clock so a test can
 * pin the `<secs>.<nanos>` suffix of a created session directory.
 */
export function storePlugins(config: StudioConfig, now: () => number): Plugin[] {
  return [
    definePlugin("studio/workspaces", (ctx) => ctx.provide(WORKSPACES_SERVICE, new WorkspacesStore(config.paths.workspacesFile))),
    definePlugin("studio/sessions", (ctx) =>
      ctx.provide(SESSIONS_SERVICE, new SessionsStore(ctx.require(WORKSPACES_SERVICE), now)),
    ),
    definePlugin("studio/session-ops", (ctx) =>
      ctx.provide(SESSION_OPS_SERVICE, new SessionOps(ctx.require(WORKSPACES_SERVICE), ctx.require(SESSIONS_SERVICE), now)),
    ),
    definePlugin("studio/providers", (ctx) => ctx.provide(PROVIDERS_SERVICE, new ProvidersStore(config.paths.providersFile))),
    definePlugin("studio/prompts", (ctx) => ctx.provide(PROMPTS_SERVICE, new PromptsStore(config.paths.promptsFile))),
  ];
}

/** Bus + runtime + settings: the three host singletons. */
export function hostPlugins(input: ComposeInput, bus: StudioBus): Plugin[] {
  return [
    definePlugin("studio/bus", (ctx) => ctx.provide(BUS_SERVICE, bus)),
    definePlugin("studio/runtime", (ctx) => ctx.provide(RUNTIME_SERVICE, input.runtime)),
    definePlugin("studio/settings", (ctx) => ctx.provide(SETTINGS_SERVICE, new StudioSettings())),
  ];
}

/** Compose the studio context; the caller owns the runtime adapter instance. */
export function composeStudio(input: ComposeInput): StudioServices {
  const ctx = Context.root();
  const bus = createStudioBus({ statusline: () => input.runtime.statusline() });
  input.runtime.attach(bus);
  mountPlugins(ctx, [...storePlugins(input.config, input.now ?? Date.now), ...hostPlugins(input, bus)]);
  return {
    ctx,
    config: input.config,
    bus,
    runtime: ctx.require(RUNTIME_SERVICE),
    settings: ctx.require(SETTINGS_SERVICE),
    workspaces: ctx.require(WORKSPACES_SERVICE),
    sessions: ctx.require(SESSIONS_SERVICE),
    sessionOps: ctx.require(SESSION_OPS_SERVICE),
    providers: ctx.require(PROVIDERS_SERVICE),
    prompts: ctx.require(PROMPTS_SERVICE),
  };
}
