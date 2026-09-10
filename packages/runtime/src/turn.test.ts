import { describe, expect, it } from "vitest";
import { SESSION_LOG_SERVICE, type Context, type SessionLog, type TurnOutcome } from "@celestea/core";
import { compose } from "./compose.js";
import { TurnBusyError } from "./errors.js";
import { collectingSink } from "./runtime.js";
import { TURN_ABORT_SERVICE, TURN_SINK_SERVICE } from "./tokens.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile, tick, waitAbort } from "./fakes.test-util.js";

function runtimeWith(plan: Parameters<typeof fakeLoop>[0], profile = testProfile()) {
  const log = memoryLog();
  const loop = fakeLoop(plan);
  const runtime = compose({
    profile,
    plugins: [memorySessionPlugin(log)],
    loopFactory: loop.factory,
    workers: false,
  });
  return { runtime, log, loop };
}

describe("runTurn", () => {
  it("maps every loop event onto one frame, in order", async () => {
    const { runtime } = runtimeWith(() => ({ thinking: "th", text: "hi", tools: 2, assistant: "hi" }));
    const { frames, sink } = collectingSink();
    const outcome = await runtime.runTurn("go", { sink });
    expect(outcome).toBe("completed");
    expect(frames.map((f) => f.event)).toEqual([
      "thinking",
      "text",
      "tool",
      "tool_result",
      "tool",
      "tool_result",
      "done",
      "turn_end",
    ]);
    expect(frames[1]?.payload).toEqual({ delta: "hi" });
    expect(frames[6]?.payload["text"]).toBe("hi");
  });

  it("returns the terminal state written by the loop (the log is the truth)", async () => {
    const { runtime, log } = runtimeWith(() => ({ text: "x", omitTurnEnd: true, outcome: "step_limit" }));
    const first = await runtime.runTurn("a");
    expect(first).toBe("interrupted");
    expect(log.events().some((e) => e.type === "assistant_message")).toBe(true);
  });

  it("reads a step_limit outcome straight from the log", async () => {
    const { runtime } = runtimeWith(() => ({ text: "x", outcome: "step_limit" }));
    expect(await runtime.runTurn("a")).toBe("step_limit");
  });

  it("propagates a loop wiring failure instead of inventing an outcome", async () => {
    const { runtime } = runtimeWith(() => ({ throwError: "no LlmService in context" }));
    await expect(runtime.runTurn("a")).rejects.toThrow("no LlmService in context");
  });

  it("writes turn ids through the session log counter", async () => {
    const { runtime, log } = runtimeWith(() => ({ text: "x" }));
    await runtime.runTurn("one");
    await runtime.runTurn("two");
    const ids = log.events().filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.id : ""));
    expect(ids).toEqual(["turn-0", "turn-1"]);
  });
});

describe("host receipts", () => {
  it("injects pending worker receipts before the input, FIFO, attributed", async () => {
    const log = memoryLog();
    const loop = fakeLoop(() => ({ text: "replied" }));
    const runtime = compose({
      profile: testProfile(),
      plugins: [memorySessionPlugin(log)],
      loopFactory: loop.factory,
      workers: { tsvPath: null },
    });
    const host = runtime.hostSessionId ?? "";
    runtime.workers?.mailbox.send(host, "WORKER_W1_DONE 报告 results/W1-x.md", "W1");
    runtime.workers?.mailbox.send(host, "WORKER_W2_FAILED ERR boom", "W2");
    expect(runtime.pendingReceipts()).toBe(2);
    expect(await runtime.runTurn("now go")).toBe("completed");
    const texts = log.events().filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
    expect(texts).toEqual([
      "[from W1] WORKER_W1_DONE 报告 results/W1-x.md",
      "[from W2] WORKER_W2_FAILED ERR boom",
      "now go",
    ]);
    expect(runtime.pendingReceipts()).toBe(0);
  });

  it("leaves the host queue alone when an unrelated session is addressed", async () => {
    const loop = fakeLoop(() => ({ text: "x" }));
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], loopFactory: loop.factory, workers: { tsvPath: null } });
    runtime.workers?.mailbox.send("session-9", "not for the host", "W9");
    await runtime.runTurn("go");
    expect(runtime.pendingReceipts()).toBe(0);
    expect(runtime.workers?.mailbox.pending("session-9")).toBe(1);
  });
});

describe("concurrency slot", () => {
  it("rejects a second concurrent turn with a 409 conflict", async () => {
    const { runtime } = runtimeWith(() => ({ text: "x", hangUntilAbort: true }));
    const first = runtime.runTurn("one");
    await tick(3);
    expect(runtime.isBusy).toBe(true);
    const conflict = await runtime.runTurn("two").catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(TurnBusyError);
    expect((conflict as TurnBusyError).status).toBe(409);
    expect((conflict as TurnBusyError).kind).toBe("turn_busy");
    runtime.cancelTurn();
    await first;
    expect(runtime.isBusy).toBe(false);
  });

  it("releases the slot after a failed turn", async () => {
    const { runtime } = runtimeWith((_input, turn) => (turn === 1 ? { throwError: "boom" } : { text: "ok" }));
    await expect(runtime.runTurn("one")).rejects.toThrow("boom");
    expect(runtime.isBusy).toBe(false);
    expect(await runtime.runTurn("two")).toBe("completed");
  });
});

describe("cancellation", () => {
  it("links the caller signal and reports cancelled", async () => {
    const { runtime, loop } = runtimeWith(() => ({ text: "x", hangUntilAbort: true }));
    const controller = new AbortController();
    const turn = runtime.runTurn("slow", { signal: controller.signal });
    await tick(3);
    controller.abort();
    expect(await turn).toBe("cancelled");
    expect(loop.record.signals[0]?.aborted).toBe(true);
  });

  it("exposes the turn signal on the turn scope for Context-driven loops", async () => {
    const { runtime, loop } = runtimeWith(() => ({ text: "x", hangUntilAbort: true }));
    const turn = runtime.runTurn("slow");
    await tick(3);
    const scope = loop.record.contexts[0];
    expect(scope?.get(TURN_ABORT_SERVICE)).toBe(loop.record.signals[0]);
    expect(scope?.get(TURN_SINK_SERVICE)).toBeTypeOf("function");
    expect(runtime.cancelTurn()).toBe(true);
    expect(await turn).toBe("cancelled");
  });

  it("reports cancelled when the signal is already aborted before the turn", async () => {
    const { runtime } = runtimeWith(() => ({ hangUntilAbort: true }));
    const controller = new AbortController();
    controller.abort();
    expect(await runtime.runTurn("go", { signal: controller.signal })).toBe("cancelled");
    expect(runtime.isBusy).toBe(false);
  });

  it("cancelTurn returns false between turns", async () => {
    const { runtime } = runtimeWith(() => ({ text: "x" }));
    await runtime.runTurn("a");
    expect(runtime.cancelTurn()).toBe(false);
  });
});

describe("busy gate helpers", () => {
  it("waitAbort resolves immediately for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitAbort(controller.signal)).resolves.toBeUndefined();
  });

  it("keeps the session log reachable through the turn scope", async () => {
    const { runtime, loop, log } = runtimeWith(() => ({ text: "x" }));
    await runtime.runTurn("a");
    const scope: Context | undefined = loop.record.contexts[0];
    expect(scope?.get<SessionLog>(SESSION_LOG_SERVICE)).toBe(log);
  });

  it("survives an outcome type union check", async () => {
    const { runtime } = runtimeWith(() => ({ text: "x" }));
    const outcome: TurnOutcome = await runtime.runTurn("a");
    expect(typeof outcome === "string" || "error" in outcome).toBe(true);
  });
});
