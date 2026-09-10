/**
 * The engine's compose plugins: the `Llm` seam, the tool registry (builtins +
 * the three worker-orchestration tools) and the agent loop.
 *
 * This module exists so `real-runtime-adapter.ts` stays about the HTTP contract:
 * every `Context` service the runtime resolves at turn start is provided here,
 * in one place, with the tool set assembled explicitly (a later `provide` wins,
 * so the host can override any of them by mounting its own plugin).
 */

import {
  definePlugin,
  LLM_SERVICE,
  SANDBOX_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type Context,
  type Llm,
  type Plugin,
  type Sandbox,
  type Tool,
  type ToolGuard,
  type ToolRegistry,
} from "@celestea/core";
import { agentLoopPlugin } from "@celestea/agent-loop";
import { agentConfigFromProfile, type Profile } from "@celestea/runtime";
import { assembleTools, builtinTools, PROCESS_REGISTRY_SERVICE, ProcessRegistry, userspaceSandbox } from "@celestea/tools";
import { workerTools, type WorkerRegistry } from "@celestea/workers";

/** Everything the engine context needs from the host. */
export interface EnginePluginInput {
  profile: Profile;
  llm: Llm;
  /** Worker registry to expose the three orchestration tools over (null = none). */
  workers: WorkerRegistry | null;
  /** Extra tools appended after the builtins. */
  tools?: readonly Tool[];
  /** Sandbox override (tests inject a fake; default = userspace-lite). */
  sandbox?: Sandbox;
  /** Guard override: `undefined` = mount the production guard, `null` = none. */
  guard?: ToolGuard | null;
  env?: NodeJS.ProcessEnv;
}

export interface EngineTools {
  /** Plugin providing TOOL_REGISTRY_SERVICE / SANDBOX_SERVICE / PROCESS_REGISTRY_SERVICE. */
  plugin: Plugin;
  registry: ToolRegistry;
}

/** The tool set: six builtins + the three worker tools (when a registry exists). */
export function engineTools(opts: EnginePluginInput): EngineTools {
  const processes = new ProcessRegistry();
  const sandbox = opts.sandbox ?? userspaceSandbox();
  const tools: Tool[] = [...builtinTools({ sandbox, processes }), ...(opts.tools ?? [])];
  if (opts.workers !== null) tools.push(...workerTools(opts.workers));
  const assembly = assembleTools({
    tools,
    sandbox,
    processes,
    env: opts.env,
    ...(opts.guard === undefined ? {} : { guard: opts.guard }),
  });
  const plugin = definePlugin("studio.engine.tools", (ctx: Context) => {
    ctx.provide(TOOL_REGISTRY_SERVICE, assembly.registry);
    ctx.provide(SANDBOX_SERVICE, assembly.sandbox);
    ctx.provide(PROCESS_REGISTRY_SERVICE, assembly.processes);
  });
  return { plugin, registry: assembly.registry };
}

/** Provide the `Llm` seam (the offline engine by default). */
export function engineLlmPlugin(llm: Llm, name = "studio.engine.llm"): Plugin {
  return definePlugin(name, (ctx: Context) => ctx.provide(LLM_SERVICE, llm));
}

/** Provide the agent loop driver (needed for worker driving). */
export function engineLoopPlugin(profile: Profile, name = "studio.engine.agent-loop"): Plugin {
  return agentLoopPlugin(agentConfigFromProfile(profile), {}, name);
}

/** Convenience: the three plugins in mount order (llm, loop, tools). */
export function enginePlugins(input: EnginePluginInput): { plugins: Plugin[]; tools: EngineTools } {
  const tools = engineTools(input);
  return {
    plugins: [engineLlmPlugin(input.llm), engineLoopPlugin(input.profile), tools.plugin],
    tools,
  };
}
