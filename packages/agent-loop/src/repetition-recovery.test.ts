/**
 * W1510 — the pure halves of the repetition guard, pinned on their own.
 *
 * The detector's judgement lives in `repetition.test.ts`. What is pinned HERE is
 * everything the port added around it: the retry plan, the effort ladder, the
 * onset search, and the record shape that makes a false positive diagnosable.
 */

import { describe, expect, it } from "vitest";
import { DEEPSEEK_REPETITION_THRESHOLDS, RepetitionGuard, degenerationOnset } from "./repetition.js";
import { PERTURB_EFFORTS, copyName, perturbedEffort, planRepetition, repetitionRecord } from "./repetition-recovery.js";

/** The exact shape that started this work: "OK. Let me write. Let me go." xN. */
const COLLAPSE = "OK. Let me write. Let me go. ".repeat(200);

/** A healthy prefix of distinct sentences, so the onset is unambiguous. */
const HEALTHY = Array.from(
  { length: 120 },
  (_, i) => `Step ${i} reindexes shard ${(i * 7) % 251} and verifies checksum ${(i * 2654435761) % 100000} before committing.`,
).join(" ");

describe("perturbedEffort — the ported ladder", () => {
  it("steps down one rung", () => {
    expect(perturbedEffort("max")).toBe("high");
    expect(perturbedEffort("high")).toBe("medium");
    expect(perturbedEffort("medium")).toBe("low");
  });

  it("stops at the bottom instead of inventing a value", () => {
    expect(perturbedEffort("low")).toBeNull();
  });

  it("leaves a user-defined tier alone (the upstream may reject a guess)", () => {
    expect(perturbedEffort("xhigh-custom")).toBeNull();
    expect(perturbedEffort(null)).toBeNull();
    expect(perturbedEffort(undefined)).toBeNull();
    expect(perturbedEffort("")).toBeNull();
  });

  it("the ladder is the ported one, in order", () => {
    expect(PERTURB_EFFORTS).toEqual(["max", "high", "medium", "low"]);
  });
});

describe("planRepetition — the retry budget", () => {
  it("discards and re-issues while the budget lasts", () => {
    expect(planRepetition(0, 2)).toEqual({ action: "retry", retriesUsed: 1 });
    expect(planRepetition(1, 2)).toEqual({ action: "retry", retriesUsed: 2 });
  });

  it("truncates once the budget is spent", () => {
    expect(planRepetition(2, 2)).toEqual({ action: "truncate", retriesUsed: 3 });
  });

  it("a zero budget truncates on the FIRST conviction", () => {
    expect(planRepetition(0, 0).action).toBe("truncate");
  });
});

describe("degenerationOnset — where the collapse actually began", () => {
  it("finds the boundary after a healthy prefix", () => {
    const text = `${HEALTHY} ${COLLAPSE}`;
    const onset = degenerationOnset(text);
    // The onset must sit at the healthy/degenerate boundary, not at the end.
    expect(onset).toBeGreaterThan(HEALTHY.length - 200);
    expect(onset).toBeLessThan(HEALTHY.length + 200);
  });

  it("keeps a phrase the healthy prefix used once (run-local vocabulary)", () => {
    // A GLOBAL frequency count would score the prefix's own use of the repeated
    // phrase as a repeat and walk straight through the healthy text. Judging each
    // segment against the CURRENT run's vocabulary is what pins the boundary.
    const shared = "The build is green and the gate passed.";
    const text = `${shared} ${HEALTHY} ${shared} `.repeat(1) + COLLAPSE;
    const onset = degenerationOnset(text);
    expect(onset).toBeGreaterThan(shared.length);
  });

  it("reports nothing to prune for healthy text", () => {
    expect(degenerationOnset(HEALTHY)).toBe(HEALTHY.length);
  });

  it("walks THROUGH a stray unique segment instead of stopping at it", () => {
    // `onsetGapSegments: 2` exists so one odd sentence inside a degenerate run
    // does not get mistaken for the end of it. The walk must therefore keep going
    // back past the stray — a version with tolerance 0 stops right after it and
    // leaves thousands of degenerate characters behind.
    const withStray = COLLAPSE + "a single different observation. " + COLLAPSE;
    const onset = degenerationOnset(withStray);
    expect(onset).toBeLessThan(200);
    expect(onset).toBeLessThan(withStray.length / 2);
  });
});

describe("RepetitionGuard — the evaluation grid is chunk-independent", () => {
  /** Feed the same text in fixed-size chunks; return where it convicted. */
  function convictionPoint(text: string, chunk: number): number | null {
    const guard = new RepetitionGuard();
    for (let i = 0; i < text.length; i += chunk) {
      if (guard.push(text.slice(i, i + chunk), "text") !== null) return guard.convictionAt("text");
    }
    return null;
  }

  it("convicts at the SAME absolute position for every chunk size", () => {
    // The ported property. An accumulate-and-reset counter discards the overshoot,
    // so the evaluation points drift with the provider's SSE framing and the same
    // text convicts at different places — or not at all — purely by accident of
    // chunking. This is the assertion that pins the fix.
    const text = `${HEALTHY} ${COLLAPSE}`;
    const points = [1, 3, 7, 13, 40, 137, 512, 4096].map((chunk) => convictionPoint(text, chunk));
    expect(points.every((point) => point !== null)).toBe(true);
    expect(new Set(points).size).toBe(1);
  });

  it("a large chunk does not skip the grid line entirely", () => {
    // With a counter that resets to zero on overshoot, one huge delta can jump
    // past every evaluation point and never be judged at all.
    const text = `${HEALTHY} ${COLLAPSE}`;
    expect(convictionPoint(text, text.length)).not.toBeNull();
  });
});

describe("repetitionRecord — what a conviction leaves behind", () => {
  const guard = new RepetitionGuard();
  const evidence = guard.push(COLLAPSE, "thinking") ?? guard.push(COLLAPSE, "thinking");

  it("carries the evidence, rounded, with the action and the counts", () => {
    expect(evidence).not.toBeNull();
    const record = repetitionRecord({
      evidence: evidence!,
      action: "discard-and-retry",
      sessionId: "ws/session",
      model: "deepseek-flash",
      seenChars: 9000,
      prunedChars: 0,
      convictionAt: 8800,
      now: new Date("2026-09-25T00:00:00.000Z"),
    });
    expect(record).toMatchObject({
      event: "repetition-detected",
      action: "discard-and-retry",
      sessionId: "ws/session",
      model: "deepseek-flash",
      channel: "thinking",
      seenChars: 9000,
      prunedChars: 0,
      convictionAt: 8800,
      time: "2026-09-25T00:00:00.000Z",
    });
    // Rounded to 4 decimals: a raw float in a log line is noise, not evidence.
    expect(String(record.duplicateShare)).toMatch(/^\d+(\.\d{1,4})?$/);
    expect(record.topPhraseCount).toBeGreaterThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.phraseTopCount);
  });

  it("names the copy after the session and the channel", () => {
    const name = copyName("ws/session:1", evidence!, new Date("2026-09-25T01:02:03.456Z"));
    expect(name).toContain("thinking");
    expect(name).toContain("2026-09-25T01-02-03-456Z");
    expect(name).not.toContain("/");
  });

  it("falls back to a stable name when the session is unknown", () => {
    expect(copyName(null, evidence!, new Date("2026-09-25T01:02:03.456Z"))).toContain("session__");
  });
});
