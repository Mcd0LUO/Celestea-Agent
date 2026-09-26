/**
 * W9104 acceptance: the SAME-TARGET retry decorator (`retry.ts`).
 *
 * Everything here is injected — the scripted seam and the sleep — so the file
 * opens no socket and never really waits. What only this level can prove:
 *   * the TRIGGER (retryable status/timeout retried, 400/abort not);
 *   * the BUDGET (`maxRetries` extra attempts, then the error surfaces);
 *   * the PRODUCED LOCK (a failure after visible text is terminal);
 *   * the BACKOFF MATH (`backoffMs * 2^k`, `Retry-After` wins, over-cap = 0);
 *   * the VISIBILITY (one `onRetry` per re-issue, with the delay actually used).
 */

import { describe, expect, it } from "vitest";
import { statusError, timeoutError } from "./errors.js";
import { clampRetries, createRetryLlm, DEFAULT_RETRY_POLICY, MAX_RETRIES, retryDelayMs, type RetryAttemptInfo } from "./retry.js";
import { assistantText, collectStream, userMessage, type Llm, type LlmStream, type StreamEvent } from "./seam.js";

const REQ = { messages: [userMessage("hi")] };

/** A seam that plays one plan per `generate()` call (last plan repeats). */
function scripted(plans: Array<{ error?: unknown; events?: StreamEvent[] }>): { llm: Llm; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    llm: {
      generate: async (): Promise<LlmStream> => {
        const plan = plans[Math.min(calls, plans.length - 1)] ?? {};
        calls += 1;
        if (plan.error !== undefined) throw plan.error;
        const events = plan.events ?? [];
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
        };
      },
    },
  };
}

function done(text: string): StreamEvent[] {
  return [
    { kind: "text", text },
    { kind: "done", message: assistantText(text) },
  ];
}

/** The decorator with an injected sleep that records instead of waiting. */
function harness(plans: Array<{ error?: unknown; events?: StreamEvent[] }>, policy?: { maxRetries?: number; backoffMs?: number; maxDelayMs?: number }): {
  llm: ReturnType<typeof createRetryLlm>;
  seam: { llm: Llm; calls: () => number };
  retries: RetryAttemptInfo[];
  sleeps: number[];
} {
  const seam = scripted(plans);
  const retries: RetryAttemptInfo[] = [];
  const sleeps: number[] = [];
  const llm = createRetryLlm({
    inner: seam.llm,
    target: "primary",
    model: "model-a",
    policy: { backoffMs: 1, ...policy },
    onRetry: (info) => retries.push(info),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { llm, seam, retries, sleeps };
}

describe("W9104 — the trigger table is reused, not re-invented", () => {
  it("retries a retryable status (503) and reports the reason", async () => {
    const h = harness(
      [
        { error: statusError(503, "Service Unavailable", "no") },
        { error: statusError(503, "Service Unavailable", "no") },
        { events: done("Hello") },
      ],
      { maxRetries: 2 },
    );
    const events = await collectStream(await h.llm.generate(REQ));

    expect(events.at(-1)?.kind).toBe("done");
    expect(h.seam.calls()).toBe(3);
    expect(h.retries).toHaveLength(2);
    expect(h.retries.map((r) => [r.attempt, r.reason, r.httpStatus, r.target, r.model])).toEqual([
      [1, "http_503", 503, "primary", "model-a"],
      [2, "http_503", 503, "primary", "model-a"],
    ]);
    // Two retries happened because this harness asked for two — the value really
    // drives the loop (the DEFAULT is one extra attempt; see DEFAULT_RETRY_POLICY).
    expect(h.llm.policy().maxRetries).toBe(2);
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(1);
  });

  it("never retries a non-retryable status (400) — exactly one call, error rethrown", async () => {
    const h = harness([{ error: statusError(400, "Bad Request", "bad") }]);
    await expect(h.llm.generate(REQ)).rejects.toThrow(/stream request failed: Bad Request/);
    expect(h.seam.calls()).toBe(1);
    expect(h.retries).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });

  it("never retries a caller abort, even when the shape looks retryable", async () => {
    const abort = Object.assign(new Error("turn cancelled by the caller"), { name: "AbortError", retryable: true });
    const h = harness([{ error: abort }]);
    await expect(h.llm.generate(REQ)).rejects.toThrow(/cancelled/);
    expect(h.seam.calls()).toBe(1);
    expect(h.retries).toEqual([]);
  });

  it("retries a timeout (the canonical llm timeout prefix) and a torn stream", async () => {
    const timeout = harness([
      { error: timeoutError("stream idle timeout: no data chunk for 90ms") },
      { events: done("ok") },
    ]);
    expect((await collectStream(await timeout.llm.generate(REQ))).at(-1)?.kind).toBe("done");
    expect(timeout.retries[0]?.reason).toBe("timeout_idle");

    const torn = harness([{ events: [{ kind: "interrupted" }] }, { events: done("ok") }]);
    expect((await collectStream(await torn.llm.generate(REQ))).at(-1)?.kind).toBe("done");
    expect(torn.retries[0]?.reason).toBe("interrupted");
  });
});

describe("W9104 — the produced lock and the budget", () => {
  it("never re-issues an attempt that already produced text", async () => {
    const h = harness([
      {
        events: [
          { kind: "text", text: "half an answer" },
          { kind: "failed", kindOf: "stream", message: "upstream stream error: boom" },
        ],
      },
      { events: done("never") },
    ]);
    const events = await collectStream(await h.llm.generate(REQ));

    expect(events.map((e) => e.kind)).toEqual(["text", "failed"]);
    expect(h.seam.calls()).toBe(1);
    expect(h.retries).toEqual([]);
  });

  it("stops after maxRetries extra attempts and surfaces the LAST error", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "first") }], { maxRetries: 2 });
    await expect(h.llm.generate(REQ)).rejects.toThrow(/first/);
    // 1 initial + 2 retries = 3 calls, and the error text is the one the seam threw.
    expect(h.seam.calls()).toBe(3);
    expect(h.retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(h.llm.retries()).toBe(2);
  });

  it("is OFF at maxRetries 0 (one call, no sleep, no report)", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "no") }], { maxRetries: 0 });
    await expect(h.llm.generate(REQ)).rejects.toThrow(/no/);
    expect(h.seam.calls()).toBe(1);
    expect(h.retries).toEqual([]);
  });

  it("reports the maxRetries ceiling on every retry (so a caller can render 'N of M')", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "no") }], { maxRetries: 3 });
    await expect(h.llm.generate(REQ)).rejects.toThrow();
    expect(h.retries.map((r) => r.maxRetries)).toEqual([3, 3, 3]);
    expect(h.retries.map((r) => r.produced)).toEqual([0, 0, 0]);
  });
});

describe("W9104 — backoff math and Retry-After", () => {
  it("waits backoffMs * 2^k between attempts", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "no") }], { maxRetries: 3, backoffMs: 100 });
    await expect(h.llm.generate(REQ)).rejects.toThrow();
    expect(h.sleeps).toEqual([100, 200, 400]);
    expect(h.retries.map((r) => r.delayMs)).toEqual([100, 200, 400]);
  });

  it("honours Retry-After over the exponential backoff, and caps it", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, backoffMs: 100, maxDelayMs: 60_000 };
    expect(retryDelayMs({ retryAfterMs: null }, 0, policy)).toBe(100);
    expect(retryDelayMs({ retryAfterMs: 5_000 }, 0, policy)).toBe(5_000);
    // Beyond the cap the header is not waited out at all (the fallback口径).
    expect(retryDelayMs({ retryAfterMs: 120_000 }, 0, policy)).toBe(0);
    // respectRetryAfter:false = pure backoff.
    expect(retryDelayMs({ retryAfterMs: 5_000 }, 1, { ...policy, respectRetryAfter: false })).toBe(200);
    // The exponential is itself capped.
    expect(retryDelayMs({ retryAfterMs: null }, 20, policy)).toBe(60_000);
  });

  it("does not sleep at all when the delay resolves to 0", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "no") }], { maxRetries: 1, backoffMs: 0 });
    await expect(h.llm.generate(REQ)).rejects.toThrow();
    expect(h.sleeps).toEqual([]);
    expect(h.retries).toHaveLength(1);
  });
});

describe("W9104 — the policy is clamped to the product's hard cap", () => {
  it("clamps a raw count into [0, MAX_RETRIES] and defaults a non-number", () => {
    expect(MAX_RETRIES).toBe(3);
    expect(clampRetries(2)).toBe(2);
    expect(clampRetries(0)).toBe(0);
    expect(clampRetries(-5)).toBe(0);
    expect(clampRetries(99)).toBe(MAX_RETRIES);
    expect(clampRetries(2.7)).toBe(2);
    expect(clampRetries(Number.NaN)).toBe(DEFAULT_RETRY_POLICY.maxRetries);
    expect(clampRetries(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RETRY_POLICY.maxRetries);
    expect(clampRetries("2")).toBe(DEFAULT_RETRY_POLICY.maxRetries);
    expect(clampRetries(undefined)).toBe(DEFAULT_RETRY_POLICY.maxRetries);
  });

  it("cannot be raised past the cap through the decorator's own policy", async () => {
    const h = harness([{ error: statusError(503, "Service Unavailable", "no") }], { maxRetries: 10 });
    await expect(h.llm.generate(REQ)).rejects.toThrow();
    expect(h.llm.policy().maxRetries).toBe(MAX_RETRIES);
    expect(h.seam.calls()).toBe(MAX_RETRIES + 1);
  });
});
