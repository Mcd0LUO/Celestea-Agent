/**
 * The workers package as PLUGINS (rule 3: everything is a plugin).
 *
 * `workersPlugin` mounts one [WorkerRegistry] and:
 *   1. provides it under `WORKER_REGISTRY_SERVICE` (the host resolves it there),
 *   2. registers the three worker tools into whatever `ToolRegistry` is already
 *      provided — the same wiring as Rust `build_registry(workers, …)`, which is
 *      why the compose order is "tools plugin first, workers plugin last".
 *
 * A later mount of the same token wins, so a test can swap in its own registry.
 */

import { definePlugin, TOOL_REGISTRY_SERVICE, type Plugin, type ToolRegistry } from "@celestea/core";
import { WorkerRegistry, WORKER_REGISTRY_SERVICE, type WorkerRegistryOptions } from "./registry.js";
import { workerTools } from "./tools.js";

export interface WorkersPluginOptions extends WorkerRegistryOptions {
  /** Pre-built registry (the host keeps the handle); wins over the path options. */
  registry?: WorkerRegistry;
  /** Register the three worker tools into the provided ToolRegistry (default true). */
  registerTools?: boolean;
  /** Mount name (auto-named when omitted). */
  name?: string;
}

/** Build a registry from plugin options (the registry is the plugin's state). */
export function createWorkerRegistry(opts: WorkersPluginOptions = {}): WorkerRegistry {
  return opts.registry ?? new WorkerRegistry(opts);
}

export function workersPlugin(opts: WorkersPluginOptions = {}): Plugin {
  const registry = createWorkerRegistry(opts);
  const registerTools = opts.registerTools !== false;
  const name = opts.name ?? "celestea.workers.Workers";
  return definePlugin(name, (ctx) => {
    ctx.provide(WORKER_REGISTRY_SERVICE, registry);
    if (!registerTools) return;
    const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
    if (tools === undefined) return;
    for (const tool of workerTools(registry)) tools.register(tool);
  });
}
