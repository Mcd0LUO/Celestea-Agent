/**
 * The REAL `RuntimeAdapter` — `packages/runtime` mounted behind the engine seam.
 *
 * W513 shape: this class is a HOST over a [SessionRuntimeRegistry], not a single
 * engine. Every session gets its own composition (own agent loop, own tool
 * registry, own status/usage trackers, own worker registry, own session log,
 * own inbox) created lazily on first use, reused while the profile epoch is
 * current, and reclaimed when idle. There is no "global main session":
 * `workspaces.json.active_session` is only the view the UI should restore.
 *
 * W742 lifecycle (both were documented before but not wired):
 *   - an epoch bump (POST /api/config, POST /api/providers/default, a grant
 *     write) NEVER tears down an instance that is still driving workers: the
 *     registry only marks it and rebuilds it once those workers ended, so a
 *     model switch can no longer abort a background worker and erase its rows
 *     (the HTTP 409 guards of both endpoints close the same hole up front);
 *   - `CELESTEA_SESSION_IDLE_TTL_MS` is real: the registry's unref'ed reclaimer
 *     sweeps deferrable rebuilds + the idle TTL in the background, and
 *     `shutdown()` disarms it (no timer outlives the engine).
 *
 * Mapping (host HTTP surface -> composition / engine):
 *   POST /api/turn                  -> `startTurn` (idle) or `inject` (busy);
 *   GET  /api/events                -> `attach(bus)`, frames carry the session;
 *   POST /api/sessions/{id}/activate-> `ensureSession` (never 409);
 *   POST /api/cancel                -> the target session's AbortController;
 *   POST /api/clear                 -> the target session log's `clear()`;
 *   POST /api/sessions/{id}/compact -> `runCompaction` + that instance rebuilt;
 *   GET  /api/status                -> the requested session's statusline;
 *   GET  /api/tools                 -> the composed `ToolRegistry.schemas()`;
 *   GET+POST /api/config            -> bump the profile epoch (lazy rebuild);
 *   worker endpoints                -> per-session registries, merged for reads.
 *
 * The per-session turn/state machinery lives in the registry and the composition
 * in `session-compose.ts`; this file is the seam implementation the handlers see.
 *
 * LLM: an injected seam wins (tests / replay inject the OFFLINE deterministic
 * engine, so no test, no contract check and no replay reaches the network); with
 * nothing injected each instance is assembled against the profile's provider
 * (`llm-assembly.ts`), i.e. production is a real model.
 */

import type { InjectionPlacement, InjectionLane, PendingInjection, Statusline, TurnOutcome, WorkerEntry } from "@celestea/core";
import { getExtra, hasInProgressTurn, type Watchdog, type WorkerRegistry } from "@celestea/workers";
import { createSessionInbox, type InjectedMessage, type SessionInbox } from "@celestea/runtime";
import {
  autowakeEnabled,
  coldStatusline,
  keyOfSession,
  outcomePhaseOf,
  HOST_SESSION_ID,
  runCompaction,
  SessionRuntimeRegistry,
  statuslineOf,
  TurnBusyError,
  type Profile,
  type SessionRuntime,
} from "@celestea/runtime";
import { join } from "node:path";
import { CapacityError, EngineError, toolSpecView } from "../runtime-adapter.js";
import { HostAutowake, autowakeLog } from "./host-autowake.js";
import { sessionContextOf } from "./context-snapshot.js";
import { mergedWorkerRows, sendWorkerThrough, spawnWorkerThrough, workerMessagesAcross } from "./worker-bridge.js";
import type {
  ClearOutcome,
  CompactOutcome,
  EngineProfile,
  InjectOutcome,
  ProfilePatch,
  RuntimeAdapter,
  SessionContextView,
  SessionRuntimeInfo,
  ToolInfo,
  TurnRequest,
  TurnStart,
  WorkerSendRequest,
  WorkerSessionRow,
  WorkerSpawnOutcome,
  WorkerSpawnRequest,
  WorkerStatusReport,
} from "../runtime-adapter.js";
import type { StudioBus } from "../sse.js";
import { contextViewOf } from "./context-snapshot.js";
import { applyProfilePatch, defaultEngineProfile, engineProfileOf, profileFromEngine } from "./engine-profile.js";
import { SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
import {
  capacityErrorOf,
  disposeRuntime,
  limitFromEnv,
  MAX_CONCURRENT_TURNS,
  MAX_LIVE_SESSIONS,
  SESSION_IDLE_TTL_MS,
  SessionComposer,
  type SessionComposerOptions,
} from "./session-compose.js";
import {
  dispatchWorkerTool,
  sendBodyOf,
  spawnOutcomeOf,
  workerMessagesOf,
  workerSessionsOf,
} from "./worker-bridge.js";
import { inboxMessageOf } from "./inbox-message.js";
import { watchdogCount, watchdogOf, watchdogRunningOf, workerStatusOf } from "./watchdog-view.js";

export { SESSION_LOG_ID, SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
export { MAX_CONCURRENT_TURNS, MAX_LIVE_SESSIONS, SESSION_IDLE_TTL_MS } from "./session-compose.js";

/** Everything the composer needs, plus the resource caps. */
export interface RealRuntimeAdapterOptions extends Omit<SessionComposerOptions, "env" | "baseProfile"> {
  /** Startup engine profile (see [defaultEngineProfile]). */
  profile?: EngineProfile;
  /** Process environment (provider keys, tool roots, resource caps). */
  env?: NodeJS.ProcessEnv;
  /** Live-instance cap (default [MAX_LIVE_SESSIONS] / `CELESTEA_MAX_LIVE_SESSIONS`). */
  maxLiveSessions?: number;
  /** Concurrent-turn cap (default [MAX_CONCURRENT_TURNS]). */
  maxConcurrentTurns?: number;
  /** Idle TTL for the reclaimer (default [SESSION_IDLE_TTL_MS]). */
  idleTtlMs?: number;
}

/** `RuntimeAdapter` + the lifecycle handles the host needs beyond the seam. */
export interface RealRuntimeAdapter extends RuntimeAdapter {
  /** Epoch of the current profile generation (bumped by every configure). */
  generationEpoch(): number;
  /** Absolute path of the default (detached) session log (null = in memory). */
  sessionLogPath(): string | null;
  /** Set the engine system prompt used by the next composed generation. */
  primeSystemPrompt(prompt: string): void;
  /** The last terminal turn state over every session (diagnostics / tests). */
  lastTurnOutcome(): TurnOutcome | null;
  /**
   * W740: the liveness watchdog of the session's instance (null when the
   * watchdog is off). The timer is scheduled by the composition root; this
   * handle is how the host inspects or hand-ticks it.
   */
  watchdog(session?: string | null): Watchdog | null;
  /** Is this session's sweep timer running? (no instance = false.) */
  watchdogRunning(session?: string | null): boolean;
  /** The session's live worker registry, or null when it has no instance. */
  workersOf(session?: string | null): WorkerRegistry | null;
  /** Tear every live instance down (idempotent). */
  shutdown(): Promise<void>;
}

/** Optional fields of one status frame (`source` marks the W769 auto-wake). */
interface StatusExtra {
  error?: string;
  source?: "autowake";
}

class RealEngine implements RealRuntimeAdapter {
  readonly name = "real-runtime-adapter";
  private readonly opts: RealRuntimeAdapterOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly composer: SessionComposer;
  private readonly registry: SessionRuntimeRegistry;
  private profileValue: Profile;
  private bus: StudioBus | null = null;
  private baseEpoch = 0;
  private toolCalls = 0;
  private shutdownPromise: Promise<void> | null = null;
  /**
   * W769: the wake-up loops (one per host conversation; see `host-autowake.ts`).
   * They carry no turn logic: the adapter supplies the wake callback below.
   */
  private readonly autowake: HostAutowake;

  constructor(opts: RealRuntimeAdapterOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.autowake = new HostAutowake({
      enabled: autowakeEnabled(this.env),
      lookup: (session) => {
        const entry = this.registry.peek(session);
        return entry === null ? null : { mailbox: entry.runtime.workers?.mailbox ?? null, busy: entry.inFlight };
      },
      wake: (session, input) => this.startAutowakeTurn(session, input),
    });
    this.profileValue = profileFromEngine(opts.profile ?? defaultEngineProfile(this.env, "CELESTEA_API_KEY"));
    this.composer = new SessionComposer({
      ...opts,
      env: this.env,
      baseProfile: () => this.profileValue,
      sessionHooks: (sessionId) => this.injectionHooks(sessionId),
    });
    this.registry = new SessionRuntimeRegistry({
      build: (sessionId, dir) => {
        const runtime = this.composer.compose(sessionId, dir);
        // W769: every host conversation gets a wake-up loop over its OWN mailbox.
        this.autowake.ensure(sessionId);
        return runtime;
      },
      dispose: (runtime) => disposeRuntime(runtime),
      currentEpoch: () => this.baseEpoch,
      maxLive: opts.maxLiveSessions ?? limitFromEnv(this.env, "CELESTEA_MAX_LIVE_SESSIONS", MAX_LIVE_SESSIONS),
      maxConcurrentTurns: opts.maxConcurrentTurns ?? limitFromEnv(this.env, "CELESTEA_MAX_CONCURRENT_TURNS", MAX_CONCURRENT_TURNS),
      idleTtlMs: opts.idleTtlMs ?? limitFromEnv(this.env, "CELESTEA_SESSION_IDLE_TTL_MS", SESSION_IDLE_TTL_MS),
      // The detached instance is never reclaimed (it backs `/api/tools`), nor is a
      // session that still OWNS worker rows (W513 pin) — a settled row keeps its
      // session's instance and its parked driver, exactly as before.
      pinned: (entry) => entry.key === keyOfSession(null) || (entry.runtime.workers?.ownEntries().length ?? 0) > 0,
      // W742 §1: only LIVE worker work defers a rebuild; a settled, parked worker
      // must not block the generation swap of its session forever.
      rebuildDeferred: (entry) => this.hasLiveWorkers(entry),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    // W742 §2: arm the low-frequency reclaimer (unref'ed; `shutdown` disarms it).
    this.registry.startReclaimer();
    this.registry.ensure(null, null);
  }

  // --- host lifecycle ----------------------------------------------------

  attach(bus: StudioBus): void {
    this.bus = bus;
  }

  generationEpoch(): number {
    return this.baseEpoch;
  }

  sessionLogPath(): string | null {
    const path = (this.registry.peek(null)?.runtime.session as { path?: unknown } | undefined)?.path;
    return typeof path === "string" ? path : null;
  }

  primeSystemPrompt(prompt: string): void {
    if (prompt === "" || prompt === this.profileValue.system_prompt) return;
    this.profileValue = { ...this.profileValue, system_prompt: prompt };
    this.bumpEpoch();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise === null) {
      // W769: unpark the wake-up loops FIRST: a loop that grabbed a queue during
      // the teardown would otherwise start a turn on a disposing runtime.
      this.shutdownPromise = this.autowake.stop().then(() => this.registry.shutdown());
    }
    await this.shutdownPromise;
  }

  /** Is auto-wake on? (`CELESTEA_AUTOWAKE`, read once at construction.) */
  get autowakeRunning(): boolean {
    return this.autowake.running;
  }
  /**
   * Run ONE ordinary turn with the drained receipts as its input — the same
   * `beginTurn` + status + `drive` path a `POST /api/turn` takes, with
   * `source: "autowake"` on the start frame (contracts/sse-events.json allows
   * it). Returns false when the slot is gone (session deleted) or already taken
   * (busy): the loop then re-queues the messages into the CURRENT generation and
   * retries, so nothing is lost and nothing is consumed twice.
   */
  private startAutowakeTurn(session: string | null, input: string): boolean {
    const entry = this.registry.peek(session);
    if (entry === null || entry.inFlight) return false;
    try {
      const turn = this.launch(entry, input, "autowake");
      autowakeLog(session, `woke the host: turn ${turn}`);
      return true;
    } catch (error) {
      // Capacity (max concurrent turns) is the one raciness we can retry: the
      // loop re-queues and comes back.
      if (error instanceof CapacityError) return false;
      throw error;
    }
  }

  /** The composed tool registry of the default instance (`GET /api/tools`). */
  tools(): ToolInfo[] {
    return (this.registry.peek(null)?.runtime.tools?.schemas() ?? []).map(toolSpecView);
  }

  /**
   * W729 (S2): the tool face of ONE session — PEEKED, never composed, because
   * the composer calls this while building that session's own prompt. A session
   * with no live instance reads the default generation, which in P0 exposes
   * exactly the same 10 tools (§1.2).
   */
  sessionTools(session: string | null): ToolInfo[] {
    const own = session === null ? null : this.registry.peek(session);
    return ((own ?? this.registry.peek(null))?.runtime.tools?.schemas() ?? []).map(toolSpecView);
  }

  /**
   * W515 §2/§4: the session's inbox publishes every placement change on the bus
   * (`queued`/`steering` when a message is accepted, `context` when a boundary
   * consumes it), carrying the envelope so a settlement notice stays
   * distinguishable from a deliberate relay message.
   */
  private injectionHooks(sessionId: string | null): { inbox: SessionInbox; onInjected: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void } {
    const publish = (placement: InjectionPlacement, message: InjectedMessage, boundary?: "turn-start" | "step"): void => {
      this.bus?.emit(
        "status",
        0,
        {
          phase: "progress",
          placement,
          ...(boundary === undefined ? {} : { boundary }),
          message: {
            id: message.id,
            kind: message.kind,
            from: message.from,
            lane: message.lane,
            source: message.source,
            summary: message.source.summary ?? message.text.slice(0, 120),
          },
          statusline: {},
        },
        sessionId,
      );
    };
    return {
      // Only the ACCEPT side is observed here: the `context` placement is
      // published once, by `onInjected`, which also knows WHICH boundary
      // consumed the message (a mailbox receipt never enters the inbox).
      inbox: createSessionInbox(this.now, { onQueued: (message, placement) => publish(placement, message) }),
      onInjected: (messages, boundary) => {
        for (const message of messages) publish("context", inboxMessageOf(message), boundary);
      },
    };
  }

  // --- sessions ----------------------------------------------------------

  /** The session's instance (creating it, and making room, when needed). */
  private entryFor(session: string | null): SessionRuntime {
    try {
      return this.registry.ensure(session, session === null ? null : (this.opts.resolveSession?.(session)?.dir ?? null));
    } catch (e) {
      throw capacityErrorOf(e);
    }
  }

  ensureSession(session: string | null): SessionRuntimeInfo {
    const before = this.registry.peek(session);
    // The registry rebuilds an instance IN PLACE (the entry object survives), so
    // the comparison has to be on the runtime, not on the entry (W516: a grant
    // invalidates exactly one session, and `rebuilt` is how the host sees it).
    const previous = before?.runtime;
    const entry = this.entryFor(session);
    return {
      runtime: before === null ? "created" : "reused",
      busy: entry.inFlight,
      rebuilt: previous !== undefined && previous !== entry.runtime,
    };
  }

  /**
   * W516 §4.2: the session's grants were written, so ITS instance is stale. An
   * idle instance is recomposed now, a busy one at its next turn boundary — and
   * no other session is touched (that is why this is not `invalidateAll`).
   */
  invalidateSession(session: string | null): boolean {
    return this.registry.invalidateSession(session);
  }

  liveSessions(): string[] {
    return this.registry.liveSessionIds();
  }

  busySessions(): string[] {
    return this.registry.busySessionIds();
  }

  // --- turns -------------------------------------------------------------

  isBusy(session?: string | null): boolean {
    if (session === undefined) return this.registry.inFlightCount() > 0;
    return this.registry.peek(session)?.inFlight ?? false;
  }

  async startTurn(req: TurnRequest): Promise<TurnStart> {
    const entry = this.entryFor(req.session);
    if (entry.inFlight) throw new TurnBusyError("turn");
    // W515 §2: this input IS the turn, so it is already in the context.
    return { turn: this.launch(entry, req.input), placement: "context" };
  }

  /**
   * Claim the slot and start one turn — the ONE path both a manual turn and a
   * W769 auto-wake take, so SSE frames, statusline phases, the turn number and
   * the busy guard cannot differ between them.
   */
  private launch(entry: SessionRuntime, input: string, source?: "autowake"): number {
    const controller = new AbortController();
    const turn = this.beginTurn(entry, controller);
    this.emitStatus(entry, turn, "start", source === null ? {} : { source });
    void this.drive(entry, input, turn, controller);
    return turn;
  }

  /**
   * W513/W515 §1-§3: the delivery decision table in one place —
   *   owner session RUNNING (or closing) -> `next-step` lane, a STEERING message
   *   consumed at the running turn's next step boundary (`injected: true`);
   *   owner session IDLE -> `next-turn` lane, QUEUED for the next turn start.
   * The lane is what makes "insert now" and "wake me later" the same mechanism.
   */
  inject(req: TurnRequest): InjectOutcome {
    const entry = this.registry.peek(req.session);
    const busy = entry?.inFlight === true;
    const lane = busy ? "next-step" : "next-turn";
    const target = entry ?? this.entryFor(req.session);
    const message = target.runtime.inject(req.input, lane, { kind: "user", source: { kind: "user", form: "message" } });
    target.lastActiveAt = this.now();
    return {
      turn: target.turnNo,
      injected: busy,
      pending: target.runtime.pendingInjections(lane),
      placement: busy ? "steering" : "queued",
      duplicate: message.duplicate,
    };
  }

  private beginTurn(entry: SessionRuntime, controller: AbortController): number {
    try {
      return this.registry.beginTurn(entry, controller);
    } catch (e) {
      throw capacityErrorOf(e);
    }
  }

  /** Drive one turn to its terminal state, then publish the closing status. */
  private async drive(entry: SessionRuntime, input: string, turn: number, controller: AbortController): Promise<void> {
    try {
      const outcome = await entry.runtime.runTurn(input, {
        signal: controller.signal,
        sink: (frame) => this.bus?.emit(frame.event, turn, frame.payload, entry.sessionId),
      });
      this.registry.endTurn(entry, outcome);
      this.emitStatus(entry, turn, outcomePhaseOf(outcome));
    } catch (e) {
      this.registry.endTurn(entry, null);
      this.emitStatus(entry, turn, "error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  cancel(session?: string | null): boolean {
    const entry = session === undefined ? this.newestBusy() : this.registry.peek(session);
    if (entry === null || entry === undefined || !entry.inFlight || entry.controller === null) return false;
    entry.controller.abort();
    return true;
  }

  private newestBusy(): SessionRuntime | null {
    for (const entry of this.registry.list()) if (entry.inFlight) return entry;
    return null;
  }

  lastTurnOutcome(): TurnOutcome | null {
    let best: SessionRuntime | null = null;
    for (const entry of this.registry.list()) {
      if (entry.lastOutcome === null) continue;
      if (best === null || entry.lastActiveAt >= best.lastActiveAt) best = entry;
    }
    return best?.lastOutcome ?? null;
  }

  // --- workers: liveness (W740) ------------------------------------------

  /** The session's watchdog (see `watchdog-view.ts`); unknown = null, never composed. */
  watchdog(session?: string | null): Watchdog | null {
    return watchdogOf(this.registry, session);
  }

  /** Is this session's sweep timer running? (no instance / watchdog off = false.) */
  watchdogRunning(session?: string | null): boolean {
    return watchdogRunningOf(this.registry, session);
  }

  /** The session's live worker registry, or null when it has no instance. */
  workersOf(session?: string | null): WorkerRegistry | null {
    return this.registry.peek(session ?? null)?.runtime.workers ?? null;
  }

  private emitStatus(entry: SessionRuntime, turn: number, phase: string, extra: StatusExtra = {}): void {
    this.bus?.emit("status", turn, { phase, statusline: entry.runtime.statusline(), ...extra }, entry.sessionId);
  }

  // --- host views --------------------------------------------------------

  profile(): EngineProfile {
    return engineProfileOf(this.profileValue);
  }

  /**
   * W725: the session's model-visible context (`GET /api/sessions/{id}/context`).
   * The instance is ensured first (same path as activate / a turn), then the
   * agent loop assembles the request — this adapter only forwards it, so the
   * snapshot is the engine's own, never a host-side re-derivation.
   */
  sessionContext(session: string | null): SessionContextView {
    // W729: THAT session's profile (mode variant included), not the process's.
    return sessionContextOf(this.entryFor(session).runtime, this.composer.profileFor(session));
  }

  /** The requested session's statusline (no instance yet = an empty one). */
  statusline(session?: string | null): Statusline {
    const entry = this.registry.peek(session ?? null);
    if (entry !== null) return entry.runtime.statusline();
    // W755: a cold session measures nothing — `coldStatusline` owns that shape.
    const profile = this.profileValue;
    return coldStatusline({ ...profile, context_window: profile.context_window_tokens, now: this.now });
  }

  async configure(patch: ProfilePatch): Promise<EngineProfile> {
    if (patch.api_key !== undefined && patch.api_key !== "") this.env[this.profileValue.api_key_env] = patch.api_key;
    this.profileValue = applyProfilePatch(this.profileValue, patch);
    this.bumpEpoch();
    return this.profile();
  }

  /** Config change: instances are rebuilt lazily, at their next turn boundary. */
  private bumpEpoch(): void {
    this.baseEpoch += 1;
    this.registry.invalidateAll();
  }

  async clear(session: string | null): Promise<ClearOutcome> {
    const entry = this.registry.peek(session);
    if (entry !== null) {
      if (entry.inFlight) throw new TurnBusyError("clear");
      entry.runtime.session.clear();
      entry.turnNo = 0;
    }
    return { cleared: true };
  }

  async compact(session: string): Promise<CompactOutcome> {
    const target = this.opts.resolveSession?.(session) ?? null;
    if (target === null || target.dir === null) {
      return { compacted: false, note: SKIPPED_NOTE, session, rebound: false };
    }
    const live = this.registry.peek(session) !== null;
    if (live) await this.registry.evict(keyOfSession(session));
    const result = await this.runCompact(join(target.dir, SESSION_LOG_NAME));
    if (live) this.registry.ensure(session, target.dir);
    return {
      compacted: result.compacted,
      ...(result.compacted && result.kept_turns !== null ? { kept_turns: result.kept_turns } : {}),
      note: result.note,
      session,
      rebound: live && result.compacted,
    };
  }

  private async runCompact(logPath: string): Promise<{ compacted: boolean; kept_turns: number | null; note: string }> {
    try {
      return await runCompaction({ logPath, summarize: this.composer.summarizer() });
    } catch (e) {
      throw new EngineError(e instanceof Error ? e.message : String(e));
    }
  }

  // --- workers -----------------------------------------------------------

  /** Merged worker rows over every live instance (W513 aggregate view). */
  workerSessions(): WorkerSessionRow[] {
    return mergedWorkerRows(this.registry.list());
  }

  workerMessages(sessionId: string): unknown[] | null {
    return workerMessagesAcross(this.registry.list(), sessionId);
  }

  async workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome> {
    return spawnWorkerThrough(this.entryFor(req.session ?? null), req, `host-spawn-${(this.toolCalls += 1)}`);
  }

  async workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>> {
    return sendWorkerThrough(this.registry.list(), req, () => `host-send-${(this.toolCalls += 1)}`);
  }

  /**
   * W740 §2: the panel/tool face is where a watchdog verdict becomes visible —
   * `by_status` counts the registry rows, so a settle changes it, and the count of
   * live sweepers rides along.
   */
  workerStatus(wid?: string): WorkerStatusReport {
    return workerStatusOf(this.workerSessions(), watchdogCount(this.registry.list()), wid);
  }

  // --- internals ---------------------------------------------------------

  /**
   * W742 §1: does this instance still hold LIVE background work? Two things count:
   * a RUNNING row (the brief has no terminal verdict — W736 freezes it exactly
   * once) and a worker session with an OPEN turn (a follow-up message being
   * answered; the row is already settled by then, so the log is the only witness).
   * A parked, settled worker is addressable but idle: it must NOT keep its
   * session's generation frozen, or a config change would never land there.
   */
  private hasLiveWorkers(entry: SessionRuntime): boolean {
    const workers = entry.runtime.workers;
    return workers !== null && workers.ownEntries().some((row) => row.status === "RUNNING" || openTurnOf(workers, row));
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }
}

/** W742 §1: is a turn OPEN on this worker's own session log? (W736's rule.) */
function openTurnOf(workers: WorkerRegistry, row: WorkerEntry): boolean {
  const log = workers.sessions.logOf(getExtra(row, "sess") ?? "");
  return log !== undefined && hasInProgressTurn(log.events());
}

/** The frozen "nothing to compact" note (kept in sync with compact/plan.ts). */
const SKIPPED_NOTE = "历史不足，无需压缩";

/** Build the real adapter (the host's default engine). */
export function createRealRuntimeAdapter(opts: RealRuntimeAdapterOptions = {}): RealRuntimeAdapter {
  return new RealEngine(opts);
}
