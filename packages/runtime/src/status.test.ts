import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LLM_SERVICE,
  assistantText,
  definePlugin,
  userMessage,
  zeroUsage,
  type ModelRequest,
  type SessionEvent,
  type ToolSpec,
  type Usage,
} from "@celestea/core";
import { agentLoopPlugin, estimateMessagesTokens, estimateTokens } from "@celestea/agent-loop";
import { deriveMessages, parseSessionJsonl } from "@celestea/session";
import { agentConfigFromProfile } from "./agent-config.js";
import { compose } from "./compose.js";
import {
  ContextPressure,
  GAP_MS,
  StatusTracker,
  activeSpanMs,
  createStatusTracker,
  estimatedContextChars,
  estimatedContextTokens,
  ratio4,
  statuslineOf,
  turnRate,
  type StatusView,
} from "./status.js";
import { UsageTracker, cacheHitRatioRounded, usageBlock, usageStatus } from "./usage.js";
import { fakeLlm, fakeLoop, memoryLog, memorySessionPlugin, recordingRegistryPlugin, testProfile, tick } from "./fakes.test-util.js";

const usageOf = (u: Partial<Usage>): Usage => ({ ...zeroUsage(), ...u });

const events: SessionEvent[] = [
  { type: "turn_start", id: "turn-0" },
  { type: "user_message", text: "12345" },
  { type: "thinking_delta", text: "ignored" },
  { type: "assistant_message", text: "123" },
  { type: "tool_call", id: "c1", name: "read_file", args: { path: "ab" } },
  { type: "tool_result", id: "c1", value: "xyz", error: null },
  { type: "turn_end", id: "turn-0", outcome: "completed" },
];

/** A view with the W755 fields filled in; each test overrides what it measures. */
const viewOf = (over: Partial<StatusView> = {}): StatusView => ({
  model: "m",
  reasoning_effort: null,
  status: createStatusTracker(),
  usage: new UsageTracker(),
  context_window: 1_000,
  events: () => events,
  assembled: () => null,
  pressure: new ContextPressure(),
  ...over,
});

/** A request whose token estimate this test can predict: one system string. */
const systemOnly = (chars: number): ModelRequest => ({
  model: "m",
  system: "x".repeat(chars),
  messages: [],
  tools: [],
  max_tokens: null,
  temperature: null,
});

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

});

describe("context usage + statusline", () => {
  it("counts the model-visible characters only", () => {
    expect(estimatedContextChars(events)).toBe(
      5 + 3 + ("c1".length + "read_file".length + JSON.stringify({ path: "ab" }).length) + ("c1".length + JSON.stringify("xyz").length),
    );
  });

  it("W755 regression anchor: the log's CHARACTER count is never reported as tokens", () => {
    // The anchor only means something when the log is FAR bigger than the request
    // (here: the trimmed-away prefix), and pure ASCII keeps `bytes/4` and
    // `chars/4` on the same scale — so `used * 4 <= chars` really is the "a
    // quarter of the characters, at most" pin. Before W755 the same view reported
    // `used === chars` (565,437 chars against a 1,000,000 TOKEN window).
    const bigLog: SessionEvent[] = [];
    for (let i = 0; i < 40; i += 1) {
      bigLog.push({ type: "user_message", text: "u".repeat(1_000) });
      bigLog.push({ type: "assistant_message", text: "a".repeat(1_000) });
    }
    const chars = estimatedContextChars(bigLog);
    expect(chars).toBe(80_000);
    const request: ModelRequest = { ...systemOnly(400), messages: [userMessage("u".repeat(1_000))] };
    const line = statuslineOf(viewOf({ events: () => bigLog, assembled: () => request }));
    expect(line.context_usage.method).toBe("assembled_estimate");
    expect(line.context_usage.used * 4).toBeLessThanOrEqual(chars);
    expect(line.context_usage.used).toBeLessThan(chars / 4);
  });

  it("prefers the real prompt and only reports 'none' when nothing is measurable", () => {
    const usage = new UsageTracker();
    const pressure = new ContextPressure();
    const view = (): StatusView => viewOf({ usage, pressure });
    const nothing = statuslineOf(view());
    expect(nothing.context_usage).toMatchObject({
      used: 0,
      window: 1_000,
      ratio: 0,
      estimated: true,
      method: "none",
      projected: false,
      window_source: "profile",
    });
    usage.record(usageOf({ prompt_tokens: 250, total_tokens: 250 }));
    const real = statuslineOf(view());
    expect(real.context_usage).toEqual({
      used: 250,
      window: 1_000,
      ratio: 0.25,
      estimated: false,
      method: "usage_prompt_tokens",
      projected: false,
      window_source: "profile",
    });
  });

  it("falls back to the engine's own assembly, within 25% of it (W755 Fix A)", () => {
    const request: ModelRequest = {
      model: "m",
      system: "You are celestea. ".repeat(100),
      messages: [userMessage("hello"), assistantText("hi there"), userMessage("again")],
      tools: [{ name: "read_file", description: "read a file", parameters: { type: "object" } }],
      max_tokens: null,
      temperature: null,
    };
    // The reference the contract names: messages + system + the tool schemas.
    const reference =
      estimateMessagesTokens(request.messages) +
      estimateTokens(request.system ?? "") +
      estimateTokens(JSON.stringify(request.tools));
    const cu = statuslineOf(viewOf({ assembled: () => request })).context_usage;
    expect(cu.method).toBe("assembled_estimate");
    expect(cu.estimated).toBe(true);
    expect(cu.projected).toBe(false);
    expect(cu.used).toBe(reference);
    expect(Math.abs(cu.used - reference) / reference).toBeLessThanOrEqual(0.25);
  });

  it("reports an unknown window instead of the 1,000,000 display default (W755 Fix C)", () => {
    const usage = new UsageTracker();
    usage.record(usageOf({ prompt_tokens: 500, total_tokens: 500 }));
    const off = statuslineOf(viewOf({ usage, context_window: 0 }));
    // No capacity -> no ratio. The display default never becomes a denominator.
    expect(off.context_usage).toMatchObject({ used: 500, window: 0, ratio: 0, window_source: "fallback" });
    const garbage = statuslineOf(viewOf({ usage, context_window: Number.NaN }));
    expect(garbage.context_usage).toMatchObject({ window: 0, ratio: 0, window_source: "unknown" });
    const declared = statuslineOf(viewOf({ usage, context_window: 2_000 }));
    expect(declared.context_usage).toMatchObject({ window: 2_000, ratio: 0.25, window_source: "profile" });
  });

});

describe("context usage projection (W755 Fix B)", () => {
  it("projects the visible growth since the prompt sample (W755 Fix B)", () => {
    const usage = new UsageTracker();
    const pressure = new ContextPressure();
    let systemChars = 4_000;
    const view = (): StatusView => viewOf({ usage, pressure, assembled: () => systemOnly(systemChars) });

    usage.record(usageOf({ prompt_tokens: 5_000, total_tokens: 5_000 }));
    const sampled = estimatedContextTokens(systemOnly(systemChars));
    const first = statuslineOf(view()).context_usage;
    expect(first).toMatchObject({ used: 5_000, estimated: false, method: "usage_prompt_tokens", projected: false });

    // Tool results roll into the surface before the next request: the number has
    // to move NOW, not one step late (DSH `projectedTokens`).
    systemChars += 4_000;
    const second = statuslineOf(view()).context_usage;
    expect(second.projected).toBe(true);
    expect(second.used).toBe(5_000 + (estimatedContextTokens(systemOnly(systemChars)) - sampled));

    systemChars += 4_000;
    const third = statuslineOf(view()).context_usage;
    expect(third.used).toBeGreaterThan(second.used);

    // A NEW sample re-anchors: no stale growth is carried over.
    usage.record(usageOf({ prompt_tokens: 7_000, total_tokens: 7_000 }));
    expect(statuslineOf(view()).context_usage).toMatchObject({ used: 7_000, projected: false });
  });

  it("never decreases inside a turn and never drops below the latest real prompt (W755 Fix B)", () => {
    const usage = new UsageTracker();
    const pressure = new ContextPressure();
    const view = (): StatusView => viewOf({ usage, pressure, assembled: () => systemOnly(systemChars) });
    // One provider sample per step, and the visible surface grows in between (the
    // step's tool results / injected receipts) exactly as a real turn does.
    const samples = [5_000, 8_000, 9_500, 14_500];
    const growth = [0, 3_000, 1_500, 5_000];
    let systemChars = 4_000;
    let prompt = 0;
    let previous = 0;
    const observe = (): void => {
      const cu = statuslineOf(view()).context_usage;
      expect(cu.used, `used >= latest real prompt (${prompt})`).toBeGreaterThanOrEqual(prompt);
      expect(cu.used, "monotone within the turn").toBeGreaterThanOrEqual(previous);
      previous = cu.used;
    };
    for (let i = 0; i < samples.length; i += 1) {
      for (const fraction of [0.5, 1]) {
        systemChars = 4_000 + growth[i]! * fraction * 4;
        observe();
      }
      prompt = samples[i]!;
      usage.record(usageOf({ prompt_tokens: prompt, total_tokens: prompt }));
      observe();
    }
    expect(previous).toBe(14_500);
  });

  it("wires the loop's own assembly through the composed runtime (W755 Fix A)", () => {
    const profile = testProfile();
    const log = memoryLog();
    const reg = recordingRegistryPlugin();
    const runtime = compose({
      profile,
      plugins: [
        memorySessionPlugin(log),
        reg.plugin,
        definePlugin("test.llm", (ctx) => ctx.provide(LLM_SERVICE, fakeLlm())),
        agentLoopPlugin(agentConfigFromProfile(profile, {})),
      ],
      workers: false,
    });
    log.append({ type: "user_message", text: "hello" });
    const request = runtime.statusView().assembled();
    expect(request).not.toBeNull();
    const line = runtime.statusline();
    expect(line.context_usage.method).toBe("assembled_estimate");
    expect(line.context_usage.used).toBe(estimatedContextTokens(request!));
    expect(line.context_usage).toMatchObject({ window: 65_536, window_source: "profile", projected: false, estimated: true });
    // Growing the log grows the number, with no usage frame anywhere.
    log.append({ type: "user_message", text: "x".repeat(4_000) });
    expect(runtime.statusline().context_usage.used).toBeGreaterThan(line.context_usage.used);
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
    // A scripted loop has no `contextSnapshot` and no usage frame -> the honest
    // "unknown" branch, never the retired char-vs-token estimate (W755).
    expect(line.context_usage.estimated).toBe(true);
    expect(line.context_usage.method).toBe("none");
    expect(line.context_usage.used).toBe(0);
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
