/**
 * W513 SessionRuntimeRegistry — per-session runtime lifetime and busy slots.
 *
 * The registry is what removes "the global main session": instances are created
 * lazily, reused, rebuilt when the profile epoch moves on (never mid-turn),
 * and reclaimed when idle — with explicit capacity instead of silent queueing.
 */

import { describe, expect, it } from "vitest";
import { SessionCapacityError, SessionRuntimeRegistry, TurnCapacityError, keyOfSession, type SessionRuntime } from "./session-registry.js";
import type { Runtime } from "./runtime.js";

/** A stub instance: the registry only ever calls the injected `dispose`. */
function stubRuntime(tag: string): Runtime {
  return { tag, shutdown: () => Promise.resolve(), release: () => undefined } as unknown as Runtime;
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
  pinned?: (entry: SessionRuntime) => boolean;
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
