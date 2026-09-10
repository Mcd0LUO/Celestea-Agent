/**
 * compose — the composition root of `packages/runtime` (Rust
 * `crates/runtime/src/compose.rs:74-234`).
 *
 * Assembly order is SEMANTICS, not taste (ARCHITECTURE.md §3.2), so it is
 * explicit and tested:
 *
 *   1. runtime services      event bus, usage accounting, status tracker;
 *   2. session binding       `sessionBinding` (if given) opens the host log;
 *   3. host plugins          `config.plugins` in order — a later `provide` of a
 *                            token REPLACES an earlier one (patch semantics, so
 *                            a test can mount a fake over a real implementation);
 *   4. worker wiring         mount the default workers plugin only when the host
 *                            did not provide a registry (worker tools must land
 *                            in the tool registry, hence last);
 *   5. seam resolution       session (required) + llm / tools / agentLoop
 *                            (optional, and `null` when no plugin provides them);
 *   6. driver attach         hand Llm/ToolRegistry/AgentLoop to the worker
 *                            registry so `spawn_worker` is driven, not merely
 *                            registered, and register the host conversation so
 *                            receipts have an address;
 *   7. turn runner           bind the per-turn loop factory, sink mapper, usage
 *                            accounting and receipt drain into one driver.
 *
 * Everything the runtime needs beyond `core` is injected: the concrete agent
 * loop arrives as a `loopFactory`, the frame mapper as `frameMapper`, the worker
 * log factory as `workers.logFactory`. That is what keeps this layer free of
 * L1 implementation imports (and lets P3 tests drive it with fakes).
 */

import {
  AGENT_LOOP_SERVICE,
  LLM_REGISTRY_SERVICE,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  Context,
  createEventBus,
  EVENT_BUS_SERVICE,
  mountPlugins,
  pluginNames,
  type AgentConfig,
  type AgentLoop,
  type Llm,
  type LlmRegistry,
  type Plugin,
  type SessionLog,
  type ToolRegistry,
} from "@celestea/core";
import type { WorkerDrivers } from "@celestea/workers";
import { agentConfigFromProfile } from "./agent-config.js";
import { ComposeError } from "./errors.js";
import { loopEventToFrame, type FrameMapper } from "./frames.js";
import type { Profile } from "./profile.js";
import { Runtime, type RuntimeParts, type ShutdownHook } from "./runtime.js";
import { bindSession, type SessionBinding } from "./session-binding.js";
import { createStatusTracker, type StatusTracker } from "./status.js";
import { STATUS_TRACKER_SERVICE, USAGE_TRACKER_SERVICE } from "./tokens.js";
import { TurnRunner, type LoopFactory, type PendingReceipt } from "./turn-runner.js";
import { createUsageTracker, type UsageAccounting } from "./usage.js";
import type { InjectionLane, PendingInjection } from "@celestea/core";
import { createSessionInbox, type SessionInbox } from "./inbox.js";
import { ensureWorkerWiring, type WorkerHost, type WorkerWiring } from "./worker-wiring.js";

export interface ComposeConfig {
  profile: Profile;
  /** Seam providers, mounted in order (later wins). */
  plugins?: readonly Plugin[];
  /** Host conversation binding (dir + log opener); a rebind reuses it. */
  sessionBinding?: SessionBinding;
  /** Loop budget overrides (defaults derive from the profile). */
  agentConfig?: Partial<AgentConfig>;
  /** Concrete agent loop per turn; absent = `AGENT_LOOP_SERVICE` from the Context. */
  loopFactory?: LoopFactory;
  /** LoopEvent -> SSE frame mapping; defaults to the contract mapping. */
  frameMapper?: FrameMapper;
  /** Shared usage accounting (pass the loop's own tracker to share one object). */
  usage?: UsageAccounting;
  /** Shared statusline tracker (steps + rate window). */
  status?: StatusTracker;
  /** Worker orchestration wiring; `false` disables it. */
  workers?: WorkerWiring | false;
  /** Mid-turn injection queue (default: a fresh one per generation). */
  inbox?: SessionInbox;
  /**
   * W515 §2: every message that LEAVES a lane (or the host mailbox) is reported
   * with the boundary that consumed it, so the host can publish
   * `placement: "context"` (the message is now model-visible) over SSE.
   */
  onInjected?: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void;
  /** Host teardown hooks (process kills) — run once, in order, by `shutdown`. */
  shutdownHooks?: readonly ShutdownHook[];
  /** Injectable clock (status tracker rate window). */
  now?: () => number;
}

/** Compose one engine generation. Throws [ComposeError] on a missing seam. */
export function compose(config: ComposeConfig): Runtime {
  const ctx = Context.root();
  const usage = config.usage ?? createUsageTracker();
  const status = config.status ?? createStatusTracker(config.now ?? Date.now);
  ctx.provide(EVENT_BUS_SERVICE, createEventBus());
  ctx.provide(USAGE_TRACKER_SERVICE, usage);
  ctx.provide(STATUS_TRACKER_SERVICE, status);

  const binding = config.sessionBinding ?? null;
  if (binding !== null) bindSession(ctx, binding);
  const plugins = config.plugins ?? [];
  mountPlugins(ctx, plugins);

  const workerHost = ensureWorkerWiring(ctx, config.workers);
  const session = requireSession(ctx);
  const sessionRef = { log: session };
  const llm = ctx.get<LlmRegistry>(LLM_REGISTRY_SERVICE) ?? null;
  const tools = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE) ?? null;
  const agentLoop = ctx.get<AgentLoop>(AGENT_LOOP_SERVICE) ?? null;
  attachDrivers(workerHost, { llm: resolveDriverLlm(ctx, llm), tools, agentLoop });

  const agentConfig = agentConfigFromProfile(config.profile, config.agentConfig ?? {});
  const inbox = config.inbox ?? createSessionInbox();
  const receipts = (): PendingReceipt[] => workerHost?.drain() ?? [];
  const drained = (messages: PendingReceipt[], boundary: "turn-start" | "step"): PendingReceipt[] => {
    if (messages.length === 0) return messages;
    // A mailbox message never entered a lane: the BOUNDARY that consumed it is
    // what tells the client where it landed (W515 §1/§2).
    const lane: InjectionLane = boundary === "step" ? "next-step" : "next-turn";
    const annotated = messages.map((message) => (message.lane === undefined ? { ...message, lane } : message));
    config.onInjected?.(annotated, boundary);
    return annotated;
  };
  const runner = new TurnRunner({
    ctx,
    session: () => sessionRef.log,
    status,
    usage,
    agentConfig,
    frameMapper: config.frameMapper ?? loopEventToFrame,
    ...(config.loopFactory === undefined ? {} : { loopFactory: config.loopFactory }),
    drainPending: () => drained([...inbox.drain("next-turn"), ...receipts()], "turn-start"),
    injections: {
      drain: () => drained([...inbox.drain("next-step"), ...receipts()], "step"),
      pending: () => inbox.pending("next-step") + (workerHost?.pending() ?? 0),
    },
  });

  const parts: RuntimeParts = {
    ctx,
    profile: config.profile,
    agentConfig,
    sessionRef,
    binding,
    status,
    usage,
    inbox,
    runner,
    workerHost,
    llm,
    tools,
    agentLoop,
    plugins: pluginNamesOf(plugins, workerHost),
    shutdownHooks: config.shutdownHooks ?? [],
  };
  return new Runtime(parts);
}

/** The plugin set that was mounted, in mount order (order is contract). */
export function pluginNamesOf(plugins: readonly Plugin[], workerHost: WorkerHost | null): string[] {
  const names = pluginNames(plugins);
  if (workerHost !== null && workerHost.mountedPlugin !== null) names.push(workerHost.mountedPlugin);
  return names;
}

function requireSession(ctx: Context): SessionLog {
  const session = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
  if (session === undefined) {
    throw new ComposeError("no SessionLog: pass a sessionBinding or mount a session log plugin");
  }
  return session;
}

/**
 * The single adapter the worker driver uses: the composed `LlmService`, else the
 * registry's first registered provider (compose registers exactly one).
 */
function resolveDriverLlm(ctx: Context, registry: LlmRegistry | null): Llm | undefined {
  const direct = ctx.get<Llm>(LLM_SERVICE);
  if (direct !== undefined) return direct;
  const first = registry?.list()[0];
  return first === undefined ? undefined : registry?.resolve(first);
}

/** Attach every driver seam (all three, or none — a partial set cannot drive). */
function attachDrivers(
  host: WorkerHost | null,
  seams: { llm: Llm | undefined; tools: ToolRegistry | null; agentLoop: AgentLoop | null },
): void {
  if (host === null) return;
  const { llm, tools, agentLoop } = seams;
  const drivers: WorkerDrivers | null =
    llm === undefined || tools === null || agentLoop === null ? null : { llm, tools, agentLoop };
  host.attach(drivers);
}
