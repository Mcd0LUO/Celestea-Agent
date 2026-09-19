/**
 * W836 R3 batch G — shutdown ordering (P1-5) and session-log fd lifecycle (P1-4).
 *
 * Probes from the authoritative plan
 * `/server-center/runtime/worker-exec/results/W826-R3修复计划-A-core-llm-runtime.md`
 * (§三 批次 G), observed with EXTERNAL quantities as that plan demands: the
 * checkpoint sidecar on disk and `/proc/self/fd`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_LOG_SERVICE, type SessionLog } from "@celestea/core";
import { checkpointStoreOf, readCheckpointFile } from "@celestea/session";
import { compose } from "./compose.js";
import { GenerationHub } from "./gen.js";
import { closeLog, openSessionLog } from "./host/engine-session.js";
import { createSessionBinding } from "./session-binding.js";
import type { LoopFactory } from "./turn-runner.js";
import { testProfile, tick } from "./fakes.test-util.js";

const SESSION = "ws/s1";
const IDENTITY = { boot_id: "b-g0000001", pid: 4242 };
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** The one persistent binding every generation of a test re-opens. */
function persistentBinding(dir: string): ReturnType<typeof createSessionBinding> {
  return createSessionBinding({ sessionId: SESSION, dir, open: () => openSessionLog(dir, { identity: IDENTITY, now: () => 1 }) });
}

/** W891: /proc/self/fd is the one Linux-only read in this suite. */
const PROC_FD_READABLE = existsSync("/proc/self/fd");

/** Open fds of THIS process: the external, unforgeable leak signal. */
function fdCount(): number {
  return readdirSync("/proc/self/fd").length;
}

/** A loop that writes turn_start, blocks on a gate, then writes turn_end. */
function gatedLoop(): { factory: LoopFactory; started: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const factory: LoopFactory = (bindings) => ({
    async runTurn(ctx, input): Promise<void> {
      void bindings;
      const log = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
      if (log === undefined) throw new Error("no session log");
      const id = log.nextTurnId();
      log.append({ type: "turn_start", id });
      log.append({ type: "user_message", text: input ?? "" });
      markStarted();
      await gate;
      log.append({ type: "turn_end", id, outcome: "completed" });
    },
  });
  return { factory, started, release };
}

describe("P1-5: shutdown waits for the in-flight turn before claiming clean", () => {
  it("never marks the sidecar clean while a turn is still open", async () => {
    const dir = scratch("r3-g-shutdown-");
    const loop = gatedLoop();
    const runtime = compose({ profile: testProfile(), sessionBinding: persistentBinding(dir), loopFactory: loop.factory, workers: false });
    const store = checkpointStoreOf(runtime.session);
    if (store === null) throw new Error("no checkpoint store");

    const turn = runtime.runTurn("slow");
    await loop.started;
    await tick(2);
    expect(store.current.open_turn).not.toBeNull();
    expect(store.current.clean_shutdown).toBe(false);

    const shutdown = runtime.shutdown();
    await tick(5);
    // The turn is still blocked on the gate: the sidecar must stay OPEN + dirty.
    expect(store.current.clean_shutdown).toBe(false);
    expect(store.current.open_turn).not.toBeNull();

    loop.release();
    await turn;
    await shutdown;
    expect(store.current.clean_shutdown).toBe(true);
    expect(store.current.open_turn).toBeNull();
    const disk = readCheckpointFile(store.path, store.session);
    if (disk.kind !== "ok") throw new Error(`checkpoint unreadable: ${disk.kind}`);
    expect(disk.value.clean_shutdown).toBe(true);
    expect(disk.value.open_turn).toBeNull();
  });
});

describe("P1-4: session-log fd lifecycle", () => {
  it("closes every generation log across GenerationHub teardown", async (ctx) => {
    // W891: the leak signal is /proc/self/fd (Linux only) — skip visibly there
    // rather than counting an unrun assertion as a pass.
    if (!PROC_FD_READABLE) {
      ctx.skip("fd accounting reads /proc/self/fd (Linux only)");
      return;
    }
    const dir = scratch("r3-g-hub-");
    const binding = persistentBinding(dir);
    const hub = new GenerationHub();
    hub.install(compose({ profile: testProfile(), sessionBinding: binding, workers: false }), testProfile());
    const before = fdCount();
    for (let i = 0; i < 8; i++) {
      await hub.swap(compose({ profile: testProfile(), sessionBinding: binding, workers: false }), testProfile());
    }
    await hub.shutdown();
    expect(fdCount() - before).toBeLessThanOrEqual(1);
  });

  it("closes the previous log on rebind and tolerates a double close", async (ctx) => {
    if (!PROC_FD_READABLE) {
      ctx.skip("fd accounting reads /proc/self/fd (Linux only)");
      return;
    }
    const dir = scratch("r3-g-rebind-");
    const binding = persistentBinding(dir);
    const runtime = compose({ profile: testProfile(), sessionBinding: binding, workers: false });
    const before = fdCount();
    for (let i = 0; i < 8; i++) runtime.rebind(binding);
    expect(fdCount() - before).toBeLessThanOrEqual(1);

    const log = runtime.session;
    await runtime.shutdown();
    closeLog(log); // the host disposeRuntime closes first
    expect(() => runtime.release()).not.toThrow();
    closeLog(log); // and a third close is still safe
  });
});
