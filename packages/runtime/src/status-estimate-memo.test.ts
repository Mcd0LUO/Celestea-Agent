/**
 * W766 — the statusline tick must not RE-estimate an assembly it was already
 * handed.
 *
 * W755 made `context_usage` fall back to the loop's own assembly; W762 memoized
 * that assembly on the session log's state, but the tick still ran
 * `estimatedContextTokens()` over the (unchanged) request on every read, which
 * dominated the tick: 7.4 ms of a 7.4 ms `statusline() [tick]` at 50k events
 * (benchmarks/baseline-v2.6.1.json).
 *
 * This file proves the fix STRUCTURALLY (no timing): the estimator is counted at
 * the package boundary `status.ts` imports it through, so a tick that re-walks
 * the messages shows up as a counter bump.
 */

import { describe, expect, it, vi } from "vitest";
import { LLM_SERVICE, definePlugin, type Message } from "@celestea/core";
import { agentLoopPlugin } from "@celestea/agent-loop";
import { agentConfigFromProfile } from "./agent-config.js";
import { compose } from "./compose.js";
import { createSessionBinding } from "./session-binding.js";
import { estimatedContextTokens } from "./status.js";
import { fakeLlm, memoryLog, memorySessionPlugin, recordingRegistryPlugin, testProfile } from "./fakes.test-util.js";

/** Estimator calls that crossed the package boundary (delegated to the real one). */
const counts = vi.hoisted(() => ({ messages: 0 }));

vi.mock("@celestea/agent-loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@celestea/agent-loop")>();
  return {
    ...actual,
    estimateMessagesTokens: (messages: readonly Message[]): number => {
      counts.messages += 1;
      return actual.estimateMessagesTokens(messages);
    },
  };
});

/** A real DefaultAgentLoop over a real log: the production statusline path. */
function harness(): { runtime: ReturnType<typeof compose>; log: ReturnType<typeof memoryLog> } {
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
  return { runtime, log };
}

describe("context usage estimate memoization (W766)", () => {
  it("estimates an unchanged assembly once, however many ticks read it", () => {
    const { runtime, log } = harness();
    for (let i = 0; i < 20; i += 1) log.append({ type: "user_message", text: `m${i} ${"x".repeat(500)}` });

    counts.messages = 0;
    const first = runtime.statusline().context_usage;
    expect(counts.messages, "the first read estimates").toBe(1);
    expect(first.method).toBe("assembled_estimate");
    expect(first.used).toBeGreaterThan(0);

    // Ten more ticks over an unchanged log: identical payload, zero estimates.
    for (let tick = 0; tick < 10; tick += 1) {
      expect(runtime.statusline().context_usage).toEqual(first);
    }
    expect(counts.messages, "an unchanged log is estimated once").toBe(1);

    // A NEW log state re-derives the assembly AND its estimate — exactly once.
    log.append({ type: "assistant_message", text: "answer" });
    const grown = runtime.statusline().context_usage;
    expect(counts.messages).toBe(2);
    expect(grown.used).toBeGreaterThan(first.used);
    runtime.statusline();
    expect(counts.messages).toBe(2);
  });

  it("hands back the same memoized pair, and the pair agrees with the pure estimator", () => {
    const { runtime, log } = harness();
    log.append({ type: "user_message", text: "hello" });

    const a = runtime.statusView().assembled();
    const b = runtime.statusView().assembled();
    expect(a).not.toBeNull();
    expect(b).toBe(a); // same cached object: nothing was rebuilt or re-estimated
    // ...and the memoized number is the one the pure function produces (no口径 drift).
    expect(a!.tokens).toBe(estimatedContextTokens(a!.request));
    expect(runtime.statusline().context_usage.used).toBe(a!.tokens);
  });

  it("does not pay for the estimate when nothing reads it (usage frame / viewer paths)", () => {
    const { runtime, log } = harness();
    log.append({ type: "user_message", text: "hello" });

    counts.messages = 0;
    // The context viewer path: the assembly alone, no estimate requested.
    const request = runtime.contextSnapshot();
    expect(request).not.toBeNull();
    expect(counts.messages, "contextSnapshot() alone never estimates").toBe(0);
    // The pure reference (its own estimator call is not what we are counting).
    const expected = estimatedContextTokens(request!);
    counts.messages = 0;
    // The estimate is derived on the first demand and reused after that.
    expect(runtime.statusView().assembled()?.tokens).toBe(expected);
    expect(counts.messages, "first demand derives it").toBe(1);
    expect(runtime.statusView().assembled()?.tokens).toBe(expected);
    expect(counts.messages, "second demand reuses it").toBe(1);
  });

  it("re-derives after a rebind (a new log is a new key)", () => {
    const { runtime, log } = harness();
    log.append({ type: "user_message", text: "one" });
    expect(runtime.statusline().context_usage.used).toBeGreaterThan(0);
    counts.messages = 0;
    const other = memoryLog();
    other.append({ type: "user_message", text: "two" });
    runtime.rebind(createSessionBinding({ sessionId: "test/rebound", open: () => other }));
    expect(runtime.statusline().context_usage.used).toBeGreaterThan(0);
    expect(counts.messages, "the swapped-in log is estimated on its own").toBe(1);
  });
});
