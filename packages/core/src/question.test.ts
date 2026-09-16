/**
 * W834 F06 (R3 batch A): `askTimeoutMs` documents its clamp as [1, MAX]; the
 * old body only guarded `<= 0` and then floored, so a requested 0.5ms became a
 * 0ms wait and `setTimeout(0)` expired the question before a human could answer.
 * The probe is the pure function (this file) plus its single real caller
 * (`apps/studio/src/user-questions.ts`, tested in
 * `apps/studio/src/runtime/questions.test.ts`).
 */

import { describe, expect, it } from "vitest";
import { askTimeoutMs, DEFAULT_ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS } from "./question.js";

describe("askTimeoutMs clamps into [1, MAX] (W834 F06)", () => {
  it("never returns 0 for a positive sub-millisecond request", () => {
    expect(askTimeoutMs(0.5)).toBe(1);
    expect(askTimeoutMs(0.99)).toBe(1);
    expect(askTimeoutMs(1)).toBe(1);
    expect(askTimeoutMs(1.9)).toBe(1);
  });

  it("treats absent / non-positive / non-finite as the DEFAULT (never wait forever)", () => {
    for (const v of [undefined, 0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(askTimeoutMs(v), String(v)).toBe(DEFAULT_ASK_TIMEOUT_MS);
    }
  });

  it("floors ordinary values and caps at MAX", () => {
    expect(askTimeoutMs(12_345)).toBe(12_345);
    expect(askTimeoutMs(MAX_ASK_TIMEOUT_MS + 1)).toBe(MAX_ASK_TIMEOUT_MS);
    expect(askTimeoutMs(MAX_ASK_TIMEOUT_MS)).toBe(MAX_ASK_TIMEOUT_MS);
  });
});
