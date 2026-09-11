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
import {
  assembleTools,
  builtinTools,
  httpOptions,
  PROCESS_REGISTRY_SERVICE,
  ProcessRegistry,
  selectSandboxDetailed,
  userspaceSandbox,
} from "@celestea/tools";
import { workerTools, type WorkerRegistry } from "@celestea/workers";
import { EMPTY_GRANTS, type EffectiveGrants, type EngineGrantAudit } from "./engine-grants.js";

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
  /** The session's effective grants (W516); default: none (least privilege). */
  grants?: EffectiveGrants;
  /** Bound audit sink for grant use / degradation events (W516 §4.4). */
  audit?: EngineGrantAudit;
}

export interface EngineTools {
  /** Plugin providing TOOL_REGISTRY_SERVICE / SANDBOX_SERVICE / PROCESS_REGISTRY_SERVICE. */
  plugin: Plugin;
  registry: ToolRegistry;
}

/** The tool set: six builtins + the three worker tools (when a registry exists). */
export function engineTools(opts: EnginePluginInput): EngineTools {
  const env = opts.env ?? process.env;
  const grants = opts.grants ?? EMPTY_GRANTS;
  const processes = new ProcessRegistry();
  const sandbox = opts.sandbox ?? sandboxForGrants(env, grants, opts.audit);
  const http = httpOptions(env, { netHosts: grants.netHosts });
  if (http.policy?.netHostsIneffective) {
    opts.audit?.({ event: "net_hosts_ineffective", cap: "net_hosts", reason: "neither CELESTEA_HTTP_ALLOW nor CELESTEA_HTTP_DENY is set: the policy stays inactive" });
  }
  const tools: Tool[] = [...builtinTools({ sandbox, processes, http }), ...(opts.tools ?? [])];
  if (opts.workers !== null) tools.push(...workerTools(opts.workers));
  const assembly = assembleTools({
    tools,
    sandbox,
    processes,
    env,
    grants: { readRoots: grants.readRoots, writeRoots: grants.writeRoots },
    ...(opts.guard === undefined ? {} : { guard: opts.guard }),
  });
  const plugin = definePlugin("studio.engine.tools", (ctx: Context) => {
    ctx.provide(TOOL_REGISTRY_SERVICE, assembly.registry);
    ctx.provide(SANDBOX_SERVICE, assembly.sandbox);
    ctx.provide(PROCESS_REGISTRY_SERVICE, assembly.processes);
  });
  return { plugin, registry: assembly.registry };
}

/**
 * W516: the session's sandbox provider.
 *
 * With no sandbox-related grant the answer is EXACTLY today's default
 * (`userspaceSandbox()`), so a session without `grants.json` behaves word for
 * word as before. When the session does hold `network` / `unsandboxed`, the
 * provider POLICY decides: `network` ORs into `--share-net` (bwrap), and
 * `unsandboxed` is the only way to accept the userspace provider under
 * `CELESTEA_SANDBOX_FALLBACK=fail` — both recorded in the audit.
 */
function sandboxForGrants(env: NodeJS.ProcessEnv, grants: EffectiveGrants, audit?: EngineGrantAudit): Sandbox {
  if (!grants.network && !grants.unsandboxed) return userspaceSandbox();
  try {
    const selection = selectSandboxDetailed({ env, grants: { network: grants.network, unsandboxed: grants.unsandboxed } });
    if (selection.degradedByGrant) {
      audit?.({ event: "degraded_by_grant", cap: "unsandboxed", provider: selection.provider, reason: selection.reason ?? undefined });
    }
    return selection.sandbox;
  } catch (e) {
    // The deployment refuses to run without OS isolation and the session did
    // not grant `unsandboxed`: keep the previous provider (never crash compose).
    audit?.({ event: "deny", cap: "network", reason: e instanceof Error ? e.message : String(e) });
    return userspaceSandbox();
  }
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
