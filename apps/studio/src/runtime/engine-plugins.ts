/**
 * The engine's compose plugins: the `Llm` seam, the tool registry (builtins +
 * the three worker-orchestration tools) and the agent loop.
 *
 * This module exists so `real-runtime-adapter.ts` stays about the HTTP contract:
 * every `Context` service the runtime resolves at turn start is provided here,
 * in one place, with the tool set assembled explicitly (a later `provide` wins,
 * so the host can override any of them by mounting its own plugin).
 *
 * W741 (fixes the W738 §4 finding): the sandbox is **always** chosen by the
 * provider policy — `selectSandboxDetailed`, i.e. bwrap whenever the host can
 * give it, with or without session grants — and the resulting decision travels
 * with every run (`SandboxDecision`). `CELESTEA_SANDBOX_FALLBACK=fail` is read on
 * the default path too and it REFUSES to execute (structured `SandboxError`)
 * instead of degrading to the userspace provider behind the operator's back.
 */

import {
  definePlugin,
  LLM_SERVICE,
  SANDBOX_SERVICE,
  TOOL_REGISTRY_SERVICE,
  SandboxError,
  type Context,
  type Llm,
  type Plugin,
  type Sandbox,
  type SandboxConfig,
  type SandboxMeta,
  type SandboxRunRequest,
  type SandboxRunResult,
  type SandboxSpawnRequest,
  type SandboxSpawned,
  type Tool,
  type ToolGuard,
  type ToolRegistry,
} from "@celestea/core";
import { agentLoopPlugin } from "@celestea/agent-loop";
import { agentConfigFromProfile, type Profile } from "@celestea/runtime";
import {
  assembleTools,
  builtinTools,
  ENV_SANDBOX_FALLBACK,
  fallbackMode,
  httpOptions,
  PROCESS_REGISTRY_SERVICE,
  ProcessRegistry,
  sandboxConfigFromEnv,
  selectSandboxDetailed,
  type HostProbe,
  type SandboxFallbackMode,
  type SandboxSelection,
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
  /**
   * Sandbox override (tests inject a fake). This is the ONE explicit policy
   * bypass: it is reported as `fallback_source: "injected"` in every result.
   */
  sandbox?: Sandbox;
  /** Guard override: `undefined` = mount the production guard, `null` = none. */
  guard?: ToolGuard | null;
  env?: NodeJS.ProcessEnv;
  /** The session's effective grants (W516); default: none (least privilege). */
  grants?: EffectiveGrants;
  /** Bound audit sink for grant use / degradation events (W516 §4.4). */
  audit?: EngineGrantAudit;
  /** Injected host probe (tests / diagnostics); default: the memoized host probe. */
  probe?: HostProbe;
}

export interface EngineTools {
  /** Plugin providing TOOL_REGISTRY_SERVICE / SANDBOX_SERVICE / PROCESS_REGISTRY_SERVICE. */
  plugin: Plugin;
  registry: ToolRegistry;
  /** The sandbox actually mounted (W741: annotated with the policy decision). */
  sandbox: Sandbox;
  /** Why that sandbox was chosen — auditable, never inferred by a caller. */
  decision: SandboxDecision;
}

/** The tool set: six builtins + the three worker tools (when a registry exists). */
export function engineTools(opts: EnginePluginInput): EngineTools {
  const env = opts.env ?? process.env;
  const grants = opts.grants ?? EMPTY_GRANTS;
  const processes = new ProcessRegistry();
  const choice = opts.sandbox === undefined ? chooseSandbox(env, grants, opts.audit, opts.probe) : injectedChoice(opts.sandbox, env);
  const sandbox = choice.sandbox;
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
  return { plugin, registry: assembly.registry, sandbox, decision: choice.decision };
}

// --- the provider policy, decided out loud (W516 grants, W741 fail semantics) --

/** Where one session's sandbox came from (W741 §3 — never inferred by a caller). */
export type SandboxDecisionSource = "policy" | "grant" | "refused" | "injected";

/**
 * The provider-policy decision behind one composed session.
 *
 * `degraded` keeps one invariant: `true` ⟺ commands really run on the userspace
 * provider (no namespaces, no seccomp). A refusal is therefore NOT "degraded" —
 * it is `source: "refused"` plus a structured `SandboxError` on every execution
 * attempt — and an injected sandbox reports `null` (the policy never decided it).
 */
export interface SandboxDecision {
  /** Provider that will execute (`"none"` when every run is refused). */
  provider: string;
  degraded: boolean | null;
  reason: string | null;
  /** `CELESTEA_SANDBOX_FALLBACK` in force at compose time (`null` = unreadable). */
  mode: SandboxFallbackMode | null;
  source: SandboxDecisionSource;
}

/** `SandboxMeta` plus the fallback decision the 4-field contract cannot carry. */
export interface DecidedSandboxMeta extends SandboxMeta {
  degraded: boolean | null;
  fallback_reason: string | null;
  fallback_mode: SandboxFallbackMode | null;
  fallback_source: SandboxDecisionSource;
}

/** One composed sandbox plus the decision that produced it. */
interface SandboxChoice {
  sandbox: Sandbox;
  decision: SandboxDecision;
}

/** Annotate one provider meta with the decision (`run_shell` reports it verbatim). */
function decidedMeta(meta: SandboxMeta, decision: SandboxDecision): DecidedSandboxMeta {
  return {
    ...meta,
    degraded: decision.degraded,
    fallback_reason: decision.reason,
    fallback_mode: decision.mode,
    fallback_source: decision.source,
  };
}

/** Wraps a policy-chosen sandbox so every result carries WHY it was chosen. */
class DecidedSandbox implements Sandbox {
  readonly config: SandboxConfig;
  readonly decision: SandboxDecision;
  private readonly inner: Sandbox;

  constructor(inner: Sandbox, decision: SandboxDecision) {
    this.inner = inner;
    this.decision = decision;
    this.config = inner.config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const result = await this.inner.run(request);
    return { ...result, sandbox: decidedMeta(result.sandbox, this.decision) };
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    const spawned = await this.inner.spawn(request);
    return { ...spawned, sandbox: decidedMeta(spawned.sandbox, this.decision) };
  }
}

/** Fail-closed provider: the `fail` policy's answer is a refusal, not a degrade. */
class RefusingSandbox implements Sandbox {
  readonly config: SandboxConfig;
  readonly decision: SandboxDecision;

  constructor(config: SandboxConfig, decision: SandboxDecision) {
    this.config = config;
    this.decision = decision;
  }

  async run(): Promise<SandboxRunResult> {
    throw this.refusal();
  }

  async spawn(): Promise<SandboxSpawned> {
    throw this.refusal();
  }

  /** The structured error every caller sees: `run_shell-sandbox: code=config …`. */
  private refusal(): SandboxError {
    const reason = this.decision.reason ?? "bubblewrap is unusable on this host";
    return new SandboxError(
      "config",
      `${reason}; CELESTEA_SANDBOX_FALLBACK refuses to execute without OS isolation (only an 'unsandboxed' session grant overrides it)`,
      { provider: this.decision.provider, reason, mode: this.decision.mode, executed: false },
    );
  }
}

/**
 * W516/W741: the session's sandbox comes from the provider POLICY — bwrap
 * whenever the host can give it, with or without grants. Grants only ever widen
 * what bwrap may keep (`network` → `--share-net`; `unsandboxed` → accept the
 * userspace provider under `fail`), and nothing here degrades silently: a policy
 * refusal (or an unreadable policy) becomes a [RefusingSandbox].
 */
function chooseSandbox(env: NodeJS.ProcessEnv, grants: EffectiveGrants, audit?: EngineGrantAudit, probe?: HostProbe): SandboxChoice {
  let selection: SandboxSelection;
  try {
    const view = { network: grants.network, unsandboxed: grants.unsandboxed };
    selection = selectSandboxDetailed({ env, grants: view, ...(probe === undefined ? {} : { probe }) });
  } catch (error) {
    return refusedChoice(env, error, audit);
  }
  const decision: SandboxDecision = {
    provider: selection.provider,
    degraded: selection.degraded,
    reason: selection.reason,
    mode: selection.mode,
    source: selection.degradedByGrant ? "grant" : "policy",
  };
  if (selection.degradedByGrant) {
    audit?.({ event: "degraded_by_grant", cap: "unsandboxed", provider: selection.provider, reason: selection.reason ?? undefined });
  }
  return { sandbox: new DecidedSandbox(selection.sandbox, decision), decision };
}

/** Policy refused (or could not be read): refuse to execute, never degrade. */
function refusedChoice(env: NodeJS.ProcessEnv, error: unknown, audit?: EngineGrantAudit): SandboxChoice {
  const reason = refusalReason(error);
  const decision: SandboxDecision = { provider: "none", degraded: false, reason, mode: modeOrNull(env), source: "refused" };
  audit?.({
    event: "deny",
    cap: "sandbox",
    provider: "none",
    reason,
    detail: "the sandbox provider policy refuses to execute: no OS isolation and no degradation allowed (an 'unsandboxed' session grant is the only override)",
  });
  return { sandbox: new RefusingSandbox(sandboxConfigFromEnv(env), decision), decision };
}

/** Explicit host injection: the policy is bypassed ON PURPOSE, and says so. */
function injectedChoice(sandbox: Sandbox, env: NodeJS.ProcessEnv): SandboxChoice {
  const decision: SandboxDecision = {
    provider: sandbox.constructor.name === "" ? "injected" : sandbox.constructor.name,
    degraded: null,
    reason: "sandbox injected through EnginePluginInput.sandbox: the provider policy was bypassed explicitly",
    mode: modeOrNull(env),
    source: "injected",
  };
  return { sandbox: new DecidedSandbox(sandbox, decision), decision };
}

/** Cleanest available reason for a refusal (never a nested error envelope). */
function refusalReason(error: unknown): string {
  if (error instanceof SandboxError) {
    const probeReason = error.detail["reason"];
    if (typeof probeReason === "string" && probeReason !== "") return `sandbox_unavailable: ${probeReason}`;
    const badValue = error.detail["value"];
    if (typeof badValue === "string") return `invalid ${ENV_SANDBOX_FALLBACK}='${badValue}' (expected 'userspace' or 'fail')`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The operator's fallback mode as text, or null when it is unreadable (a typo). */
function modeOrNull(env: NodeJS.ProcessEnv): SandboxFallbackMode | null {
  try {
    return fallbackMode(env);
  } catch {
    return null;
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
