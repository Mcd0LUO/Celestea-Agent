/**
 * The composed runtime engine: one generation's services, wired and ready.
 *
 * A [Runtime] is deliberately thin — it owns the handles and the lifecycle and
 * delegates turn driving to [TurnRunner]:
 *
 *   - **turn driving**  `runTurn(input, {signal, sink})`, single concurrency slot;
 *   - **statusline**    `statusline()` reads the live tracker + usage accounting;
 *   - **rebinding**     `rebind(binding)` re-opens the SAME session directory;
 *   - **shutdown**      idempotent, re-entrant teardown (drivers, host process
 *                       hooks, mailbox, registries): calling it twice is a
 *                       no-op, and a concurrent caller awaits the same promise;
 *   - **release**       explicit strong-reference drop for hot swaps (W248).
 *
 * [release] nulls every handle, which — together with the WeakRef the worker
 * tools hold on the registry — breaks the
 * `Runtime -> ctx -> ToolRegistry -> worker tool -> registry` cycle, so a
 * swapped-out generation can actually be collected.
 */

import { EVENT_BUS_SERVICE, contextSnapshotOf, createEventBus } from "@celestea/core";
import type {
  AgentConfig,
  Context,
  LlmRegistry,
  ModelRequest,
  SessionLog,
  Statusline,
  ToolRegistry,
  TurnOutcome,
} from "@celestea/core";
import type { WorkerRegistry } from "@celestea/workers";
import { RuntimeReleasedError, TurnBusyError } from "./errors.js";
import type { InjectionLane } from "@celestea/core";
import type { InboxPushOptions, InjectedMessage, SessionInbox } from "./inbox.js";
import { bindSession, type SessionBinding } from "./session-binding.js";
import { statuslineOf, type StatusTracker, type StatusView } from "./status.js";
import type { FrameSink, TurnOptions, TurnRunner } from "./turn-runner.js";
import type { TurnFrame } from "./frames.js";
import type { UsageAccounting } from "./usage.js";
import type { Profile } from "./profile.js";
import type { WorkerHost } from "./worker-wiring.js";

export type ShutdownHook = () => void | Promise<void>;

/** Everything compose hands over; the constructor never does IO of its own. */
export interface RuntimeParts {
  ctx: Context;
  profile: Profile;
  agentConfig: AgentConfig;
  /** Mutable holder: a rebind swaps the log every reader observes. */
  sessionRef: { log: SessionLog };
  binding: SessionBinding | null;
  status: StatusTracker;
  usage: UsageAccounting;
  /** Per-session mid-turn injection queue (W513). */
  inbox: SessionInbox;
  runner: TurnRunner;
  workerHost: WorkerHost | null;
  llm: LlmRegistry | null;
  tools: ToolRegistry | null;
  agentLoop: unknown | null;
  /** Names of the mounted plugins, in mount order (order is semantics). */
  plugins: readonly string[];
  shutdownHooks: readonly ShutdownHook[];
}

export class Runtime {
  private parts: RuntimeParts | null;
  private binding: SessionBinding | null;
  private shutdownPromise: Promise<void> | null = null;
  private released = false;

  constructor(parts: RuntimeParts) {
    this.parts = parts;
    this.binding = parts.binding;
    if (!parts.ctx.has(EVENT_BUS_SERVICE)) parts.ctx.provide(EVENT_BUS_SERVICE, createEventBus());
  }

  private get p(): RuntimeParts {
    const parts = this.parts;
    if (parts === null) throw new RuntimeReleasedError();
    return parts;
  }

  // --- handles -----------------------------------------------------------

  get ctx(): Context {
    return this.p.ctx;
  }

  get profile(): Profile {
    return this.p.profile;
  }

  get agentConfig(): AgentConfig {
    return this.p.agentConfig;
  }

  /** The active conversation log (a rebind swaps this handle). */
  get session(): SessionLog {
    return this.p.sessionRef.log;
  }

  get sessionBinding(): SessionBinding | null {
    return this.binding;
  }

  get status(): StatusTracker {
    return this.p.status;
  }

  /** The session's injection queue (drained by the turn at step boundaries). */
  get inbox(): SessionInbox {
    return this.p.inbox;
  }

  get usage(): UsageAccounting {
    return this.p.usage;
  }

  get llm(): LlmRegistry | null {
    return this.p.llm;
  }

  get tools(): ToolRegistry | null {
    return this.p.tools;
  }

  get workers(): WorkerRegistry | null {
    return this.p.workerHost?.registry ?? null;
  }

  get hostSessionId(): string | null {
    return this.p.workerHost?.hostSessionId ?? null;
  }

  get isBusy(): boolean {
    return this.parts !== null && this.parts.runner.isBusy;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Mounted plugin names, in mount order. */
  get pluginNames(): readonly string[] {
    return this.p.plugins;
  }

  // --- driving turns -----------------------------------------------------

  /** Drive one turn; a second concurrent call is a [TurnBusyError] (409). */
  async runTurn(input: string, opts: TurnOptions = {}): Promise<TurnOutcome> {
    this.assertLive();
    return this.p.runner.runTurn(input, opts);
  }

  /** Cancel the in-flight turn (cooperative); false when nothing was running. */
  cancelTurn(): boolean {
    return this.parts?.runner.cancel() ?? false;
  }

  /** Snapshot for the statusline reader (SSE status payloads / GET /api/status). */
  statusView(): StatusView {
    const p = this.p;
    return {
      model: p.profile.model,
      reasoning_effort: p.profile.reasoning_effort,
      status: p.status,
      usage: p.usage,
      context_window: p.profile.context_window_tokens,
      events: () => this.p.sessionRef.log.events(),
    };
  }

  /** The frozen `/api/status` payload for this generation. */
  statusline(): Statusline {
    return statuslineOf(this.statusView());
  }

  /**
   * W725: this generation's model-visible context, exactly as the loop would
   * build it for the NEXT step (system + trimmed history + tool schemas), or
   * null when the mounted loop has no snapshot capability (a test double).
   *
   * The assembly is the agent loop's, never this layer's: runtime only forwards
   * the Context, so the read-only snapshot cannot drift from the real request.
   */
  contextSnapshot(): ModelRequest | null {
    return contextSnapshotOf(this.p.agentLoop, this.p.ctx);
  }

  /** Pending host receipts (worker -> host) that the next turn will inject. */
  pendingReceipts(): number {
    const host = this.parts?.workerHost ?? null;
    return host === null ? 0 : host.registry.mailbox.pending(host.hostSessionId);
  }

  /**
   * Deliver a message into THIS session's inbox on `lane` (W513/W515 §1):
   * `next-turn` = drained at the next turn start (`placement: "queued"`),
   * `next-step` = drained at the next step boundary of the RUNNING turn
   * (`placement: "steering"`). The lane is the caller's decision — the host
   * knows whether a turn is in flight, the runtime does not guess.
   */
  inject(text: string, lane: InjectionLane = "next-turn", opts: InboxPushOptions = {}): InjectedMessage {
    this.assertLive();
    return this.p.inbox.push(text, lane, opts);
  }

  /** Messages queued on one lane, or on both (diagnostics / tests). */
  pendingInjections(lane?: InjectionLane): number {
    return this.parts?.inbox.pending(lane) ?? 0;
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Rebind this generation to the SAME session (same directory, same id) by
   * re-opening its log. Only between turns: mid-turn rebinding would let one
   * turn write into two logs.
   */
  rebind(binding: SessionBinding): SessionLog {
    this.assertLive();
    if (this.p.runner.isBusy) throw new TurnBusyError("rebind");
    const log = bindSession(this.p.ctx, binding);
    this.p.sessionRef.log = log;
    this.binding = binding;
    return log;
  }

  /**
   * Idempotent + re-entrant shutdown: stop drivers, run the host teardown hooks
   * (process kills), purge mailboxes, clear registries. Repeating it is a no-op
   * returning the first promise, so concurrent callers cannot double-run a hook.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise === null) this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    const parts = this.parts;
    parts?.runner.stop();
    const host = parts?.workerHost ?? null;
    if (host !== null) {
      host.registry.abortAllNow();
      await host.registry.joinDrivers();
    }
    for (const hook of parts?.shutdownHooks ?? []) await runHook(hook);
    if (host !== null) {
      host.registry.mailbox.purgeAll();
      host.registry.sessions.clear();
    }
    this.released = true;
  }

  /**
   * Explicit strong-reference drop (the sync half of a hot swap): stop the
   * runner, abort drivers, release the registry and null every handle. Call it
   * after [shutdown] when the generation is discarded for good.
   */
  release(): void {
    const parts = this.parts;
    if (parts === null) return;
    parts.runner.stop();
    if (parts.workerHost !== null) {
      parts.workerHost.registry.abortAllNow();
      parts.workerHost.registry.release();
    }
    this.parts = null;
    this.released = true;
  }

  private assertLive(): void {
    if (this.released || this.parts === null) throw new RuntimeReleasedError();
  }
}

async function runHook(hook: ShutdownHook): Promise<void> {
  try {
    await hook();
  } catch {
    // A failing teardown hook must not stop the remaining ones: shutdown is the
    // last thing a generation does, and it has to reach the end.
  }
}

/** Host-facing convenience: a sink that only collects frames (tests / CLI). */
export function collectingSink(): { frames: TurnFrame[]; sink: FrameSink } {
  const frames: TurnFrame[] = [];
  return { frames, sink: (frame) => frames.push(frame) };
}
