import { describe, expect, it } from "vitest";
import { zeroUsage, type SessionEvent, type Usage } from "@celestea/core";
import { compose } from "./compose.js";
import { StatusTracker, createStatusTracker, estimatedContextChars, ratio4, statuslineOf, type StatusView } from "./status.js";
import { UsageTracker, cacheHitRatioRounded, usageBlock, usageStatus } from "./usage.js";
import { fakeLoop, memoryLog, memorySessionPlugin, testProfile, tick } from "./fakes.test-util.js";

const usageOf = (u: Partial<Usage>): Usage => ({ ...zeroUsage(), ...u });

describe("StatusTracker", () => {
  it("counts one step per tool call, never per tool_result", async () => {
    const log = memoryLog();
    const loop = fakeLoop(() => ({ text: "x", tools: 3 }));
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin(log)], loopFactory: loop.factory, workers: false });
    let clock = 0;
    const tracker = createStatusTracker(() => clock);
    const sinkFrames: string[] = [];
    await runtime.runTurn("go", { sink: (f) => sinkFrames.push(f.event) });
    for (const kind of ["tool_call", "tool_call", "tool_result", "tool_call", "tool_result"]) {
      if (kind === "tool_call") tracker.addStep();
    }
    expect(sinkFrames.filter((k) => k === "tool")).toHaveLength(3);
    expect(tracker.stepCount).toBe(3);
    expect(runtime.status.stepCount).toBe(3);
  });

  it("resets steps and the rate window at turn start", async () => {
    let clock = 0;
    const tracker = createStatusTracker(() => clock);
    tracker.addStep();
    tracker.addChars(100);
    tracker.beginTurn();
    expect(tracker.stepCount).toBe(0);
    expect(tracker.rate()).toBe(0);
  });

  it("estimates chars per second over a 5s sliding window with a 1s floor", () => {
    let clock = 1_000;
    const tracker = new StatusTracker(() => clock);
    tracker.addChars(50);
    clock += 1_000;
    tracker.addChars(50);
    // 100 chars over 1s span.
    expect(tracker.rate()).toBe(100);
    clock += 4_500;
    tracker.addChars(50);
    // The t=1s sample fell out of the window; 100 chars (t=2s + t=6.5s) over 4.5s.
    expect(tracker.rate()).toBeCloseTo(100 / 4.5, 5);
    clock += 10_000;
    expect(tracker.rate()).toBe(0);
  });

  it("never reports a silly rate for a single burst (1s floor)", () => {
    let clock = 5_000;
    const tracker = new StatusTracker(() => clock);
    tracker.addChars(10);
    clock += 5;
    expect(tracker.rate()).toBe(10);
  });
});

describe("context usage + statusline", () => {
  const events: SessionEvent[] = [
    { type: "turn_start", id: "turn-0" },
    { type: "user_message", text: "12345" },
    { type: "thinking_delta", text: "ignored" },
    { type: "assistant_message", text: "123" },
    { type: "tool_call", id: "c1", name: "read_file", args: { path: "ab" } },
    { type: "tool_result", id: "c1", value: "xyz", error: null },
    { type: "turn_end", id: "turn-0", outcome: "completed" },
  ];

  it("counts the model-visible characters only", () => {
    expect(estimatedContextChars(events)).toBe(
      5 + 3 + ("c1".length + "read_file".length + JSON.stringify({ path: "ab" }).length) + ("c1".length + JSON.stringify("xyz").length),
    );
  });

  it("prefers the real prompt size and falls back to the char estimate", () => {
    const usage = new UsageTracker();
    const view = (): StatusView => ({
      model: "m",
      reasoning_effort: null,
      status: createStatusTracker(),
      usage,
      context_window: 1_000,
      events: () => events,
    });
    const estimated = statuslineOf(view());
    expect(estimated.context_usage.estimated).toBe(true);
    expect(estimated.context_usage.method).toBe("session_event_chars");
    usage.record(usageOf({ prompt_tokens: 250, total_tokens: 250 }));
    const real = statuslineOf(view());
    expect(real.context_usage).toEqual({ used: 250, window: 1_000, ratio: 0.25, estimated: false, method: "usage_prompt_tokens" });
  });

  it("uses the contract display default when trimming is off", () => {
    const line = statuslineOf({
      model: "m",
      reasoning_effort: "high",
      status: createStatusTracker(),
      usage: new UsageTracker(),
      context_window: 0,
      events: () => [],
    });
    expect(line.context_usage.window).toBe(1_000_000);
    expect(line.reasoning_effort).toBe("high");
  });

  it("rounds the ratio to 4 decimals and clamps it", () => {
    expect(ratio4(1, 3)).toBe(0.3333);
    expect(ratio4(5, 1)).toBe(1);
    expect(ratio4(1, 0)).toBe(0);
  });

  it("exposes the live tracker through the composed runtime", async () => {
    const loop = fakeLoop(() => ({ text: "hello", tools: 2 }));
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], loopFactory: loop.factory, workers: false });
    await runtime.runTurn("go");
    const line = runtime.statusline();
    expect(line.steps).toBe(2);
    expect(line.model).toBe("deepseek-chat");
    expect(line.context_usage.estimated).toBe(true);
    expect(line.usage.cache_hit_ratio).toBe(0);
  });

  it("keeps the statusline rate stable across ticks", async () => {
    const loop = fakeLoop(() => ({ text: "abcd" }));
    const runtime = compose({ profile: testProfile(), plugins: [memorySessionPlugin()], loopFactory: loop.factory, workers: false });
    await runtime.runTurn("go");
    await tick(2);
    expect(runtime.statusline().tokens_per_sec).toBeGreaterThan(0);
  });
});

describe("UsageTracker", () => {
  it("tracks latest and cumulative usage independently", () => {
    const tracker = new UsageTracker();
    expect(tracker.latest()).toEqual(zeroUsage());
    tracker.record(usageOf({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read: 3, reasoning_tokens: 2 }));
    tracker.record(usageOf({ prompt_tokens: 20, completion_tokens: 1, total_tokens: 21, cache_read: 4 }));
    expect(tracker.latest().total_tokens).toBe(21);
    expect(tracker.latest().cache_read).toBe(4);
    expect(tracker.total()).toEqual(usageOf({ prompt_tokens: 30, completion_tokens: 6, total_tokens: 36, cache_read: 7, reasoning_tokens: 2 }));
  });

  it("returns copies, so callers cannot mutate tracked state", () => {
    const tracker = new UsageTracker();
    tracker.record(usageOf({ prompt_tokens: 1 }));
    const snapshot = tracker.latest();
    snapshot.prompt_tokens = 99;
    expect(tracker.latest().prompt_tokens).toBe(1);
  });

  it("resets both views", () => {
    const tracker = new UsageTracker();
    tracker.record(usageOf({ total_tokens: 5 }));
    tracker.reset();
    expect(tracker.latest()).toEqual(zeroUsage());
    expect(tracker.total()).toEqual(zeroUsage());
  });

  it("computes cache_hit_ratio = cache_read / prompt_tokens, 4 decimals, clamped", () => {
    expect(cacheHitRatioRounded(usageOf({ prompt_tokens: 10_000, cache_read: 7_800 }))).toBe(0.78);
    expect(cacheHitRatioRounded(usageOf({ prompt_tokens: 0, cache_read: 10 }))).toBe(0);
    expect(cacheHitRatioRounded(usageOf({ prompt_tokens: 100, cache_read: 300 }))).toBe(1);
    expect(cacheHitRatioRounded(usageOf({ prompt_tokens: 3, cache_read: 1 }))).toBe(0.3333);
  });

  it("builds the statusline usage block with latest + total", () => {
    const tracker = new UsageTracker();
    tracker.record(usageOf({ prompt_tokens: 10_000, cache_read: 7_800, total_tokens: 10_000 }));
    tracker.record(usageOf({ prompt_tokens: 2_000, cache_read: 1_300, total_tokens: 2_000 }));
    const status = usageStatus(tracker);
    expect(status.cache_read).toBe(1_300);
    expect(status.cache_hit_ratio).toBe(0.65);
    expect(status.total.prompt_tokens).toBe(12_000);
    expect(status.total.cache_read).toBe(9_100);
    expect(status.total.cache_hit_ratio).toBe(0.7583);
  });

  it("maps a Usage onto the frozen UsageBlock fields", () => {
    const block = usageBlock(usageOf({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, cache_read: 1, reasoning_tokens: 2 }));
    expect(Object.keys(block).sort()).toEqual(
      ["cache_hit_ratio", "cache_read", "completion_tokens", "prompt_tokens", "reasoning_tokens", "total_tokens"].sort(),
    );
    expect(block.cache_hit_ratio).toBe(0.25);
  });
});
