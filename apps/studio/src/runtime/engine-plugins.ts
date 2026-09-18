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
  USER_QUESTION_SERVICE,
  EVENT_BUS_SERVICE,
  SandboxError,
  type AskUserQuestionAnswerItem,
  type Context,
  type EventBus,
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
import { createUserQuestionService, type HostUserQuestionService } from "../user-questions.js";
import { PendingQuestion, type QuestionRegistry } from "../question-registry.js";
import { agentConfigFromProfile, type Profile } from "@celestea/runtime";
import {
  assembleTools,
  builtinTools,
  DisclosurePolicy,
  disclosureExposure,
  ENV_SANDBOX_FALLBACK,
  EXECUTION_TOOL_NAMES,
  exposedRegistry,
  fallbackMode,
  httpOptions,
  PROCESS_REGISTRY_SERVICE,
  ProcessRegistry,
  sandboxConfigFromEnv,
  sessionSandboxConfig,
  type AttachmentStore,
  type SessionFsScope,
  selectSandboxDetailed,
  type HostProbe,
  type SandboxFallbackMode,
  type SandboxSelection,
} from "@celestea/tools";
import { workerTools, type WorkerRegistry } from "@celestea/workers";
import { EMPTY_GRANTS, type EffectiveGrants, type EngineGrantAudit } from "./engine-grants.js";
import { DEFAULT_SESSION_MODE, type SessionMode } from "../store/mode.js";

/** Everything the engine context needs from the host. */
export interface EnginePluginInput {
  profile: Profile;
  llm: Llm;
  /**
   * W804: the session's content-addressed attachment store. Present = the tool
   * face also offers `read_image` (and the wire can resolve bytes); absent = no
   * attachment capability at all.
   */
  attachments?: AttachmentStore | null;
  /**
   * W804: false ONLY when the target model's input_modalities was EXPLICITLY
   * configured without "image". Absent/true = the optimistic default.
   */
  imageInputAllowed?: boolean;
  /**
   * W791 (P1, §5.2 #2): the session's working mode. `execution` folds the SDK
   * tools out of the DIRECT face (the inner registry keeps them, so `run_code`
   * sub-calls still run); absent/`standard` = the whole registry, byte-for-byte
   * what every pre-P1 generation exposed.
   */
  mode?: SessionMode;
  /**
   * W806 (P0): dynamic tool disclosure. Absent = the static mode baseline, i.e.
   * today's byte-identical face. Present = `initial` is offered from the start
   * and the rest of the disclosable universe is revealed ONE TURN AT A TIME,
   * appended at the tail, when a direct call is refused (monotonic; never
   * reordered — see `disclosure.ts`).
   */
  disclosure?: DisclosureOptions;
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
  /**
   * W768: the composing SESSION's workspace (see `SessionFsScope`). The host
   * resolves it from the session's own record — the very same value its system
   * prompt renders — so the sandbox cwd/root and the guard's writable workspace
   * follow the session, not the process. `null`/absent = the env posture.
   */
  workspace?: SessionFsScope | null;
  /**
   * W783: the pending-question table of this process. Supplied = the session
   * mounts `ask_user_question` and answers through the waterfall; absent = the
   * feature is not mounted at all (the tool is then not offered to the model).
   */
  questions?: QuestionWiring | null;
}

/**
 * W783: a one-slot holder for the session's event bus. `engineTools()` runs
 * before `compose()` provides the bus and the plugin body runs after, so the
 * value travels through this object instead of a compose-time argument.
 */
export interface BusHolder {
  current: EventBus | null;
}

/**
 * W806: activation of the dynamic-disclosure layer. The mechanism is always
 * assembled; this is what asks it to withhold anything.
 */
export interface DisclosureOptions {
  /**
   * Names offered from the start. Default = the whole disclosable universe for
   * the session's mode (the mode baseline = today's face, a no-op). Names
   * outside the registry, or blocked by the mode, are dropped.
   */
  initial?: readonly string[];
}

/** W783: everything the engine needs to mount the user-question capability. */
export interface QuestionWiring {
  /** Process-wide pending table (shared by every session generation). */
  registry: QuestionRegistry;
  /**
   * The session's async answerer chain (the runtime's own event bus). The plugin
   * body fills this in, so the wiring can be built BEFORE `compose()` runs while
   * the bus only exists DURING it.
   */
  bus: BusHolder;
  /** The session id this generation is composed for (`null` = detached). */
  sessionId: string | null;
  /** Is this generation still live? (§5.3 `CALLER_NOT_LIVE` when it is not.) */
  isLive?: () => boolean;
  /** Publish one request to the UI (`question` SSE frame). */
  publish: (question: PendingQuestion) => void;
  /** Record the request in the session log (`user_question` row, §7). */
  record: (question: PendingQuestion) => void;
  /** Record how it ended (`user_answer` row, §7) — answer and timeout alike. */
  recordAnswer: (requestId: string, answers: AskUserQuestionAnswerItem[], timedOut: boolean) => void;
}

export interface EngineTools {
  /** Plugin providing TOOL_REGISTRY_SERVICE / SANDBOX_SERVICE / PROCESS_REGISTRY_SERVICE. */
  plugin: Plugin;
  /**
   * The registry the session's Context provides (and therefore the face `GET
   * /api/tools?session=` and `{{tools}}` read). W791: in `execution` mode this is
   * the EXPOSED view — the inner registry stays reachable to `run_code` only.
   */
  registry: ToolRegistry;
  /** The sandbox actually mounted (W741: annotated with the policy decision). */
  sandbox: Sandbox;
  /**
   * W855: the session's background-process registry. The HOST keeps this handle
   * so `Runtime.shutdown` can reap detached children via a shutdown hook —
   * `ProcessRegistry.dispose()` had no caller before this.
   */
  processes: ProcessRegistry;
  /** Why that sandbox was chosen — auditable, never inferred by a caller. */
  decision: SandboxDecision;
  /**
   * W806: the dynamic-disclosure policy of this generation. Always present; inert
   * (nothing withheld) unless `EnginePluginInput.disclosure` asked for a reduced
   * initial set. The runtime calls `beginTurn()` at every turn start.
   */
  disclosure: DisclosurePolicy;
}

/** The tool set: six builtins + the three worker tools (when a registry exists). */
export function engineTools(opts: EnginePluginInput): EngineTools {
  const env = opts.env ?? process.env;
  const grants = opts.grants ?? EMPTY_GRANTS;
  const scope = opts.workspace ?? null;
  const processes = new ProcessRegistry();
  const choice = opts.sandbox === undefined ? chooseSandbox(env, grants, opts.audit, opts.probe, scope) : injectedChoice(opts.sandbox, env);
  const sandbox = choice.sandbox;
  const http = httpOptions(env, { netHosts: grants.netHosts });
  if (http.policy?.netHostsIneffective) {
    opts.audit?.({ event: "net_hosts_ineffective", cap: "net_hosts", reason: "neither CELESTEA_HTTP_ALLOW nor CELESTEA_HTTP_DENY is set: the policy stays inactive" });
  }
  // W783 §5.3: the service refuses a DELEGATED caller itself (a worker turn has
  // no human), so the guard is mounted unconditionally here.
  // W783: the bus holder is filled in by the plugin body below, which runs
  // inside `compose()` AFTER the runtime provided EVENT_BUS_SERVICE.
  const busHolder: BusHolder = { current: null };
  const questions = opts.questions === undefined || opts.questions === null ? null : userQuestionsOf(opts.questions, busHolder);
  const tools: Tool[] = [
    ...builtinTools({
      sandbox,
      processes,
      http,
      ...(questions === null ? {} : { questions }),
      ...(opts.attachments === undefined ? {} : { attachments: opts.attachments }),
      ...(opts.imageInputAllowed === undefined ? {} : { imageInputAllowed: opts.imageInputAllowed }),
      model: opts.profile.model,
    }),
    ...(opts.tools ?? []),
  ];
  if (opts.workers !== null) tools.push(...workerTools(opts.workers));
  const assembly = assembleTools({
    tools,
    sandbox,
    processes,
    env,
    scope,
    grants: { readRoots: grants.readRoots, writeRoots: grants.writeRoots },
    ...(opts.guard === undefined ? {} : { guard: opts.guard }),
  });
  // W791 (P1, §5.2 #2 — the "关键机关"): the CONTEXT sees the mode's model-visible
  // face while `run_code`'s RegistryHandle stays bound to the INNER registry
  // (`assembleTools` bound it above), so a program's `tools.read_file(...)` is
  // dispatched exactly like a direct call was before the fold.
  // W806 (P0): the SAME face is projected through the dynamic-disclosure policy.
  // Absent `opts.disclosure` the policy's initial set IS the mode baseline, so
  // `hidden()` is exactly the old fold and the wire array is byte-identical.
  // Present, it withholds part of the disclosable universe and reveals it one
  // turn at a time, appended at the tail (see `disclosure.ts`).
  const mode = opts.mode ?? DEFAULT_SESSION_MODE;
  const universe = assembly.registry.schemas().map((spec) => spec.name);
  const blocked = mode === "execution" ? universe.filter((name) => !EXECUTION_TOOL_NAMES.includes(name)) : [];
  const disclosure = new DisclosurePolicy({ universe, initial: opts.disclosure?.initial ?? universe, blocked });
  const wrapped = mode === "execution" || opts.disclosure !== undefined;
  const exposed: ToolRegistry = wrapped ? exposedRegistry(assembly.registry, disclosureExposure(disclosure)) : assembly.registry;
  const plugin = definePlugin("studio.engine.tools", (ctx: Context) => {
    ctx.provide(TOOL_REGISTRY_SERVICE, exposed);
    ctx.provide(SANDBOX_SERVICE, assembly.sandbox);
    ctx.provide(PROCESS_REGISTRY_SERVICE, assembly.processes);
    // W783: the same service instance the tool was constructed with, published
    // as a seam too so an answerer layer (or a test) can reach it.
    if (questions !== null) {
      busHolder.current = ctx.require(EVENT_BUS_SERVICE);
      ctx.provide(USER_QUESTION_SERVICE, questions);
    }
  });
  return { plugin, registry: exposed, sandbox, processes, decision: choice.decision, disclosure };
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
function chooseSandbox(
  env: NodeJS.ProcessEnv,
  grants: EffectiveGrants,
  audit?: EngineGrantAudit,
  probe?: HostProbe,
  scope: SessionFsScope | null = null,
): SandboxChoice {
  let selection: SandboxSelection;
  try {
    const view = { network: grants.network, unsandboxed: grants.unsandboxed };
    selection = selectSandboxDetailed({
      env,
      grants: view,
      config: sessionSandboxConfig(scope, env),
      ...(probe === undefined ? {} : { probe }),
    });
  } catch (error) {
    return refusedChoice(env, error, audit, scope);
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
function refusedChoice(
  env: NodeJS.ProcessEnv,
  error: unknown,
  audit?: EngineGrantAudit,
  scope: SessionFsScope | null = null,
): SandboxChoice {
  const reason = refusalReason(error);
  const decision: SandboxDecision = { provider: "none", degraded: false, reason, mode: modeOrNull(env), source: "refused" };
  audit?.({
    event: "deny",
    cap: "sandbox",
    provider: "none",
    reason,
    detail: "the sandbox provider policy refuses to execute: no OS isolation and no degradation allowed (an 'unsandboxed' session grant is the only override)",
  });
  return { sandbox: new RefusingSandbox(sessionSandboxConfig(scope, env), decision), decision };
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

/**
 * W783: the session's user-question service. `isLive` answers "is this
 * generation still the live one?" — a settled/released instance must refuse
 * instead of parking a question nobody can ever answer (§5.3 `CALLER_NOT_LIVE`).
 *
 * The bus is the runtime's own `EVENT_BUS_SERVICE` instance, handed in by the
 * composer (`session-compose.ts` reads it from the Context at compose time, by
 * which point `compose()` has already provided it).
 */
function userQuestionsOf(wiring: QuestionWiring, bus: BusHolder): HostUserQuestionService {
  return createUserQuestionService({
    registry: wiring.registry,
    bus: lazyBus(bus),
    sessionId: wiring.sessionId,
    ...(wiring.isLive === undefined ? {} : { isLive: wiring.isLive }),
    publish: wiring.publish,
    record: wiring.record,
    recordAnswer: wiring.recordAnswer,
  });
}

/**
 * A deferred view of the session's event bus. The service holds this for its
 * whole life while the real bus only exists from the moment `compose()` provides
 * it, so the first question resolves it and every later one reuses that answer.
 */
function lazyBus(holder: BusHolder): EventBus {
  const get = (): EventBus => {
    const bus = holder.current;
    if (bus === null) throw new Error("the session EventBus is not mounted yet: ask_user_question cannot reach the answerer waterfall");
    return bus;
  };
  return {
    on: (key, listener) => get().on(key, listener),
    emit: (key, event) => get().emit(key, event),
    bail: (key, listener) => get().bail(key, listener),
    runBail: (key, event) => get().runBail(key, event),
    waterfall: (key, listener) => get().waterfall(key, listener),
    runWaterfall: (key, event, init) => get().runWaterfall(key, event, init),
    waterfallAsync: (key, listener) => get().waterfallAsync(key, listener),
    runWaterfallAsync: (key, event, init) => get().runWaterfallAsync(key, event, init),
    counts: (key) => get().counts(key),
  };
}
