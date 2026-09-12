/**
 * SessionRuntimeRegistry — `session id -> independent Runtime instance` (W513).
 *
 * The registry is what removes the "single active session" from the engine: no
 * generation is global any more, every session owns its own composition, its own
 * busy slot, its own status/usage tracker, its own session log and its own
 * inbox. Instances are created lazily (`ensure`), reused while the profile epoch
 * is current, rebuilt at the next turn boundary when it is not, and reclaimed
 * when idle (LRU + TTL).
 *
 * Invariants (all of them are tested):
 *   - `ensure` is idempotent: two calls return the SAME instance, so a session
 *     can never be composed twice and two writers can never target one log;
 *   - busy is PER INSTANCE: the runner's slot was always per runtime, the
 *     registry only stops treating any turn as "the process is busy";
 *   - an in-flight instance is never rebuilt and never evicted — a running turn
 *     is not interrupted by a config change, by LRU pressure or by a neighbour's
 *     traffic;
 *   - capacity is explicit: over `maxLive` the registry reclaims idle instances
 *     first and throws [SessionCapacityError] (503 + Retry-After at the host)
 *     when every instance is busy; over `maxConcurrentTurns` a NEW turn is
 *     refused with [TurnCapacityError] instead of being silently queued.
 *
 * W742 (the two lifecycle promises the audit found unimplemented):
 *   - §1 REBUILD RESPECTS LIVE WORK. A rebuild disposes the old instance, which
 *     shuts the composed runtime down — aborting in-flight workers and dropping
 *     their registry rows. An instance that still holds live background work
 *     (see `rebuildDeferred`) is therefore only MARKED when the epoch bumps, and
 *     [settleDeferred] recomposes it once that work has ended. The host owns the
 *     callback that decides what "live work" means; the registry owns the order.
 *   - §2 THE IDLE TTL IS REAL. [startReclaimer] arms ONE low-frequency, `unref`ed
 *     timer that runs [sweep] (deferred rebuilds + [evictIdle]), so
 *     `CELESTEA_SESSION_IDLE_TTL_MS` actually reclaims something; [shutdown]
 *     disarms it, so no timer outlives the engine it belongs to.
 */

import type { TurnOutcome } from "@celestea/core";
import { nextTurnNumber } from "@celestea/session";
import type { Runtime } from "./runtime.js";
import { migrateReceipts } from "./gen.js";
import { HOST_SESSION_ID } from "./tokens.js";

/** Registry key of the "no session" runtime (turns without an active session). */
export const DETACHED_SESSION_KEY = "<detached>";

/** One session's whole runtime state: the instance plus its own slots. */
export interface SessionRuntime {
  /** Registry key (`sessionId`, or [DETACHED_SESSION_KEY] when null). */
  readonly key: string;
  readonly sessionId: string | null;
  /** Session directory (null = detached/in-memory). */
  dir: string | null;
  /** Profile epoch the instance was composed from. */
  profileEpoch: number;
  runtime: Runtime;
  /**
   * Turns started on THIS session (per-session numbering, contract §4.1),
   * seeded from the session log at `ensure` / `rebuild` (E §1.3 P0 ④).
   */
  turnNo: number;
  /** In-flight turn's cancel handle (null between turns). */
  controller: AbortController | null;
  inFlight: boolean;
  /** Terminal state of the last turn on this session (diagnostics). */
  lastOutcome: TurnOutcome | null;
  /** LRU stamp (updated by ensure / beginTurn / endTurn). */
  lastActiveAt: number;
  /** Set when a config epoch bumped while the instance was busy. */
  needsRebuild: boolean;
}

export interface SessionRegistryDeps {
  /** Compose one instance (the host injects `compose(...)` here). */
  build: (sessionId: string | null, dir: string | null, epoch: number) => Runtime;
  /** Tear one instance down (shutdown + release); never called on a busy one. */
  dispose: (runtime: Runtime) => Promise<void> | void;
  /** Current profile epoch; an instance behind it is rebuilt on next use. */
  currentEpoch?: () => number;
  /** Live-instance cap (0 = unlimited). */
  maxLive?: number;
  /** Concurrent-turn cap across every instance (0 = unlimited). */
  maxConcurrentTurns?: number;
  /** Idle TTL for [SessionRuntimeRegistry.evictIdle]; 0 = never by TTL. */
  idleTtlMs?: number;
  /**
   * W742 §2: reclaimer period for [SessionRuntimeRegistry.startReclaimer];
   * <= 0 (or omitted) = derive it from `idleTtlMs` (a quarter of the TTL, at
   * least 1s, 0 when the TTL itself is 0 = nothing to reclaim).
   */
  reclaimerMs?: number;
  /**
   * `true` pins an instance: never reclaimed and not counted against `maxLive`.
   * The host pins the detached default instance and every session that OWNS
   * worker rows. Whether an instance may be REBUILT is a different question, with
   * its own callback ([SessionRegistryDeps.rebuildDeferred]).
   */
  pinned?: (entry: SessionRuntime) => boolean;
  /**
   * W742 §1: `true` = disposing this instance would kill LIVE background work
   * (unsettled workers). Its rebuild is DEFERRED, never skipped: the epoch bump
   * only marks the instance and [SessionRuntimeRegistry.settleDeferred] (or the
   * reclaimer's [SessionRuntimeRegistry.sweep]) recomposes it as soon as this
   * returns false. Absent = every rebuild is allowed (tests, embedded hosts).
   */
  rebuildDeferred?: (entry: SessionRuntime) => boolean;
  now?: () => number;
}

/** Raised when no live-instance slot can be made free (host maps it to 503). */
export class SessionCapacityError extends Error {
  readonly kind = "session_capacity";
  readonly limit: number;
  constructor(limit: number) {
    super(`too many live sessions (limit ${limit})`);
    this.name = "SessionCapacityError";
    this.limit = limit;
  }
}

/** Raised when the concurrent-turn cap is reached (host maps it to 503). */
export class TurnCapacityError extends Error {
  readonly kind = "turn_capacity";
  readonly limit: number;
  constructor(limit: number) {
    super(`too many concurrent turns (limit ${limit})`);
    this.name = "TurnCapacityError";
    this.limit = limit;
  }
}

/**
 * The session-local turn number, restored FROM THE LOG (E §1.3 P0 ④): the log
 * owns the `turn-<n>` counter, so `maxTurnNumber(events)+1` is the next number
 * this session would have used and the counter can never restart at 0 across a
 * process restart (`POST /api/turn`'s `turn` stays comparable with the ids in
 * `cli-main.jsonl`). A brand new session has no events -> 0, exactly as before.
 */
function turnNumberFromLog(runtime: Runtime): number {
  return nextTurnNumber(runtime.session.events());
}

/** Key of a session id (`null` = the detached instance). */
export function keyOfSession(sessionId: string | null): string {
  return sessionId ?? DETACHED_SESSION_KEY;
}

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, SessionRuntime>();
  private readonly deps: SessionRegistryDeps;
  private readonly now: () => number;
  /** W742 §2: the armed low-frequency reclaimer (null = disarmed). */
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SessionRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Live instance count. */
  get size(): number {
    return this.entries.size;
  }

  /** The session's instance, or null (never creates one). */
  peek(sessionId: string | null): SessionRuntime | null {
    return this.entries.get(keyOfSession(sessionId)) ?? null;
  }

  /** Every live instance, in creation order. */
  list(): readonly SessionRuntime[] {
    return [...this.entries.values()];
  }

  /** Session ids of the live instances (detached reported as `null`-free list). */
  liveSessionIds(): string[] {
    return this.list()
      .map((e) => e.sessionId)
      .filter((id): id is string => id !== null);
  }

  /** Session ids with an in-flight turn. */
  busySessionIds(): string[] {
    return this.list()
      .filter((e) => e.inFlight)
      .map((e) => e.sessionId)
      .filter((id): id is string => id !== null);
  }

  inFlightCount(): number {
    return this.list().filter((e) => e.inFlight).length;
  }

  /** The session's instance, creating it (and making room) when needed. */
  ensure(sessionId: string | null, dir: string | null): SessionRuntime {
    const key = keyOfSession(sessionId);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.lastActiveAt = this.now();
      if (existing.dir === null && dir !== null) existing.dir = dir;
      this.settleEpoch(existing);
      return existing;
    }
    this.makeRoom(key, key === DETACHED_SESSION_KEY);
    const epoch = this.epoch();
    const runtime = this.deps.build(sessionId, dir, epoch);
    const entry: SessionRuntime = {
      key,
      sessionId,
      dir,
      profileEpoch: epoch,
      runtime,
      turnNo: turnNumberFromLog(runtime),
      controller: null,
      inFlight: false,
      lastOutcome: null,
      lastActiveAt: this.now(),
      needsRebuild: false,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** Grab this session's turn slot; returns the session-local turn number. */
  beginTurn(entry: SessionRuntime, controller: AbortController): number {
    const max = this.deps.maxConcurrentTurns ?? 0;
    if (max > 0 && this.inFlightCount() >= max) throw new TurnCapacityError(max);
    entry.inFlight = true;
    entry.controller = controller;
    entry.turnNo += 1;
    entry.lastOutcome = null;
    entry.lastActiveAt = this.now();
    return entry.turnNo;
  }

  /** Release this session's turn slot and record the terminal state. */
  endTurn(entry: SessionRuntime, outcome: TurnOutcome | null): void {
    entry.inFlight = false;
    entry.controller = null;
    entry.lastOutcome = outcome;
    entry.lastActiveAt = this.now();
  }

  /**
   * Config epoch changed: idle instances are recomposed at once, busy ones are
   * MARKED and rebuild at their next turn boundary (a running turn is never
   * interrupted and never sees a half-swapped profile).
   */
  invalidateAll(): void {
    for (const entry of this.entries.values()) {
      entry.needsRebuild = entry.needsRebuild || entry.profileEpoch < this.epoch() || entry.inFlight;
      this.settleEpoch(entry);
    }
  }

  /**
   * ONE session's generation changed (W516: its `grants.json` was written).
   * The security boundary of a session instance is fixed for the whole turn, so
   * an idle instance is recomposed immediately while a busy one is marked and
   * rebuilds at its next turn boundary — exactly like a config epoch bump, but
   * scoped: neighbours keep their instances and their own boundaries.
   */
  invalidateSession(sessionId: string | null): boolean {
    const entry = this.entries.get(keyOfSession(sessionId));
    if (entry === undefined) return false;
    entry.needsRebuild = true;
    this.settleEpoch(entry);
    return true;
  }

  /** Reclaim idle instances past the TTL; returns the reclaimed keys. */
  async evictIdle(): Promise<string[]> {
    const ttl = this.deps.idleTtlMs ?? 0;
    if (ttl <= 0) return [];
    const deadline = this.now() - ttl;
    const keys = this.list()
      .filter((e) => e.lastActiveAt <= deadline)
      .map((e) => e.key);
    const evicted: string[] = [];
    for (const key of keys) if (await this.evict(key)) evicted.push(key);
    return evicted;
  }

  /** Reclaim one instance (false when it is busy, pinned or unknown). */
  async evict(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.inFlight || this.isPinned(entry)) return false;
    this.entries.delete(key);
    await this.deps.dispose(entry.runtime);
    return true;
  }

  /**
   * W742 §1: recompose every marked instance whose live work has ENDED — the
   * counterpart of the deferral in [settleEpoch]. Returns the keys that were
   * actually rebuilt, so the host can report the generation swap it just did.
   */
  settleDeferred(): string[] {
    const rebuilt: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.needsRebuild || entry.inFlight || this.rebuildIsDeferred(entry)) continue;
      this.rebuild(entry);
      rebuilt.push(entry.key);
    }
    return rebuilt;
  }

  /**
   * W742 §2: ONE reclaimer pass. The TTL is applied FIRST: a stale instance that
   * is past its idle deadline is reclaimed, so it is never recomposed just to be
   * thrown away a moment later; what is still warm then gets its deferred
   * generation swap.
   */
  async sweep(): Promise<{ rebuilt: string[]; evicted: string[] }> {
    const evicted = await this.evictIdle();
    const rebuilt = this.settleDeferred();
    return { rebuilt, evicted };
  }

  /**
   * W742 §2: arm the low-frequency reclaimer (idempotent). Returns false when a
   * timer is already armed or when nothing could ever be reclaimed. The timer is
   * `unref`ed — it must never keep the process alive — and [shutdown] disarms it,
   * so a reclaimed engine leaks no timer. A sweep failure is swallowed on
   * purpose: a reclaimer must never take the process down (see `Watchdog`).
   */
  startReclaimer(intervalMs?: number): boolean {
    const every = intervalMs ?? this.deps.reclaimerMs ?? this.reclaimerDefault();
    if (this.timer !== null || every <= 0) return false;
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), every);
    this.timer.unref();
    return true;
  }

  /** Disarm the reclaimer (idempotent; [shutdown] calls it). */
  stopReclaimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Is the reclaimer armed? (`CELESTEA_SESSION_IDLE_TTL_MS` > 0 in the host.) */
  get reclaimerRunning(): boolean {
    return this.timer !== null;
  }

  /** Tear every instance down and disarm the reclaimer (process exit / tests). */
  async shutdown(): Promise<void> {
    this.stopReclaimer();
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) await this.deps.dispose(entry.runtime);
  }

  /** Live / in-flight / started-turn counters (resource governance). */
  stats(): { live: number; inFlight: number; turns: number } {
    let turns = 0;
    for (const entry of this.entries.values()) turns += entry.turnNo;
    return { live: this.entries.size, inFlight: this.inFlightCount(), turns };
  }

  private epoch(): number {
    return this.deps.currentEpoch?.() ?? 0;
  }

  private isPinned(entry: SessionRuntime): boolean {
    return this.deps.pinned?.(entry) === true;
  }

  /** W742 §1: would a rebuild of this instance kill live background work? */
  private rebuildIsDeferred(entry: SessionRuntime): boolean {
    return this.deps.rebuildDeferred?.(entry) === true;
  }

  /** W742 §2: the derived period (a quarter of the TTL, floor 1s). */
  private reclaimerDefault(): number {
    const ttl = this.deps.idleTtlMs ?? 0;
    return ttl <= 0 ? 0 : Math.max(1_000, Math.floor(ttl / 4));
  }

  /** Rebuild now when idle AND free of live work, else mark for a later sweep. */
  private settleEpoch(entry: SessionRuntime): void {
    if (!entry.needsRebuild && entry.profileEpoch >= this.epoch()) return;
    if (entry.inFlight || this.rebuildIsDeferred(entry)) {
      entry.needsRebuild = true;
      return;
    }
    this.rebuild(entry);
  }

  private rebuild(entry: SessionRuntime): void {
    const previous = entry.runtime;
    entry.runtime = this.deps.build(entry.sessionId, entry.dir, this.epoch());
    // W769: a worker receipt that landed in this session's mailbox while the
    // generation was being swapped must not die with the generation it was
    // addressed to (the same migration `GenerationHub.swapSync` performs).
    migrateReceipts(previous, entry.runtime, entry.sessionId ?? HOST_SESSION_ID);
    entry.profileEpoch = this.epoch();
    entry.needsRebuild = false;
    entry.turnNo = turnNumberFromLog(entry.runtime);
    entry.lastOutcome = null;
    void this.deps.dispose(previous);
  }

  /**
   * Free one slot for `key`: LRU over idle, unpinned instances. Pinned
   * instances (live background workers) and the detached default runtime do not
   * consume the session cap, so orchestration cannot starve the UI sessions.
   */
  private makeRoom(key: string, detached: boolean): void {
    const max = this.deps.maxLive ?? 0;
    if (max <= 0 || detached) return;
    while (this.countedLive() >= max) {
      const victim = this.lruVictim(key);
      if (victim === null) throw new SessionCapacityError(max);
      this.entries.delete(victim.key);
      void this.deps.dispose(victim.runtime);
    }
  }

  /** Live instances that count against `maxLive` (pinned ones do not). */
  private countedLive(): number {
    let live = 0;
    for (const entry of this.entries.values()) if (!this.isPinned(entry)) live += 1;
    return live;
  }

  private lruVictim(keepKey: string): SessionRuntime | null {
    let victim: SessionRuntime | null = null;
    for (const entry of this.entries.values()) {
      if (entry.key === keepKey || entry.inFlight || this.isPinned(entry)) continue;
      if (victim === null || entry.lastActiveAt < victim.lastActiveAt) victim = entry;
    }
    return victim;
  }
}
