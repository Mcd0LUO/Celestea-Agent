/**
 * W754 + W763 rate tests — the window half and the turn-average half.
 *
 * Split out of `status.test.ts` (which keeps steps / statusline / context usage)
 * to stay inside the ESLint size budget (file <= 400 lines, block <= 150): this
 * file is the whole rate story, every case on an injected clock.
 */
import { describe, expect, it } from "vitest";
import { GAP_MS, StatusTracker, activeSpanMs, createStatusTracker, tokensFromBytes, turnRate } from "./status.js";

/**
 * W1467: feed a given number of TOKENS of ASCII output. ASCII is 1 byte per
 * character, so N tokens is exactly N * 4 bytes — which makes every expected
 * number below read directly as a token rate, the unit the field claims.
 */
function addTokens(tracker: StatusTracker, tokens: number): void {
  tracker.addDelta("x".repeat(tokens * 4));
}

describe("StatusTracker rate (W754 + W763)", () => {
  it("resets steps and the rate window at turn start", async () => {
    let clock = 0;
    const tracker = createStatusTracker(() => clock);
    tracker.addStep();
    addTokens(tracker, 100);
    tracker.beginTurn();
    expect(tracker.stepCount).toBe(0);
    expect(tracker.rate()).toBe(0);
  });

  it("averages tokens per second over a stable stream (W754)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 10; i += 1) {
      clock = i * 100;
      addTokens(tracker, 10);
    }
    // 10 deltas x 10 tokens over a 900ms stream; the stream is still live at t=1s,
    // so the active span is 1s -> exactly 100 tok/s (the 5s window still holds it).
    clock = 1_000;
    expect(tracker.rate()).toBe(100);
  });

  it("does not dilute the rate across a no-flow break (W754)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 10; i += 1) {
      clock = i * 100;
      addTokens(tracker, 10);
    }
    clock = 3_900; // 3s of silence (tool call / stall): the wall clock keeps running...
    for (let i = 0; i < 10; i += 1) {
      clock = 3_900 + i * 100;
      addTokens(tracker, 10);
    }
    clock = 4_900;
    // ...but the break is free: two 1s activity intervals -> 200 tokens / 2s = 100.
    // The pre-W754 formula divided by the 4.9s wall-clock span and reported ~41.
    expect(tracker.rate()).toBe(100);
  });

  it("keeps the rate after a stall longer than GAP_MS (W754)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (const at of [0, 500, 1_000, 1_500, 2_000]) {
      clock = at;
      addTokens(tracker, 50);
    }
    // 250 tokens over a 2s active stream, then a 1.1s pause (past GAP_MS):
    // the trailing pause is not part of the denominator -> 125 tok/s (was 80.6).
    clock = 3_100;
    expect(tracker.rate()).toBe(125);
  });

  it("reports zero only before the turn's first delta (W754 + W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    expect(tracker.rate()).toBe(0); // TTFT: nothing has flowed this turn yet
    addTokens(tracker, 10);
    clock = 6_000; // the only sample rolled out of the 5s window...
    expect(tracker.rate()).toBe(10); // ...but W763 keeps the turn's mean (10 tokens / 1s floor)
  });

  it("drops samples that rolled out of the 5s window (W754)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    addTokens(tracker, 50);
    clock = 1_000;
    addTokens(tracker, 50);
    expect(tracker.rate()).toBe(100); // 100 tokens over the 1s active span
    clock = 6_100; // both samples are now older than RATE_WINDOW_MS
    expect(tracker.rate()).toBe(100); // W763: the empty window hands over to the TURN mean
    clock = 6_700;
    addTokens(tracker, 20); // a fresh sample enters the window; the two old ones never come back
    clock = 6_800;
    expect(tracker.rate()).toBe(20); // only the fresh sample counts: 20 tokens / 1s floor
  });

  it("never reports a silly rate for a single burst (1s floor)", () => {
    let clock = 5_000;
    const tracker = new StatusTracker(() => clock);
    addTokens(tracker, 10);
    clock += 5;
    expect(tracker.rate()).toBe(10);
  });

  it("splits samples into activity intervals at GAP_MS", () => {
    const samples = [0, 200, 400, 4_000, 4_200].map((at) => ({ at, bytes: 4 }));
    // Interval [0,400] -> span 400 floored to 1s; break at 3.6s (free);
    // interval [4000,4200] extended to now=4200 -> floored to 1s.
    expect(activeSpanMs(samples, 4_200)).toBe(2_000);
    expect(activeSpanMs([], 4_200)).toBe(0);
    expect(GAP_MS).toBe(1_000);
  });

  it("keeps a positive, undiluted rate after a stall longer than the window (W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (const at of [0, 500, 1_000, 1_500, 2_000]) {
      clock = at;
      addTokens(tracker, 50);
    }
    expect(tracker.rate()).toBe(125); // 250 tokens over the 2s active stream (W754 window)
    clock = 8_000; // 6s past the last delta: the 5s window is EMPTY — the old code said 0
    expect(tracker.rate()).toBe(125); // W763: the turn's active-interval mean, untouched
    clock = 30_000; // ...and it stays there: no dilution, no decay to zero
    expect(tracker.rate()).toBe(125);
  });

  it("keeps the rate after the turn ends and the window empties (W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 10; i += 1) {
      clock = i * 100;
      addTokens(tracker, 10);
    }
    clock = 1_000;
    expect(tracker.rate()).toBe(100); // live window rate
    clock = 10_000; // the turn is over and the window has long emptied
    expect(tracker.rate()).toBe(100);
    clock = 60_000; // a minute later the reading is still the turn's rate
    expect(tracker.rate()).toBe(100);
  });

  it("falls back to zero only when a NEW turn has not flowed yet (W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    addTokens(tracker, 500);
    clock = 9_000;
    expect(tracker.rate()).toBe(500); // the old turn's mean: 500 tokens / 1s floor
    tracker.beginTurn();
    expect(tracker.rate()).toBe(0); // TTFT of the next turn
    expect(tracker.turnSegmentCount).toBe(0);
  });

  it("compresses a continuous stream into ONE interval, whatever the delta count (W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 10_000; i += 1) {
      clock = i;
      addTokens(tracker, 1);
    }
    expect(tracker.turnSegmentCount).toBe(1); // O(pauses), not O(deltas)
    expect(tracker.rate()).toBeCloseTo(1_000, 0); // 10k tokens over ~10s of stream
  });

  it("opens one interval per stoppage, and averages over them without dilution (W763)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 5; i += 1) {
      clock = i * 100;
      addTokens(tracker, 10);
    }
    clock = 5_000; // a pause past GAP_MS splits the turn into two intervals
    for (let i = 0; i < 5; i += 1) {
      clock = 5_000 + i * 100;
      addTokens(tracker, 10);
    }
    expect(tracker.turnSegmentCount).toBe(2);
    clock = 20_000; // window empty -> 100 tokens over the two 1s intervals: the pause is free
    expect(tracker.rate()).toBe(50);
  });

  it("exposes the turn-average helper (W763)", () => {
    expect(turnRate([], 1_000)).toBe(0); // no delta this turn -> 0
    expect(turnRate([{ start: 0, at: 900, bytes: 360 }], 900)).toBe(90); // 900ms span floored to 1s
    expect(turnRate([{ start: 0, at: 0, bytes: 40 }], 500)).toBe(10); // live tail, still floored to 1s
    // Two 1s intervals 3s apart: 100 tokens / 2s — the 3s break is not in the denominator.
    expect(turnRate([{ start: 0, at: 900, bytes: 200 }, { start: 3_900, at: 4_800, bytes: 200 }], 20_000)).toBe(50);
  });
});

describe("StatusTracker rate unit conversion (W1467)", () => {
  /**
   * W1467: the numerator is a TOKEN estimate, so the reported number no longer
   * depends on the alphabet. This is the regression that motivated the change:
   * the same amount of MODEL OUTPUT (one CJK character ~= one token) used to be
   * reported ~3x faster than English, because the numerator counted UTF-8 bytes
   * as if every byte were a character.
   */
  it("counts tokens, not characters: CJK is not over-reported (W1467)", () => {
    const ascii = new StatusTracker(() => 0);
    const cjk = new StatusTracker(() => 0);
    // 400 English characters = 400 bytes = 100 tokens.
    ascii.addDelta("a".repeat(400));
    // 400 CJK characters = 1200 bytes = 300 tokens (one char ~= one token in reality).
    cjk.addDelta("中".repeat(400));
    // Same 1s floor on both sides: the ratio is exactly the token ratio 300/100.
    expect(ascii.rate()).toBe(100);
    expect(cjk.rate()).toBe(300);
    // The OLD (characters-per-second)口径 read 400 vs 1200 for these same two
    // streams: the CJK figure was inflated by the UTF-8 byte width.
    expect(cjk.rate() / ascii.rate()).toBe(3);
  });

  /**
   * W1467: a stream arrives as many SMALL deltas, so the conversion must happen
   * once on the accumulated bytes. Rounding each delta up individually would
   * report a 1-character-per-delta stream as ~4x too fast.
   */
  it("does not round each tiny delta up (W1467)", () => {
    let clock = 0;
    const tracker = new StatusTracker(() => clock);
    for (let i = 0; i < 100; i += 1) {
      clock = i * 10;
      tracker.addDelta("a"); // 1 byte per delta; 100 deltas = 100 bytes = 25 tokens
    }
    clock = 1_000; // one active second
    expect(tracker.rate()).toBe(25); // NOT 100 (a per-delta ceil would say 100)
  });

  it("tokensFromBytes matches the estimateTokens ratio (W1467)", () => {
    expect(tokensFromBytes(0)).toBe(0);
    expect(tokensFromBytes(1)).toBe(1);
    expect(tokensFromBytes(4)).toBe(1);
    expect(tokensFromBytes(5)).toBe(2);
    expect(tokensFromBytes(400)).toBe(100);
    expect(tokensFromBytes(1200)).toBe(300);
  });
});

