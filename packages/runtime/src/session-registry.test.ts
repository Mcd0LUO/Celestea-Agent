/**
 * W513 SessionRuntimeRegistry — per-session runtime lifetime and busy slots.
 *
 * The registry is what removes "the global main session": instances are created
 * lazily, reused, rebuilt when the profile epoch moves on (never mid-turn),
 * and reclaimed when idle — with explicit capacity instead of silent queueing.
 */

import type { SessionEvent, SessionLog } from "@celestea/core";
import { maxTurnNumber } from "@celestea/session";
import { describe, expect, it, vi } from "vitest";
import { SessionCapacityError, SessionRuntimeRegistry, TurnCapacityError, keyOfSession, type SessionRuntime } from "./session-registry.js";
import type { Runtime } from "./runtime.js";

/**
 * A stub instance: the registry only ever calls the injected `dispose` and reads
 * the session log (turn-counter restoration, E §1.3 P0 ④), so the stub carries a
 * read-only event list — empty means "a brand new session", exactly like the
 * in-memory log of a detached generation.
 */
function stubRuntime(tag: string, events: readonly SessionEvent[] = []): Runtime {
  const session = { events: (): SessionEvent[] => [...events] } as unknown as SessionLog;
  return { tag, session, shutdown: () => Promise.resolve(), release: () => undefined } as unknown as Runtime;
}

/** One complete turn in the engine's shape (turn counter restoration fixture). */
function turn(n: number): SessionEvent[] {
  return [
    { type: "turn_start", id: `turn-${n}` },
    { type: "user_message", text: `问 ${n}` },
    { type: "turn_end", id: `turn-${n}`, outcome: "completed" },
  ];
}

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms: number) => void (value += ms) };
}

interface Built {
  registry: SessionRuntimeRegistry;
  built: string[];
  disposed: string[];
  time: ReturnType<typeof clock>;
}

interface RegistryOptions {
  maxLive?: number;
  maxConcurrentTurns?: number;
  idleTtlMs?: number;
  reclaimerMs?: number;
  pinned?: (entry: SessionRuntime) => boolean;
  /** W742 §1: the host's "this instance still holds live work" callback. */
  rebuildDeferred?: (entry: SessionRuntime) => boolean;
  currentEpoch?: () => number;
}

function makeRegistry(opts: RegistryOptions = {}): Built {
  const built: string[] = [];
  const disposed: string[] = [];
  const time = clock();
  const registry = new SessionRuntimeRegistry({
    build: (sessionId) => {
      built.push(sessionId ?? "<detached>");
      return stubRuntime(sessionId ?? "<detached>");
    },
    dispose: (runtime) => {
      disposed.push(String((runtime as unknown as { tag: string }).tag));
    },
    now: time.now,
    ...opts,
  });
  return { registry, built, disposed, time };
}

function controller(): AbortController {
  return new AbortController();
}

describe("SessionRuntimeRegistry", () => {
  it("creates one instance per session and reuses it (idempotent ensure)", () => {
    const { registry, built } = makeRegistry();
    const first = registry.ensure("ws/a", "/tmp/a");
    const again = registry.ensure("ws/a", "/tmp/a");
    expect(again).toBe(first);
    expect(built).toEqual(["ws/a"]);
    expect(registry.size).toBe(1);
    expect(registry.peek("ws/a")).toBe(first);
    expect(registry.peek("ws/ghost")).toBeNull();
    expect(registry.liveSessionIds()).toEqual(["ws/a"]);
  });

  it("keys the no-session runtime separately (detached)", () => {
    const { registry, built } = makeRegistry();
    registry.ensure(null, null);
    registry.ensure("ws/a", "/tmp/a");
    expect(built).toEqual(["<detached>", "ws/a"]);
    expect(keyOfSession(null)).toBe("<detached>");
    expect(registry.liveSessionIds()).toEqual(["ws/a"]);
  });

  it("isolates the busy slot PER SESSION", () => {
    const { registry } = makeRegistry();
    const a = registry.ensure("ws/a", null);
    const b = registry.ensure("ws/b", null);
    registry.beginTurn(a, controller());
    expect(a.inFlight).toBe(true);
    expect(b.inFlight).toBe(false);
    expect(registry.busySessionIds()).toEqual(["ws/a"]);
    expect(registry.inFlightCount()).toBe(1);
    registry.endTurn(a, "completed");
    expect(a.lastOutcome).toBe("completed");
    expect(registry.busySessionIds()).toEqual([]);
  });

  it("counts turns per session", () => {
    const { registry } = makeRegistry();
    const a = registry.ensure("ws/a", null);
    const b = registry.ensure("ws/b", null);
    expect(registry.beginTurn(a, controller())).toBe(1);
    registry.endTurn(a, "completed");
    expect(registry.beginTurn(a, controller())).toBe(2);
    registry.endTurn(a, "completed");
    expect(registry.beginTurn(b, controller())).toBe(1);
    registry.endTurn(b, "completed");
    expect(registry.stats()).toEqual({ live: 2, inFlight: 0, turns: 3 });
  });

  it("refuses a turn over the concurrent-turn cap (503 at the host)", () => {
    const { registry } = makeRegistry({ maxConcurrentTurns: 2 });
    const a = registry.ensure("ws/a", null);
    const b = registry.ensure("ws/b", null);
    const c = registry.ensure("ws/c", null);
    registry.beginTurn(a, controller());
    registry.beginTurn(b, controller());
    expect(() => registry.beginTurn(c, controller())).toThrow(TurnCapacityError);
    expect(() => registry.beginTurn(c, controller())).toThrow(/limit 2/);
    expect(c.inFlight).toBe(false);
  });

  it("reclaims the LRU idle instance to make room, and refuses when all are busy", () => {
    const { registry, disposed, time } = makeRegistry({ maxLive: 2 });
    registry.ensure("ws/a", null);
    time.advance(10);
    const b = registry.ensure("ws/b", null);
    time.advance(10);
    expect(() => registry.ensure("ws/c", null)).not.toThrow();
    // ws/a was the least recently used idle instance.
    expect(disposed).toEqual(["ws/a"]);
    expect(registry.liveSessionIds().sort()).toEqual(["ws/b", "ws/c"]);

    registry.beginTurn(b, controller());
    const d = registry.ensure("ws/d", null);
    registry.beginTurn(d, controller());
    expect(() => registry.ensure("ws/e", null)).toThrow(SessionCapacityError);
  });

  it("keeps a pinned instance out of the cap and the reclaimer", async () => {
    const { registry, disposed, time } = makeRegistry({ maxLive: 1, idleTtlMs: 1, pinned: (entry: SessionRuntime) => entry.sessionId === "ws/pinned" });
    registry.ensure("ws/pinned", null);
    expect(() => registry.ensure("ws/other", null)).not.toThrow();
    time.advance(10);
    expect(await registry.evictIdle()).toEqual(["ws/other"]);
    expect(disposed).toEqual(["ws/other"]);
    expect(registry.liveSessionIds()).toEqual(["ws/pinned"]);
  });

  it("reclaims idle instances past the TTL, never an in-flight one", async () => {
    const { registry, disposed, time } = makeRegistry({ idleTtlMs: 100 });
    const a = registry.ensure("ws/a", null);
    registry.ensure("ws/b", null);
    registry.beginTurn(a, controller());
    time.advance(500);
    expect(await registry.evictIdle()).toEqual(["ws/b"]);
    expect(disposed).toEqual(["ws/b"]);
    expect(registry.liveSessionIds()).toEqual(["ws/a"]);
    registry.endTurn(a, "completed");
    time.advance(500);
    expect(await registry.evictIdle()).toEqual(["ws/a"]);
  });

  it("never rebuilds or evicts an instance that is running a turn", async () => {
    const { registry, built, disposed } = makeRegistry();
    const a = registry.ensure("ws/a", null);
    registry.beginTurn(a, controller());
    registry.invalidateAll();
    expect(a.needsRebuild).toBe(true);
    expect(built).toEqual(["ws/a"]);
    expect(await registry.evict("ws/a")).toBe(false);
    registry.endTurn(a, "completed");
    // The rebuild happens at the next boundary, not mid-turn.
    registry.ensure("ws/a", null);
    expect(built).toEqual(["ws/a", "ws/a"]);
    expect(disposed).toEqual(["ws/a"]);
    expect(a.needsRebuild).toBe(false);
    expect(a.turnNo).toBe(0);
  });

  it("rebuilds an idle instance as soon as the profile epoch moves", () => {
    let epoch = 1;
    const built: string[] = [];
    const registry = new SessionRuntimeRegistry({
      build: (sessionId) => {
        built.push(`${sessionId}@${epoch}`);
        return stubRuntime(String(sessionId));
      },
      dispose: () => undefined,
      currentEpoch: () => epoch,
    });
    registry.ensure("ws/a", null);
    expect(built).toEqual(["ws/a@1"]);
    epoch = 2;
    registry.invalidateAll();
    expect(built).toEqual(["ws/a@1", "ws/a@2"]);
    expect(registry.peek("ws/a")?.profileEpoch).toBe(2);
  });

  it("shuts every instance down", async () => {
    const { registry, disposed } = makeRegistry();
    registry.ensure("ws/a", null);
    registry.ensure("ws/b", null);
    await registry.shutdown();
    expect(disposed.sort()).toEqual(["ws/a", "ws/b"]);
    expect(registry.size).toBe(0);
  });
});

/**
 * W742 §1: a rebuild DISPOSES the old instance (which aborts in-flight workers
 * and drops their rows), so an instance that still holds live background work may
 * only be MARKED — the swap happens as soon as that work ended, never before and
 * never "forgotten". `rebuildDeferred` is the host's answer to "is this instance
 * still busy with live work?"; the registry owns the ordering.
 */
describe("W742 §1 deferred rebuilds (live background work)", () => {
  function deferrable(startEpoch = 1): {
    registry: SessionRuntimeRegistry;
    built: string[];
    disposed: string[];
    setEpoch: (n: number) => void;
    setLive: (v: boolean) => void;
  } {
    let epoch = startEpoch;
    let live = true;
    const built: string[] = [];
    const disposed: string[] = [];
    const registry = new SessionRuntimeRegistry({
      build: (sessionId) => {
        built.push(`${sessionId}@${epoch}`);
        return stubRuntime(String(sessionId));
      },
      dispose: (runtime) => void disposed.push(String((runtime as unknown as { tag: string }).tag)),
      currentEpoch: () => epoch,
      rebuildDeferred: (entry) => live && entry.sessionId === "ws/live",
    });
    return { registry, built, disposed, setEpoch: (n) => void (epoch = n), setLive: (v) => void (live = v) };
  }

  it("marks the live-work instance instead of tearing it down, then settles it", () => {
    const h = deferrable();
    const live = h.registry.ensure("ws/live", null);
    const idle = h.registry.ensure("ws/idle", null);
    h.setEpoch(2);
    h.registry.invalidateAll();
    // The idle neighbour swapped generation at once; the one with live work did not.
    expect(h.built).toEqual(["ws/live@1", "ws/idle@1", "ws/idle@2"]);
    expect(h.disposed).toEqual(["ws/idle"]);
    expect(live.needsRebuild).toBe(true);
    expect(live.profileEpoch).toBe(1);
    expect(idle.needsRebuild).toBe(false);

    // Not even a turn boundary ("ensure") may swap it while the work is live.
    expect(h.registry.ensure("ws/live", null)).toBe(live);
    expect(h.built).toEqual(["ws/live@1", "ws/idle@1", "ws/idle@2"]);
    expect(h.registry.settleDeferred()).toEqual([]);

    // The work ended: the deferred swap happens exactly once, and turnNo is
    // re-derived from the (still identical) log.
    h.setLive(false);
    expect(h.registry.settleDeferred()).toEqual(["ws/live"]);
    expect(h.built).toEqual(["ws/live@1", "ws/idle@1", "ws/idle@2", "ws/live@2"]);
    expect(h.disposed).toEqual(["ws/idle", "ws/live"]);
    expect(live.needsRebuild).toBe(false);
    expect(live.profileEpoch).toBe(2);
    expect(h.registry.settleDeferred()).toEqual([]);
    expect(live.runtime).not.toBe(idle.runtime);
  });

  it("keeps an in-flight turn ahead of everything (mark, never rebuild)", () => {
    const h = deferrable(1);
    const live = h.registry.ensure("ws/live", null);
    h.registry.beginTurn(live, controller());
    h.setEpoch(2);
    h.registry.invalidateAll();
    h.setLive(false);
    expect(h.registry.settleDeferred()).toEqual([]);
    expect(h.built).toEqual(["ws/live@1"]);
    h.registry.endTurn(live, "completed");
    expect(h.registry.settleDeferred()).toEqual(["ws/live"]);
  });
});

/**
 * W742 §2: `evictIdle()`/the idle TTL had no caller at all, so
 * `CELESTEA_SESSION_IDLE_TTL_MS` did nothing. The registry now arms ONE
 * low-frequency `unref`ed reclaimer that sweeps deferred rebuilds and the idle
 * TTL, and `shutdown` disarms it (no timer outlives the engine).
 */
describe("W742 §2 the idle reclaimer", () => {
  it("arms one unref'ed timer, sweeps on its own, and disarms on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { registry, disposed, time } = makeRegistry({ idleTtlMs: 100, reclaimerMs: 50 });
      expect(registry.reclaimerRunning).toBe(false);
      expect(registry.startReclaimer()).toBe(true);
      expect(registry.reclaimerRunning).toBe(true);
      expect(registry.startReclaimer()).toBe(false); // idempotent: ONE timer

      registry.ensure("ws/a", null);
      // Inside the TTL nothing happens, however often the timer fires.
      await vi.advanceTimersByTimeAsync(150);
      expect(registry.liveSessionIds()).toEqual(["ws/a"]);
      expect(disposed).toEqual([]);

      // Past the TTL the timer's own sweep reclaims it — no explicit call.
      time.advance(1_000);
      await vi.advanceTimersByTimeAsync(50);
      expect(disposed).toEqual(["ws/a"]);
      expect(registry.liveSessionIds()).toEqual([]);

      await registry.shutdown();
      expect(registry.reclaimerRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the timer explicitly and derives its period from the TTL", async () => {
    const { registry } = makeRegistry({ idleTtlMs: 40 });
    expect(registry.startReclaimer()).toBe(true);
    registry.stopReclaimer();
    expect(registry.reclaimerRunning).toBe(false);

    // TTL 0 = nothing can ever be reclaimed: no timer is armed at all.
    const off = makeRegistry({ idleTtlMs: 0 });
    expect(off.registry.startReclaimer()).toBe(false);
    expect(off.registry.reclaimerRunning).toBe(false);
  });

  it("sweeps both halves in one pass, reclaiming before recomposing", async () => {
    let epoch = 1;
    let live = true;
    const { registry, built, disposed, time } = makeRegistry({ idleTtlMs: 10, currentEpoch: () => epoch, rebuildDeferred: () => live });
    registry.ensure("ws/a", null);
    epoch = 2;
    registry.invalidateAll();
    expect(built).toEqual(["ws/a"]); // marked, not rebuilt: the work is live
    // The work ends, but the instance is now past its idle TTL: the sweep must
    // reclaim it instead of recomposing a generation nobody is using.
    time.advance(1_000);
    live = false;
    expect(await registry.sweep()).toEqual({ rebuilt: [], evicted: ["ws/a"] });
    expect(built).toEqual(["ws/a"]);
    expect(disposed).toEqual(["ws/a"]);
    expect(registry.size).toBe(0);
  });
});

/**
 * E §1.3 P0 ④: the session-local turn number is DERIVED from the log
 * (`maxTurnNumber(events) + 1`), never from a memory counter — so a restart, a
 * rebuild or a re-composition can neither restart it at 0 nor reuse an id.
 */
describe("turnNo restoration (E-P0③ A5)", () => {
  it("A5: a new registry restores turnNo from the log instead of starting at 0", () => {
    const events = [...turn(0), ...turn(1), ...turn(2), ...turn(3)];
    const registry = new SessionRuntimeRegistry({ build: () => stubRuntime("ws/a", events), dispose: () => undefined });

    const entry = registry.ensure("ws/a", "/tmp/a");
    expect(entry.turnNo).toBe(maxTurnNumber(events) + 1);
    expect(entry.turnNo).toBe(4);
    expect(entry.turnNo).not.toBe(0);
    // …and it keeps counting from there, in step with the log's own ids.
    expect(registry.beginTurn(entry, controller())).toBe(5);

    // A session with no events keeps the historical behaviour (0).
    const fresh = new SessionRuntimeRegistry({ build: () => stubRuntime("ws/b"), dispose: () => undefined });
    expect(fresh.ensure("ws/b", "/tmp/b").turnNo).toBe(0);
  });

  it("A5: a rebuild re-derives turnNo from the replayed log (never from memory)", () => {
    let epoch = 1;
    const events = [...turn(0), ...turn(1)];
    const registry = new SessionRuntimeRegistry({
      build: () => stubRuntime("ws/a", events),
      dispose: () => undefined,
      currentEpoch: () => epoch,
    });
    const entry = registry.ensure("ws/a", "/tmp/a");
    expect(entry.turnNo).toBe(2);
    epoch = 2;
    registry.invalidateAll();
    expect(registry.peek("ws/a")?.turnNo).toBe(2);
  });
});
