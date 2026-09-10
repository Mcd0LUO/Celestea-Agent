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
 */

import type { TurnOutcome } from "@celestea/core";
import type { Runtime } from "./runtime.js";

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
  /** Turns started on THIS session (per-session numbering, contract §4.1). */
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
  /** `true` pins an instance: never reclaimed (live background workers). */
  pinned?: (entry: SessionRuntime) => boolean;
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

/** Key of a session id (`null` = the detached instance). */
export function keyOfSession(sessionId: string | null): string {
  return sessionId ?? DETACHED_SESSION_KEY;
}

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, SessionRuntime>();
  private readonly deps: SessionRegistryDeps;
  private readonly now: () => number;

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
    const entry: SessionRuntime = {
      key,
      sessionId,
      dir,
      profileEpoch: epoch,
      runtime: this.deps.build(sessionId, dir, epoch),
      turnNo: 0,
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

  /** Tear every instance down (process exit / tests). */
  async shutdown(): Promise<void> {
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

  /** Rebuild now when idle, else mark for the next turn boundary. */
  private settleEpoch(entry: SessionRuntime): void {
    if (!entry.needsRebuild && entry.profileEpoch >= this.epoch()) return;
    if (entry.inFlight) {
      entry.needsRebuild = true;
      return;
    }
    this.rebuild(entry);
  }

  private rebuild(entry: SessionRuntime): void {
    const previous = entry.runtime;
    entry.runtime = this.deps.build(entry.sessionId, entry.dir, this.epoch());
    entry.profileEpoch = this.epoch();
    entry.needsRebuild = false;
    entry.turnNo = 0;
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
