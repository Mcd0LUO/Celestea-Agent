import { describe, expect, it, vi } from "vitest";
import { SESSION_LOG_SERVICE, type SessionLog } from "@celestea/core";
import { SessionMailbox } from "@celestea/workers";
import { compose, type ComposeConfig } from "./compose.js";
import { TurnBusyError } from "./errors.js";
import { GenerationHub, createGen, migrateReceipts } from "./gen.js";
import { RuntimeReleasedError } from "./errors.js";
import { createSessionBinding, type SessionBinding } from "./session-binding.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile, tick } from "./fakes.test-util.js";

function cfg(overrides: Partial<ComposeConfig> = {}): ComposeConfig {
  return {
    profile: testProfile(),
    plugins: [memorySessionPlugin()],
    workers: { tsvPath: null },
    ...overrides,
  };
}

describe("shutdown", () => {
  it("stops drivers, purges the mailbox, clears the registry and runs hooks once", async () => {
    const hook = vi.fn();
    const runtime = compose(cfg({ shutdownHooks: [hook] }));
    const workers = runtime.workers;
    expect(workers).not.toBeNull();
    workers!.sessions.create({ title: "W1·t" });
    workers!.mailbox.send("cli-main", "stale receipt", "W1");
    expect(runtime.pendingReceipts()).toBe(1);

    await runtime.shutdown();
    await runtime.shutdown();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(workers!.mailbox.pendingTotal()).toBe(0);
    expect(workers!.sessions.size).toBe(0);
    expect(workers!.backgroundLen()).toBe(0);
    expect(runtime.isReleased).toBe(true);
  });

  it("is re-entrant: concurrent callers share one teardown", async () => {
    const hook = vi.fn(async () => {
      await tick(5);
    });
    const runtime = compose(cfg({ shutdownHooks: [hook] }));
    await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()]);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("keeps going when a teardown hook throws", async () => {
    const second = vi.fn();
    const runtime = compose(
      cfg({
        shutdownHooks: [
          () => {
            throw new Error("kill failed");
          },
          second,
        ],
      }),
    );
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("refuses to drive or rebind after shutdown", async () => {
    const runtime = compose(cfg());
    await runtime.shutdown();
    await expect(runtime.runTurn("x")).rejects.toBeInstanceOf(RuntimeReleasedError);
    expect(() => runtime.rebind(sessionBinding(memoryLog()))).toThrow(RuntimeReleasedError);
  });
});

describe("release", () => {
  it("drops every strong handle and marks the registry released", async () => {
    const runtime = compose(cfg());
    const workers = runtime.workers!;
    await runtime.shutdown();
    runtime.release();
    expect(runtime.isReleased).toBe(true);
    expect(workers.isReleased).toBe(true);
    expect(() => runtime.workers).toThrow(RuntimeReleasedError);
    await expect(runtime.runTurn("x")).rejects.toBeInstanceOf(RuntimeReleasedError);
  });

  it("is idempotent", () => {
    const runtime = compose(cfg());
    runtime.release();
    expect(() => runtime.release()).not.toThrow();
  });
});

function sessionBinding(log: SessionLog, sessionId = "ws/s1", dir: string | null = "/tmp/s1"): SessionBinding {
  return createSessionBinding({ sessionId, dir, open: () => log });
}

describe("session rebind", () => {
  it("re-opens the SAME session id/dir and republishes the log", async () => {
    const first = memoryLog();
    const second = memoryLog();
    const opened: SessionBinding[] = [];
    const bindingOf = (log: SessionLog): SessionBinding =>
      createSessionBinding({
        sessionId: "ws/s1",
        dir: "/tmp/s1",
        open: () => {
          opened.push(bindingOf(log));
          return log;
        },
      });
    const loop = fakeLoop(() => ({ text: "rebound" }));
    const runtime = compose(cfg({ plugins: [], sessionBinding: bindingOf(first), loopFactory: loop.factory }));
    expect(runtime.session).toBe(first);
    const rebound = runtime.rebind(bindingOf(second));
    expect(rebound).toBe(second);
    expect(runtime.session).toBe(second);
    expect(runtime.ctx.get<SessionLog>(SESSION_LOG_SERVICE)).toBe(second);
    expect(runtime.sessionBinding?.sessionId).toBe("ws/s1");
    expect(runtime.sessionBinding?.dir).toBe("/tmp/s1");
    await runtime.runTurn("after rebind");
    expect(second.events().length).toBeGreaterThan(0);
    expect(first.events().length).toBe(0);
  });

  it("rejects a rebind while a turn is in flight", async () => {
    const loop = fakeLoop(() => ({ text: "x", hangUntilAbort: true }));
    const runtime = compose(cfg({ loopFactory: loop.factory }));
    const turn = runtime.runTurn("slow");
    await tick(3);
    expect(() => runtime.rebind(sessionBinding(memoryLog()))).toThrow(TurnBusyError);
    runtime.cancelTurn();
    await turn;
    expect(runtime.rebind(sessionBinding(memoryLog()))).toBeDefined();
  });
});

describe("generation swap", () => {
  it("flips atomically: readers never see a mixed generation", async () => {
    const hub = new GenerationHub({ hostSessionId: "cli-main" });
    const profileA = testProfile({ model: "model-a" });
    const profileB = testProfile({ model: "model-b" });
    hub.install(compose(cfg({ profile: profileA })), profileA);

    const mismatches: string[] = [];
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const gen = hub.current();
        const tag = `${gen.profile.model}/${gen.config.model}/${gen.runtime.profile.model}`;
        const [a, b, c] = tag.split("/");
        if (a !== b || b !== c) mismatches.push(tag);
        await Promise.resolve();
      }
    })();

    for (let i = 0; i < 20; i++) {
      const profile = i % 2 === 0 ? profileB : profileA;
      await hub.swap(compose(cfg({ profile })), profile);
      expect(hub.current().profile.model).toBe(profile.model);
    }
    stop = true;
    await reader;
    expect(mismatches).toEqual([]);
    expect(hub.swapCount).toBe(21);
    expect(hub.epoch).toBe(21);
  });

  it("keeps a snapshot consistent after a swap and tears the old generation down", async () => {
    const hub = new GenerationHub();
    const old = compose(cfg());
    const oldWorkers = old.workers;
    hub.install(old, testProfile({ model: "old" }));
    const snapshot = hub.current();
    const result = await hub.swap(compose(cfg()), testProfile({ model: "new" }));
    expect(result.prevEpoch).toBe(1);
    expect(result.epoch).toBe(2);
    expect(snapshot.profile.model).toBe("old");
    expect(snapshot.config.model).toBe("old");
    expect(snapshot.runtime.isReleased).toBe(true);
    expect(oldWorkers?.isReleased).toBe(true);
  });

  it("migrates pending host receipts onto the new generation", async () => {
    const hub = new GenerationHub({ hostSessionId: "cli-main" });
    const old = compose(cfg());
    hub.install(old, testProfile());
    old.workers!.mailbox.send("cli-main", "WORKER_W1_DONE", "W1");
    old.workers!.mailbox.send("cli-main", "WORKER_W2_DONE", "W2");
    const result = await hub.swap(compose(cfg()), testProfile());
    expect(result.migrated).toBe(2);
    const next = hub.current().runtime;
    expect(next.pendingReceipts()).toBe(2);
    expect(next.workers!.mailbox.poll("cli-main").map((m) => m.from_label)).toEqual(["W1", "W2"]);
  });

  it("reports nothing to migrate when a generation has no worker wiring", async () => {
    const hub = new GenerationHub();
    hub.install(compose(cfg({ workers: false })), testProfile());
    const result = await hub.swap(compose(cfg({ workers: false })), testProfile());
    expect(result.migrated).toBe(0);
  });

  it("builds and swaps through the injected factory, and notifies observers", async () => {
    const built: string[] = [];
    const seen: number[] = [];
    const hub = new GenerationHub({
      build: (profile) => {
        built.push(profile.model);
        return compose(cfg({ profile }));
      },
      onSwap: (next) => seen.push(next.epoch),
    });
    await hub.buildAndSwap(testProfile({ model: "first" }));
    await hub.buildAndSwap(testProfile({ model: "second" }));
    expect(built).toEqual(["first", "second"]);
    expect(seen).toEqual([1, 2]);
    expect(hub.current().config.model).toBe("second");
  });

  it("shuts the current generation down and forgets it", async () => {
    const hub = new GenerationHub();
    const runtime = compose(cfg());
    hub.install(runtime, testProfile());
    await hub.shutdown();
    expect(runtime.isReleased).toBe(true);
    expect(hub.peek()).toBeNull();
    expect(() => hub.current()).toThrow();
    await expect(hub.shutdown()).resolves.toBeUndefined();
  });

  it("exposes createGen + migrateReceipts as pure helpers", () => {
    const runtime = compose(cfg());
    const gen = createGen(runtime, testProfile({ model: "g" }), 7);
    expect(gen.epoch).toBe(7);
    expect(gen.config.model).toBe("g");
    const mailbox = new SessionMailbox();
    mailbox.send("cli-main", "x", "W1");
    expect(migrateReceipts(runtime, compose(cfg()), "cli-main")).toBe(0);
    expect(runtime.pendingReceipts()).toBe(0);
    runtime.release();
  });
});
