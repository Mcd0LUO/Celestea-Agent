/**
 * W855 #5: the built-in plugin inventory.
 *
 * One row per PRODUCTION mount site under any `packages/<pkg>/src` tree and
 * under `apps/studio/src` (tests, fakes and test-utils excluded):
 *
 *   - `kind: "plugin"`  -> a `definePlugin(...)` call. `nameArg` is the first
 *     argument verbatim (a string literal, or the factory parameter name);
 *     `defaultName` is the runtime name when that parameter is omitted.
 *   - `kind: "provide"` -> a `ctx.provide(...)`/`scope.provide(...)` call that
 *     is NOT inside a `definePlugin` body (the compose root's own mounts).
 *
 * `tests/builtin-plugins.test.ts` re-derives both sets with the TypeScript
 * parser and fails in EITHER direction: a production call site missing from
 * this file, or a row here whose call site no longer exists.
 *
 * Naming inconsistencies are RECORDED here (see `note`), never fixed.
 */

export type MountLayer = "L0" | "L1" | "L2" | "L3";

export interface PluginMountRow {
  kind: "plugin";
  /** Repo-relative POSIX path. */
  file: string;
  layer: MountLayer;
  /** The `definePlugin` first argument, verbatim (`name`, `TOOLS_PLUGIN_NAME`, or a literal). */
  nameArg: string;
  /** Effective name when `nameArg` is a factory parameter (or the literal itself). */
  defaultName: string;
  viaDefinePlugin: true;
  /** Tokens provided inside the plugin body, source order (aggregate over duplicate `nameArg`s). */
  provides: readonly string[];
  note?: string;
}

export interface DirectProvideRow {
  kind: "provide";
  file: string;
  layer: MountLayer;
  token: string;
  viaDefinePlugin: false;
  note: string;
}

export type MountRow = PluginMountRow | DirectProvideRow;

/** Every production plugin mount and every direct compose-root provide. */
export const BUILTIN_MOUNTS: readonly MountRow[] = [
  // --- L1 packages -------------------------------------------------------
  {
    kind: "plugin",
    file: "packages/agent-loop/src/plugin.ts",
    layer: "L1",
    nameArg: "name",
    defaultName: "celestea.agent-loop.DefaultAgentLoop",
    viaDefinePlugin: true,
    provides: ["AGENT_LOOP_SERVICE"],
    note: "agentLoopPlugin(config, bindings, name): the third parameter defaults the mount name.",
  },
  {
    kind: "plugin",
    file: "packages/session/src/plugin.ts",
    layer: "L1",
    nameArg: "name",
    defaultName: "celestea.session.InMemorySessionLog",
    viaDefinePlugin: true,
    provides: ["SESSION_LOG_SERVICE"],
    note: "inMemorySessionLogPlugin(name, log); TWO factories in this file share the `name` parameter name.",
  },
  {
    kind: "plugin",
    file: "packages/session/src/plugin.ts",
    layer: "L1",
    nameArg: "name",
    defaultName: "celestea.session.PersistentSessionLog",
    viaDefinePlugin: true,
    provides: ["SESSION_LOG_SERVICE"],
    note: "persistentSessionLogPlugin(cfg, onOpen, name): same `nameArg` as the row above.",
  },
  {
    kind: "plugin",
    file: "packages/tools/src/plugin.ts",
    layer: "L1",
    nameArg: "TOOLS_PLUGIN_NAME",
    defaultName: "celestea.tools",
    viaDefinePlugin: true,
    provides: ["TOOL_REGISTRY_SERVICE", "SANDBOX_SERVICE", "PROCESS_REGISTRY_SERVICE"],
    note: "TOOLS_PLUGIN_NAME = \"celestea.tools\" (dotted FQN style).",
  },
  {
    kind: "plugin",
    file: "packages/workers/src/plugin.ts",
    layer: "L1",
    nameArg: "name",
    defaultName: "celestea.workers.Workers",
    viaDefinePlugin: true,
    provides: ["WORKER_REGISTRY_SERVICE"],
    note: "workersPlugin(opts): opts.name defaults the mount name.",
  },
  {
    kind: "plugin",
    file: "packages/workers/src/watchdog.ts",
    layer: "L1",
    nameArg: "name",
    defaultName: "celestea.workers.Watchdog",
    viaDefinePlugin: true,
    provides: ["WATCHDOG_SERVICE"],
    note: "watchdogPlugin(opts): opts.name defaults the mount name.",
  },
  // --- L3 studio host ----------------------------------------------------
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/workspaces", defaultName: "studio/workspaces", viaDefinePlugin: true, provides: ["WORKSPACES_SERVICE"], note: "slash separator (vs the dotted package names)." },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/sessions", defaultName: "studio/sessions", viaDefinePlugin: true, provides: ["SESSIONS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/session-ops", defaultName: "studio/session-ops", viaDefinePlugin: true, provides: ["SESSION_OPS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/providers", defaultName: "studio/providers", viaDefinePlugin: true, provides: ["PROVIDERS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/prompts", defaultName: "studio/prompts", viaDefinePlugin: true, provides: ["PROMPTS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/bus", defaultName: "studio/bus", viaDefinePlugin: true, provides: ["BUS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/runtime", defaultName: "studio/runtime", viaDefinePlugin: true, provides: ["RUNTIME_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/plugins.ts", layer: "L3", nameArg: "studio/settings", defaultName: "studio/settings", viaDefinePlugin: true, provides: ["SETTINGS_SERVICE"] },
  { kind: "plugin", file: "apps/studio/src/runtime/engine-plugins.ts", layer: "L3", nameArg: "studio.engine.tools", defaultName: "studio.engine.tools", viaDefinePlugin: true, provides: ["TOOL_REGISTRY_SERVICE", "SANDBOX_SERVICE", "PROCESS_REGISTRY_SERVICE", "USER_QUESTION_SERVICE"], note: "dot separator again (studio.engine.tools vs studio/workspaces)." },
  { kind: "plugin", file: "apps/studio/src/runtime/engine-plugins.ts", layer: "L3", nameArg: "name", defaultName: "studio.engine.llm", viaDefinePlugin: true, provides: ["LLM_SERVICE"], note: "engineLlmPlugin(llm, name): the second parameter defaults the mount name." },
  // --- direct compose-root provides (no definePlugin body) ---------------
  { kind: "provide", file: "packages/runtime/src/compose.ts", layer: "L2", token: "EVENT_BUS_SERVICE", viaDefinePlugin: false, note: "compose() mounts its own default event bus." },
  { kind: "provide", file: "packages/runtime/src/compose.ts", layer: "L2", token: "USAGE_TRACKER_SERVICE", viaDefinePlugin: false, note: "compose() always provides the usage tracker." },
  { kind: "provide", file: "packages/runtime/src/compose.ts", layer: "L2", token: "STATUS_TRACKER_SERVICE", viaDefinePlugin: false, note: "compose() always provides the status tracker." },
  { kind: "provide", file: "packages/runtime/src/compose.ts", layer: "L2", token: "RETENTION_SERVICE", viaDefinePlugin: false, note: "compose() provides the tool-result retention policy (W855 #8)." },
  { kind: "provide", file: "packages/runtime/src/runtime.ts", layer: "L2", token: "EVENT_BUS_SERVICE", viaDefinePlugin: false, note: "Runtime re-provisions a bus only when the Context has none." },
  { kind: "provide", file: "packages/runtime/src/session-binding.ts", layer: "L2", token: "SESSION_LOG_SERVICE", viaDefinePlugin: false, note: "bindingFor() provides the session log directly." },
  { kind: "provide", file: "packages/runtime/src/turn-runner.ts", layer: "L2", token: "TURN_ABORT_SERVICE", viaDefinePlugin: false, note: "per-turn child scope." },
  { kind: "provide", file: "packages/runtime/src/turn-runner.ts", layer: "L2", token: "TURN_SINK_SERVICE", viaDefinePlugin: false, note: "per-turn child scope." },
  { kind: "provide", file: "packages/runtime/src/turn-runner.ts", layer: "L2", token: "USAGE_TRACKER_SERVICE", viaDefinePlugin: false, note: "per-turn child scope re-exports the tracker." },
  { kind: "provide", file: "packages/workers/src/driver.ts", layer: "L1", token: "LLM_SERVICE", viaDefinePlugin: false, note: "makeDriverContext() seeds a worker-driving scope." },
  { kind: "provide", file: "packages/workers/src/driver.ts", layer: "L1", token: "TOOL_REGISTRY_SERVICE", viaDefinePlugin: false, note: "makeDriverContext() seeds a worker-driving scope." },
  { kind: "provide", file: "packages/workers/src/driver.ts", layer: "L1", token: "SESSION_LOG_SERVICE", viaDefinePlugin: false, note: "makeDriverContext() seeds a worker-driving scope." },
  { kind: "provide", file: "packages/workers/src/driver.ts", layer: "L1", token: "AGENT_LOOP_SERVICE", viaDefinePlugin: false, note: "makeDriverContext() seeds a worker-driving scope." },
];

/** package/app root -> architecture tier (the depcruise tiers). */
export const PACKAGE_LAYER: Readonly<Record<string, MountLayer>> = {
  "packages/core": "L0",
  "packages/llm": "L1",
  "packages/session": "L1",
  "packages/agent-loop": "L1",
  "packages/tools": "L1",
  "packages/workers": "L1",
  "packages/runtime": "L2",
  "apps/studio": "L3",
};

/** The tier of a repo-relative file, or null when it is outside the map. */
export function layerOf(file: string): MountLayer | null {
  for (const [prefix, layer] of Object.entries(PACKAGE_LAYER)) {
    if (file === prefix || file.startsWith(prefix + "/")) return layer;
  }
  return null;
}
