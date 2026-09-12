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
 * `shutdown` also marks the session's checkpoint sidecar as cleanly closed
 * (E §1.3 P0 ⑤), so the next boot can tell a graceful exit from a crash.
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
  SessionEvent,
  SessionLog,
  Statusline,
  ToolRegistry,
  TurnOutcome,
} from "@celestea/core";
import type { Watchdog, WorkerRegistry } from "@celestea/workers";
import { markCleanShutdown } from "@celestea/session";
import { RuntimeReleasedError, TurnBusyError } from "./errors.js";
import type { InjectionLane } from "@celestea/core";
import type { InboxPushOptions, InjectedMessage, SessionInbox } from "./inbox.js";
import { bindSession, type SessionBinding } from "./session-binding.js";
import { ContextPressure, statuslineOf, type StatusTracker, type StatusView } from "./status.js";
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
  /** Worker wiring + the W740 watchdog mounted over it (null when off). */
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
  /**
   * W755 (Fix B): the context-usage projection state for THIS session (one
   * generation = one session). Deliberately owned here rather than in
   * `RuntimeParts` (compose passes no such thing) and never a module singleton:
   * two live sessions must not share a prompt anchor. [rebind] re-opens the SAME
   * session, so the anchor survives it exactly like the usage tracker's does.
   */
  private readonly pressure = new ContextPressure();
  /**
   * W762: the last assembly handed out, with the log state it was built from.
   * One slot, per generation (never a module singleton, never a timer).
   */
  private snapshotCache: SnapshotCache | null = null;

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

  /**
   * W740: the liveness watchdog mounted over this generation's worker registry
   * (null when the watchdog is off). Adjudication itself belongs to the watchdog
   * plugin — this is only the host's handle on it (`tick()` by hand, or read
   * `running`), never a second liveness rule.
   */
  get watchdog(): Watchdog | null {
    return this.p.workerHost?.watchdog ?? null;
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
      // W755 (Fix A): the SAME assembly `/api/sessions/{id}/context` serves, so
      // the fallback estimate can never drift from the real next request. The
      // statusline is polled (and pushed on every SSE tick), so a failing read
      // degrades to "no snapshot" instead of failing the endpoint.
      assembled: () => {
        try {
          return this.contextSnapshot();
        } catch {
          return null;
        }
      },
      pressure: this.pressure,
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
   *
   * W762: the result is memoized on the LOG STATE it was derived from, because
   * the statusline reads it on every 2s tick and the context viewer on every
   * refresh, while a session log only changes when the engine appends to it.
   * The key is `(log identity, event count, last event reference)`, all three
   * cheap to obtain, and it is COMPLETE within one generation: the profile /
   * trim config is fixed at compose (a config change swaps the generation, not
   * this object) and the tool surface is mounted at compose too, so
   * `registry.schemas()` cannot drift under the cache. A rebind swaps the log,
   * and the identity term catches it even when the new log has the same length.
   *
   * Consumers are read-only by construction (`contextViewOf` maps messages into
   * fresh view rows; `estimatedContextTokens` only reads), so the cached object
   * is shared rather than copied. A MISS costs one extra `events()` copy (the
   * key) on top of the assembly: ~0.35ms at 50k events against an 18ms
   * assembly. A HIT costs only that copy — ~2 orders of magnitude less.
   */
  contextSnapshot(): ModelRequest | null {
    const log = this.p.sessionRef.log;
    const last = lastEventOf(log);
    const cached = this.snapshotCache;
    if (cached !== null && cached.log === log && cached.events === last.count && cached.last === last.event) {
      return cached.request;
    }
    const request = contextSnapshotOf(this.p.agentLoop, this.p.ctx);
    this.snapshotCache = { log, events: last.count, last: last.event, request };
    return request;
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
    // W762: the cached assembly belonged to the log that was just swapped out.
    this.snapshotCache = null;
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
    // E §1.3 P0 ⑤: a graceful teardown is the ONLY thing that may claim
    // `clean_shutdown: true` in the session's checkpoint sidecar — that flag is
    // what tells the next boot "do not repair", so a crash (no shutdown at all)
    // keeps it false. A log without a checkpoint (tests, embedded use) is a no-op.
    markCleanShutdown(parts?.sessionRef.log);
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
    this.snapshotCache = null;
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

/**
 * W762: one memoized assembly — the request plus the log state it was built
 * from. `events` is the event COUNT and `last` the last event REFERENCE (not an
 * index): a log that grew and then got trimmed back to the same length would
 * still be caught by the reference.
 */
interface SnapshotCache {
  log: SessionLog;
  events: number;
  last: SessionEvent | undefined;
  request: ModelRequest | null;
}

/** `(count, last event)` of a log — the cache key half that changes on append. */
function lastEventOf(log: SessionLog): { count: number; event: SessionEvent | undefined } {
  const events = log.events();
  return { count: events.length, event: events[events.length - 1] };
}

/** Host-facing convenience: a sink that only collects frames (tests / CLI). */
export function collectingSink(): { frames: TurnFrame[]; sink: FrameSink } {
  const frames: TurnFrame[] = [];
  return { frames, sink: (frame) => frames.push(frame) };
}
