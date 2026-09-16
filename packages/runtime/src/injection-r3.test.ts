/**
 * W836 R3 batch H — injection callback safety (P1-6) and abort-listener
 * lifecycle (P1-7).
 *
 * Probes from the authoritative plan
 * `/server-center/runtime/worker-exec/results/W826-R3修复计划-A-core-llm-runtime.md`
 * (§三 批次 H): a throwing `onInjected` must not lose the drained message, and a
 * long-lived caller `AbortSignal` must carry no listener after normal turns.
 */

import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { SessionLog } from "@celestea/core";
import { compose } from "./compose.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile, tick } from "./fakes.test-util.js";

function userTexts(log: SessionLog): string[] {
  return log.events().filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
}

describe("P1-6: a throwing onInjected callback must not swallow the message", () => {
  it("still appends the drained message and completes the turn", async () => {
    const log = memoryLog();
    let calls = 0;
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(log)],
      workers: false,
      loopFactory: fakeLoop(() => ({ text: "ok" })).factory,
      onInjected: () => {
        calls += 1;
        throw new Error("observer boom");
      },
    });
    const injected = runtime.inject("排队等我下一轮", "next-turn");
    const outcome = await runtime.runTurn("正式输入");
    expect(outcome).toBe("completed");
    expect(calls).toBe(1);
    expect(injected.duplicate).toBe(false);
    expect(runtime.pendingInjections()).toBe(0);
    expect(userTexts(log)).toEqual(["排队等我下一轮", "正式输入"]);
  });
});

describe("P1-7: runTurn removes its abort listener when the turn ends", () => {
  it("leaves no listener on a long-lived caller signal after N normal turns", async () => {
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(memoryLog())],
      workers: false,
      loopFactory: fakeLoop(() => ({ text: "done" })).factory,
    });
    const source = new AbortController();
    for (let i = 0; i < 5; i++) await runtime.runTurn(`turn ${i}`, { signal: source.signal });
    expect(getEventListeners(source.signal, "abort")).toHaveLength(0);
  });

  it("still cancels an in-flight turn through the caller signal", async () => {
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(memoryLog())],
      workers: false,
      loopFactory: fakeLoop(() => ({ text: "x", hangUntilAbort: true })).factory,
    });
    const source = new AbortController();
    const turn = runtime.runTurn("slow", { signal: source.signal });
    await tick(3);
    source.abort();
    await expect(turn).resolves.toBe("cancelled");
    expect(getEventListeners(source.signal, "abort")).toHaveLength(0);
  });
});
