/**
 * The tools plugin — `mount(ctx)` is the only installation path (nothing
 * self-registers at runtime), and it publishes exactly three services:
 *
 * - `ToolRegistryService` → the assembled registry (schema → guard → execute);
 * - `SandboxService`      → the execution boundary `run_shell` orchestrates;
 * - `ProcessRegistryService` → the session-scoped background process registry.
 *
 * The guard chain is mounted here because **order is security semantics**: the
 * path whitelist must run before any tool execution, and `CELESTEA_TOOL_GUARD=0`
 * is the only (explicit, documented) way to skip it.
 */

import {
  definePlugin,
  SANDBOX_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type Context,
  type Plugin,
  type Sandbox,
  type Tool,
  type ToolGuard,
} from "@celestea/core";

import { builtinTools } from "./builtin.js";
import { mountProductionGuards } from "./guard/path-guard.js";
import { PROCESS_REGISTRY_SERVICE, ProcessRegistry } from "./process/registry.js";
import { ToolRegistryImpl } from "./registry.js";
import { selectSandbox } from "./sandbox/provider.js";

export const TOOLS_PLUGIN_NAME = "celestea.tools";

export interface ToolsPluginOptions {
  /** Tool set; default: the six builtins sharing [processes] + [sandbox]. */
  tools?: readonly Tool[];
  sandbox?: Sandbox;
  processes?: ProcessRegistry;
  /** Guard chain override: `null` disables guarding, `undefined` = env default. */
  guard?: ToolGuard | null;
  env?: NodeJS.ProcessEnv;
}

/** The wired handles a compose root keeps after mounting the plugin. */
export interface ToolAssembly {
  registry: ToolRegistryImpl;
  sandbox: Sandbox;
  processes: ProcessRegistry;
  guardMounted: boolean;
}

/** Build the tool assembly without mounting it (compose roots / tests). */
export function assembleTools(options: ToolsPluginOptions = {}): ToolAssembly {
  const env = options.env ?? process.env;
  const processes = options.processes ?? new ProcessRegistry();
  const sandbox = options.sandbox ?? selectSandbox({ env });
  const registry = new ToolRegistryImpl();
  for (const tool of options.tools ?? builtinTools({ sandbox, processes })) registry.register(tool);

  let guardMounted = false;
  if (options.guard === null) guardMounted = false;
  else if (options.guard !== undefined) {
    registry.addGuard(options.guard);
    guardMounted = true;
  } else guardMounted = mountProductionGuards(registry, env);

  return { registry, sandbox, processes, guardMounted };
}

export function toolsPlugin(options: ToolsPluginOptions = {}): Plugin {
  return definePlugin(TOOLS_PLUGIN_NAME, (ctx: Context) => {
    const assembly = assembleTools(options);
    ctx.provide(TOOL_REGISTRY_SERVICE, assembly.registry);
    ctx.provide(SANDBOX_SERVICE, assembly.sandbox);
    ctx.provide(PROCESS_REGISTRY_SERVICE, assembly.processes);
  });
}
