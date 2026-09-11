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
 *
 * `run_code` (W255) is mounted here too, not in `builtinTools`: it needs a
 * late-bound handle on the very registry it will dispatch sub-calls through,
 * which only the assembly can bind — exactly like the Rust runtime compose
 * (`crates/runtime/src/tools.rs`). Pass `runCode: false` to leave it out.
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
import { mountProductionGuards, type PathGuardGrants } from "./guard/path-guard.js";
import { HttpTargetPolicy, type SsrfGrantView } from "./http/ssrf.js";
import type { HttpRequestToolOptions } from "./tools/http-request.js";
import { PROCESS_REGISTRY_SERVICE, ProcessRegistry } from "./process/registry.js";
import { ToolRegistryImpl } from "./registry.js";
import type { RunCodeEventSink } from "./run-code/broker.js";
import type { RunCodeConfig } from "./run-code/limits.js";
import { selectSandbox, type SandboxGrantView } from "./sandbox/provider.js";
import { RegistryHandle, runCodeToolWithHandle } from "./tools/run-code.js";

export const TOOLS_PLUGIN_NAME = "celestea.tools";

/** `run_code` wiring (W255): broker limits + the optional sub-call event sink. */
export interface RunCodeMount {
  /** Broker limits; default = `runCodeConfigFromEnv()` (CELAESTEA_RUN_CODE_TIMEOUT_MS). */
  config?: RunCodeConfig;
  /** Session-log sink for nested sub-call rows (see `RunCodeEventSink`). */
  events?: RunCodeEventSink;
}

/**
 * Per-session grants (W516) reaching the assembly point. All three views are
 * widen-only; `undefined` (no `grants.json`) reproduces the env-derived posture
 * byte for byte.
 */
export interface ToolAssemblyGrants extends PathGuardGrants, SandboxGrantView, SsrfGrantView {}

export interface ToolsPluginOptions {
  /** Tool set; default: the six builtins sharing [processes] + [sandbox]. */
  tools?: readonly Tool[];
  sandbox?: Sandbox;
  processes?: ProcessRegistry;
  /** Guard chain override: `null` disables guarding, `undefined` = env default. */
  guard?: ToolGuard | null;
  env?: NodeJS.ProcessEnv;
  /** Session grants (W516): read from the session's `grants.json` by the host. */
  grants?: ToolAssemblyGrants;
  /**
   * `run_code` mount: default = mounted; `false` = not registered. The tool is
   * registered *before* its registry handle is bound, so sub-calls ride this
   * assembly's exact pipeline (Rust runtime compose parity).
   */
  runCode?: RunCodeMount | false;
}

/** The wired handles a compose root keeps after mounting the plugin. */
export interface ToolAssembly {
  registry: ToolRegistryImpl;
  sandbox: Sandbox;
  processes: ProcessRegistry;
  guardMounted: boolean;
  /** Late-bound handle of the mounted `run_code` (`null` when disabled). */
  runCode: RegistryHandle | null;
}

/** Build the tool assembly without mounting it (compose roots / tests). */
export function assembleTools(options: ToolsPluginOptions = {}): ToolAssembly {
  const env = options.env ?? process.env;
  const grants = options.grants ?? {};
  const processes = options.processes ?? new ProcessRegistry();
  const sandbox = options.sandbox ?? selectSandbox({ env, grants });
  const registry = new ToolRegistryImpl();
  const tools = options.tools ?? builtinTools({ sandbox, processes, http: httpOptions(env, grants) });
  for (const tool of tools) registry.register(tool);
  const runCode = mountRunCode(registry, sandbox, options);

  let guardMounted = false;
  if (options.guard === null) guardMounted = false;
  else if (options.guard !== undefined) {
    registry.addGuard(options.guard);
    guardMounted = true;
  } else guardMounted = mountProductionGuards(registry, env, grants);

  return { registry, sandbox, processes, guardMounted, runCode };
}

/** The `http_request` options of this assembly (grants merged into allow). */
export function httpOptions(env: NodeJS.ProcessEnv, grants: SsrfGrantView): HttpRequestToolOptions {
  return { env, policy: HttpTargetPolicy.fromEnv(env, grants) };
}

/**
 * Mount the W255 `run_code` tool: register it into [registry], then bind the
 * handle to that same registry (the tool must live inside the registry it
 * dispatches through). A caller-supplied `run_code` tool always wins.
 */
function mountRunCode(
  registry: ToolRegistryImpl,
  sandbox: Sandbox,
  options: ToolsPluginOptions,
): RegistryHandle | null {
  if (options.runCode === false) return null;
  if (registry.get("run_code") !== undefined) return null;
  const mount = options.runCode ?? {};
  const { tool, handle } = runCodeToolWithHandle({
    sandbox,
    ...(mount.config === undefined ? {} : { config: mount.config }),
    ...(mount.events === undefined ? {} : { events: mount.events }),
  });
  registry.register(tool);
  handle.set(registry);
  return handle;
}

export function toolsPlugin(options: ToolsPluginOptions = {}): Plugin {
  return definePlugin(TOOLS_PLUGIN_NAME, (ctx: Context) => {
    const assembly = assembleTools(options);
    ctx.provide(TOOL_REGISTRY_SERVICE, assembly.registry);
    ctx.provide(SANDBOX_SERVICE, assembly.sandbox);
    ctx.provide(PROCESS_REGISTRY_SERVICE, assembly.processes);
  });
}
