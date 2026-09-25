/**
 * W1510 — degenerate-repetition detector tests.
 *
 * Two things are being pinned here, and the second matters more than the first:
 *
 *  1. the detector FIRES on every real degenerate shape (phrase repetition and
 *     "same thing in different words" low-information repetition);
 *  2. the detector does NOT fire on legitimate repetitive-but-informative
 *     output — repeated `return null;` across functions, repeated assertions,
 *     repeated stack traces, repeated table rows, and long normal prose.
 *     A false positive aborts a healthy turn, so it is worse than a miss.
 */

import { describe, expect, it } from "vitest";
import {
  createRepetitionGuard,
  DEEPSEEK_REPETITION_THRESHOLDS,
  detectRepetition,
  evaluateRepetitionWindow,
  isDeepSeekModel,
  RepetitionGuard,
  type RepetitionThresholds,
} from "./repetition.js";

/** The exact shape that started this work: "OK. Let me write. Let me go." ×N. */
const DEGENERATE_SHORT_PHRASE = "OK. Let me write. Let me go. ".repeat(200);

/** Phrase repetition without the ultra-short fragments. */
const DEGENERATE_SENTENCE = "OK. Let me write the file now. ".repeat(40);

/** "Same thing, different words": no identical sentence, but no new content. */
const DEGENERATE_LOW_INFORMATION = (
  "I think the answer is here. Let me consider this once more. Perhaps I should check again. " +
  "It seems fine to me now. Let me think about whether that is right. "
).repeat(30);

/** A single sentence restated almost verbatim. */
const DEGENERATE_RESTATED = "I will now write the report to the results directory so that the work is recorded. ".repeat(30);

/** A plain, long, healthy answer that reuses stock phrases naturally. */
const LEGITIMATE_PROSE = (
  "The detector keeps a bounded rolling window over the stream. It counts how often the same phrase appears " +
  "inside that window. It also measures how much of the window is new information. Thresholds are deliberately " +
  "conservative because a false positive is worse than a miss. "
).repeat(4);

describe("isDeepSeekModel", () => {
  it("matches the DeepSeek family, case-insensitively and with a vendor prefix", () => {
    for (const model of ["deepseek-chat", "deepseek-reasoner", "DeepSeek-V3", "DEEPSEEK-R1", "acme/deepseek-r1"]) {
      expect(isDeepSeekModel(model)).toBe(true);
    }
  });

  it("rejects every other model — the hard requirement is no collateral damage", () => {
    for (const model of ["gpt-4o", "claude-sonnet-4", "gemini-2.5-pro", "qwen-max", "kimi-k2", "", "   "]) {
      expect(isDeepSeekModel(model)).toBe(false);
    }
  });

  it("createRepetitionGuard is null (fail closed) for a non-DeepSeek model", () => {
    expect(createRepetitionGuard("gpt-4o")).toBeNull();
    expect(createRepetitionGuard("")).toBeNull();
    expect(createRepetitionGuard("deepseek-chat")).toBeInstanceOf(RepetitionGuard);
  });
});

describe("detectRepetition — degenerate shapes fire", () => {
  const cases: Array<[string, string]> = [
    ["short-phrase collapse", DEGENERATE_SHORT_PHRASE],
    ["sentence collapse", DEGENERATE_SENTENCE],
    ["low-information restatement", DEGENERATE_LOW_INFORMATION],
    ["near-verbatim restatement", DEGENERATE_RESTATED],
  ];
  for (const [name, text] of cases) {
    it(`${name} is convicted`, () => {
      const evidence = detectRepetition([text]);
      expect(evidence).not.toBeNull();
      expect(evidence?.segments).toBeGreaterThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.minSegments);
      expect(evidence?.duplicateShare).toBeGreaterThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.lowInfoDupShare);
      expect(evidence?.uniqueGramRatio).toBeLessThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.maxUniqueGramRatio);
    });
  }

  it("the conviction reports the phrase it saw, for the log line", () => {
    const evidence = detectRepetition([DEGENERATE_SHORT_PHRASE]);
    expect(evidence?.kind).toBe("phrase");
    expect(evidence?.topPhrase).toContain("let me write");
    expect(evidence?.longestRun).toBeGreaterThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.phraseRun);
  });
});

describe("detectRepetition — legitimate repetitive output stays clean (the key negative)", () => {
  /** 14 small functions that each guard with `return null` — genuinely repetitive code. */
  const REPEATED_NULL_CODE = Array.from(
    { length: 14 },
    (_, i) =>
      `export function pick${i}(x: unknown): Item | null {\n` +
      "  if (x === null) return null;\n" +
      "  if (x === undefined) return null;\n" +
      `  const v = coerce${i}(x);\n` +
      "  if (v === null) return null;\n" +
      "  return v;\n}",
  ).join("\n");

  /** One function whose body is 20 identical early returns. */
  const TWENTY_RETURNS = "function pick(x){\n" + "  if (check(x)) return null;\n".repeat(20) + "  return x;\n}";

  /**
   * A stack trace whose frames differ only in the file/line — the real shape of a
   * repeated error log. Deliberately NOT byte-identical: a block of identical
   * long lines with no prose is convicted by design (see the module header).
   */
  const DISTINCT_STACK = Array.from(
    { length: 30 },
    (_, i) =>
      "TypeError: cannot read properties of undefined (reading 'x')\n" +
      `    at Object.<anonymous> (/app/src/module${i}.ts:${40 + i}:11)`,
  ).join("\n");

  /** 80 Markdown table rows, each distinct. */
  const TABLE = Array.from({ length: 80 }, (_, i) => `| W${i} | ${(i * 7) % 13} | pass |`).join("\n");

  /** 60 distinct to-do lines. */
  const TODO_LIST = Array.from(
    { length: 60 },
    (_, i) => `- task ${i}: refactor module ${i} and run its focused test`,
  ).join("\n");

  /** 60 distinct vitest PASS lines. */
  const VITEST_OUTPUT = Array.from(
    { length: 60 },
    (_, i) => `PASS src/module${i}.test.ts (${(i % 7) + 1}.${i % 9}ms)`,
  ).join("\n");

  /** A report that quotes the same command block 12 times, with prose between. */
  const REPEATED_COMMAND_BLOCK = Array.from(
    { length: 12 },
    (_, i) =>
      `## Section ${i}\n\nRun the gate:\n\n\`\`\`bash\npnpm check:fast\n\`\`\`\n` +
      "Then record the exit code and move on to the next section of this report.\n\n",
  ).join("");

  /** 30 distinct English propositions. */
  const ESSAY_EN = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i} states a distinct proposition about the system under test and its behaviour.`,
  ).join(" ");

  /** 30 distinct Chinese propositions. */
  const ESSAY_ZH = Array.from(
    { length: 30 },
    (_, i) => `第${i}条说明系统在边界条件下的行为与它对外承诺的语义。`,
  ).join("");

  /** A realistic long engineering answer: eight distinct points, restated four times. */
  const LONG_ANSWER = Array.from({ length: 4 }, () =>
    [
      "The loop consumes the stream delta by delta and appends exactly one turn_end row per turn.",
      "The window is bounded so memory does not grow with the length of the answer.",
      "We did not add a new cancellation mechanism; the existing AbortSignal checkpoints cover every await.",
      "The detector only runs for the DeepSeek family, and the gate fails closed for every other model.",
      "Thresholds were calibrated on a corpus of real long answers, so the margin is wide.",
      "The handoff directive is a model-facing instruction, which is why it is not routed through i18n.",
      "Each new assertion has a mutation negative control that must turn the test red.",
      "Verification ran through check:fast, which is read-only and produces no artifacts.",
    ].join(" "),
  ).join("\n\n");

  const negatives: Array<[string, string]> = [
    ["a normal long answer", LEGITIMATE_PROSE],
    ["a long engineering answer restating eight points", LONG_ANSWER],
    ["14 functions repeating `return null`", REPEATED_NULL_CODE],
    ["one function with 20 identical returns", TWENTY_RETURNS],
    ["30 stack frames differing only in file and line", DISTINCT_STACK],
    ["an 80-row Markdown table", TABLE],
    ["a 60-line to-do list", TODO_LIST],
    ["60 vitest PASS lines", VITEST_OUTPUT],
    ["the same command block 12 times", REPEATED_COMMAND_BLOCK],
    ["a 30-sentence English essay", ESSAY_EN],
    ["a 30-sentence Chinese essay", ESSAY_ZH],
  ];

  for (const [name, text] of negatives) {
    it(`${name} is NOT convicted`, () => {
      expect(detectRepetition([text])).toBeNull();
    });
  }

  it("a healthy answer that merely OPENS like the degenerate one stays clean", () => {
    // Same first sentence as the collapse, then real content: the guard must not
    // key on a stock opener.
    const text =
      "OK. Let me write the file now. " +
      Array.from(
        { length: 40 },
        (_, i) => `Section ${i} records a different finding about module ${i} and its verified exit code.`,
      ).join(" ");
    expect(detectRepetition([text])).toBeNull();
  });
});

describe("RepetitionGuard — online, incremental, bounded", () => {
  it("convicts on a delta-by-delta feed, not only on one big chunk", () => {
    const guard = new RepetitionGuard();
    let hit: unknown = null;
    for (let i = 0; i < 400 && hit === null; i += 1) hit = guard.push("OK. Let me write. Let me go. ");
    expect(hit).not.toBeNull();
    expect(guard.evidence).not.toBeNull();
  });

  it("keeps memory bounded by the window no matter how long the answer is", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 5000; i += 1) {
      guard.push(`Sentence ${i} is unique enough to keep the window healthy for this memory test. `);
    }
    expect(guard.retainedChars()).toBeLessThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.windowChars);
  });

  it("bounds each channel independently, so reasoning cannot inflate the text window", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 3000; i += 1) {
      guard.push(`Reasoning step ${i} restates a distinct premise about the module under test. `, "thinking");
    }
    guard.push("A short healthy answer sentence.", "text");
    expect(guard.retainedChars("thinking")).toBeLessThanOrEqual(DEEPSEEK_REPETITION_THRESHOLDS.windowChars);
    expect(guard.retainedChars("text")).toBeLessThan(200);
  });

  it("a single healthy delta never convicts and reports no evidence", () => {
    const guard = new RepetitionGuard();
    expect(guard.push("A short healthy opening sentence.")).toBeNull();
    expect(guard.evidence).toBeNull();
  });

  it("judges on a cadence, not on every delta", () => {
    // With a huge `evalEveryChars`, nothing may be judged until the cadence
    // elapses — even though the same window would convict instantly if it were
    // evaluated. This pins the amortization gate: removing it makes the FIRST
    // push convict and the first assertion below fail.
    const cadence: RepetitionThresholds = {
      ...DEEPSEEK_REPETITION_THRESHOLDS,
      windowChars: 100_000,
      minWindowChars: 100,
      minSegments: 1,
      evalEveryChars: 3000,
    };
    const guard = new RepetitionGuard(cadence);
    expect(guard.push(DEGENERATE_SHORT_PHRASE.slice(0, 2000))).toBeNull();
    expect(guard.evidence).toBeNull();
    // Crossing the cadence evaluates the window, which is degenerate by now.
    expect(guard.push(DEGENERATE_SHORT_PHRASE.slice(0, 2000))).not.toBeNull();
  });

  it("covers the reasoning channel — the channel the production incident collapsed in", () => {
    // Session `--src-unreg--` degenerated entirely inside reasoning while its
    // answer text stayed healthy, so a text-only guard would never have fired.
    const guard = new RepetitionGuard();
    let hit: unknown = null;
    for (let i = 0; i < 400 && hit === null; i += 1) hit = guard.push("Let me produce the report. ", "thinking");
    expect(hit).not.toBeNull();
    expect(guard.evidence?.channel).toBe("thinking");
  });

  it("keeps the channels separate: healthy text never dilutes a collapsing reasoning burst", () => {
    const guard = new RepetitionGuard();
    // Interleave a large healthy answer with a collapsing reasoning burst. If the
    // two shared one window, the answer would keep the duplicate share low and the
    // burst would never be convicted.
    let hit: unknown = null;
    for (let i = 0; i < 300 && hit === null; i += 1) {
      guard.push(`Point ${i} records a distinct verified observation about module ${i}. `, "text");
      hit = guard.push("Let me produce the report. ", "thinking");
    }
    expect(hit).not.toBeNull();
    expect(guard.evidence?.channel).toBe("thinking");
  });

  it("a healthy reasoning burst is never convicted", () => {
    const guard = new RepetitionGuard();
    for (let i = 0; i < 200; i += 1) {
      expect(guard.push(`Reasoning step ${i} examines a distinct hypothesis about module ${i}. `, "thinking")).toBeNull();
    }
    expect(guard.evidence).toBeNull();
  });

  it("stays silent below the minimum window — too little evidence to convict", () => {
    const short = "Let me write. ".repeat(60);
    expect(short.length).toBeLessThan(DEEPSEEK_REPETITION_THRESHOLDS.minWindowChars);
    expect(detectRepetition([short])).toBeNull();
  });
});

describe("evaluateRepetitionWindow — pure, and each rule is load-bearing", () => {
  it("is deterministic: the same text always yields the same verdict", () => {
    const a = evaluateRepetitionWindow(DEGENERATE_SHORT_PHRASE);
    const b = evaluateRepetitionWindow(DEGENERATE_SHORT_PHRASE);
    expect(a).toEqual(b);
  });

  it("returns null for text shorter than the minimum window", () => {
    expect(evaluateRepetitionWindow("too short to judge at all")).toBeNull();
  });

  it("a high duplicate share ALONE does not convict (the phrase rule must also hold)", () => {
    // Raising the duplicate requirement past 1.0 makes the low-information leg
    // unreachable, so the text must be acquitted even though it is duplicated —
    // the mutation control for the low-information share gate.
    const strict: RepetitionThresholds = { ...DEEPSEEK_REPETITION_THRESHOLDS, lowInfoDupShare: 1.01 };
    expect(evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION, strict)).toBeNull();
    expect(evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION)).not.toBeNull();
  });

  it("a low k-gram ratio ALONE does not convict (the novelty gate is load-bearing)", () => {
    // With an unreachable novelty bound the low-information leg can never hold,
    // so the text must be acquitted despite the duplicated window.
    const noNoveltyGate: RepetitionThresholds = { ...DEEPSEEK_REPETITION_THRESHOLDS, maxUniqueGramRatio: 0 };
    expect(evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION, noNoveltyGate)).toBeNull();
  });

  it("the phrase rule is load-bearing on its own axis", () => {
    // With an unreachable phrase run and an unreachable top count, the phrase leg
    // fails and the text is acquitted despite the low-information leg holding.
    const noPhraseGate: RepetitionThresholds = {
      ...DEEPSEEK_REPETITION_THRESHOLDS,
      phraseRun: 100_000,
      phraseTopCount: 100_000,
    };
    expect(evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION, noPhraseGate)).toBeNull();
    expect(evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION)).not.toBeNull();
  });

  it("the segment-count floor is load-bearing: too few segments acquits", () => {
    const noSegments: RepetitionThresholds = { ...DEEPSEEK_REPETITION_THRESHOLDS, minSegments: 100_000 };
    expect(evaluateRepetitionWindow(DEGENERATE_SENTENCE, noSegments)).toBeNull();
    expect(evaluateRepetitionWindow(DEGENERATE_SENTENCE)).not.toBeNull();
  });

  it("the window bound is load-bearing: shrinking it below the evidence acquits", () => {
    const tiny: RepetitionThresholds = { ...DEEPSEEK_REPETITION_THRESHOLDS, windowChars: 400, minWindowChars: 400 };
    expect(evaluateRepetitionWindow(DEGENERATE_SHORT_PHRASE, tiny)).toBeNull();
    expect(evaluateRepetitionWindow(DEGENERATE_SHORT_PHRASE)).not.toBeNull();
  });

  it("classifies an identical-run collapse as `phrase`", () => {
    expect(evaluateRepetitionWindow(DEGENERATE_SHORT_PHRASE)?.kind).toBe("phrase");
  });

  it("classifies a no-identical-sentence collapse as `low-information`", () => {
    const evidence = evaluateRepetitionWindow(DEGENERATE_LOW_INFORMATION);
    expect(evidence?.kind).toBe("low-information");
    expect(evidence?.longestRun).toBeLessThan(DEEPSEEK_REPETITION_THRESHOLDS.phraseRun);
  });
});
