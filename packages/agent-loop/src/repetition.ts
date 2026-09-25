/**
 * W1510 — online detection of DEGENERATE REPETITION in a streaming reply.
 *
 * The failure mode is real and was observed in production: a DeepSeek-family
 * model generating a long answer collapses into emitting the same sentence
 * hundreds of times ("OK. Let me write. Let me go." xN). The agent loop had no
 * detector at all, so the turn burned tokens until the model stopped on its own
 * or a human hit cancel.
 *
 * This module is PURE and ONLINE: a caller feeds text deltas one at a time and
 * gets back either null (nothing to report) or the evidence of a repetition
 * collapse. It never touches the log, the clock, the network or the Context —
 * loop.ts owns the wiring, this file owns the judgement.
 *
 * ## Provenance: this is a PORT, not a reinvention
 *
 * The detector is a port of the host-side plugin dsh-guard-repeat-output
 * (index.js, the "Pure detector" section), which has been running against real
 * traffic. Two of its properties are load-bearing and were carried over
 * VERBATIM rather than re-derived:
 *
 *   1. **The evaluation grid is absolute, not per-delta.** A caller feeds deltas
 *      of arbitrary size; they are sliced so evaluations land on evalEveryChars,
 *      2*evalEveryChars, ... An accumulate-and-reset counter (the obvious
 *      implementation) discards the overshoot, so the evaluation points drift
 *      with the provider SSE framing — and because the judgement is made over a
 *      fixed-size window, the same text can then convict or not convict purely
 *      by accident of chunking. Measured: chunk 3 and chunk 7 missed a real
 *      collapse entirely while chunk 40 convicted it.
 *   2. **The window is bounded on RAW text, and segmentation runs on the raw
 *      window.** Normalizing whitespace first would turn a newline into a space
 *      and silently make the newline in SEGMENT_BREAK dead — a reply repeating
 *      one unpunctuated line would collapse into a single enormous segment and
 *      never reach minSegments. Only the comparison keys are normalized.
 *
 * ## Scope: DeepSeek only, explicitly
 *
 * createRepetitionGuard returns null for every model whose id does not contain
 * "deepseek" (case-insensitive). A false positive on another provider is WORSE
 * than no detection at all: it would abort a healthy turn and spend a recovery
 * round trip instead of answering. The gate is therefore a positive,
 * explicit test on the model id and it fails CLOSED — an unknown or empty model
 * id is not detected.
 *
 * ## What is detected
 *
 * The guard is fed BOTH text and thinking deltas. Covering reasoning is not
 * optional: the production incident this module exists for degenerated ENTIRELY
 * inside reasoning — 142 reasoning parts, the worst repeating one phrase 27,269
 * times across 1,371,962 characters — while all 10 text parts of that same
 * session were healthy (top segment count 1). A text-only guard would not have
 * fired once.
 *
 * Two independent signals must BOTH hold inside one bounded rolling window:
 *
 *   1. **phrase repetition** — the window is built from segments (the raw text
 *      split on sentence terminators). Phrase repetition holds when the longest
 *      run of identical segments reaches phraseRun, OR when one segment accounts
 *      for phraseTopCount occurrences.
 *   2. **low information** — the duplicate share of the window reaches
 *      lowInfoDupShare AND the ratio of distinct character k-grams falls to
 *      maxUniqueGramRatio or below, i.e. saying the same thing in slightly
 *      different words also counts.
 *
 * Requiring BOTH is what makes the detector safe. Either signal alone has a
 * large legitimate population: a report that repeats one command block twelve
 * times is phrase-repetitive, and 14 small functions that each return null score
 * a 0.107 k-gram ratio. Only the combination — very high duplication AND very
 * low novelty — separates a collapse from ordinary repetitive-but-informative
 * output.
 *
 * ## Calibration (why these numbers)
 *
 * Measured over 205 real long assistant rows (>=1200 chars) plus 1708 real
 * legitimate reasoning parts harvested from 60 unrelated sessions, plus
 * hand-built hard negatives:
 *
 *   | signal                        | worst legitimate | smallest degenerate |
 *   |-------------------------------|------------------|---------------------|
 *   | duplicate share (segments)    | 0.075            | 0.876               |
 *   | distinct 5-gram ratio         | 0.572            | 0.126               |
 *   | longest identical-segment run | 2                | 2                   |
 *   | top-segment occurrences       | 4                | 45                  |
 *
 * The thresholds sit in the wide gap between those columns — roughly an order of
 * magnitude of margin on the duplication axis and on novelty — rather than a
 * hair. Note the third row: the longest-run column does NOT separate the sets on
 * its own (the same-thing-different-words collapse has no identical run at all),
 * which is exactly why the phrase leg also accepts a dominant top segment and
 * why the low-information leg exists.
 *
 * The reasoning corpus is the load-bearing negative: reasoning text is naturally
 * MORE repetitive than prose (it restates its own premises while thinking), so
 * thresholds that were safe only on text would be unsafe in practice. All 1708
 * legitimate reasoning parts stay clean at these values.
 *
 * maxUniqueGramRatio is deliberately far from the boundary — measured separation
 * is 0.126 vs 0.572, so any value in 0.2-0.5 behaves identically; it is pinned at
 * 0.30 to keep the gate meaningful rather than tuned to noise. The window (2400
 * chars) holds ~80 short segments — the shape of the real incident — while
 * staying short enough that legitimate prose cannot fill it.
 *
 * ### Known boundary (deliberate, documented)
 *
 * A block of >=24 byte-identical long lines with no surrounding prose — e.g. a
 * test body that is 40 identical expect(result.ok).toBe(true); lines — is
 * convicted. Content-wise it is indistinguishable from a collapse: it carries no
 * new information per line. That is accepted because (a) real assistant answers
 * wrap such blocks in prose, and one prose sentence per block keeps the window
 * clean, and (b) the consequence of a false positive is bounded and recoverable
 * (the turn ends interrupted with a wrap-up round trip instead of an answer).
 * The detector is not claimed to be perfect; it is claimed to be safe on real
 * text.
 *
 * ## Cost
 *
 * O(windowChars) time and memory per evaluation, and an evaluation runs only
 * every evalEveryChars characters — so a 100 KB answer costs ~500 evaluations
 * over a constant-size buffer, never a full-text rescan. Nothing is retained
 * beyond the window.
 */

/** Tunables of the online detector; every default is calibrated (see the header). */
export interface RepetitionThresholds {
  /** Rolling window length in RAW characters (bounds time AND memory). */
  windowChars: number;
  /** Below this window size nothing is judged: too little evidence to convict. */
  minWindowChars: number;
  /** Minimum number of usable segments in the window before the phrase rule runs. */
  minSegments: number;
  /** Segments shorter than this are noise and are dropped before counting. */
  minSegmentChars: number;
  /** A run of this many identical segments proves phrase repetition on its own. */
  phraseRun: number;
  /** Occurrences of one segment that prove phrase repetition on its own. */
  phraseTopCount: number;
  /** Duplicate share required for the low-information verdict. */
  lowInfoDupShare: number;
  /** Distinct k-gram ratio at or below which the window carries no new content. */
  maxUniqueGramRatio: number;
  /** k of the character k-gram used for the uniqueness ratio. */
  gramK: number;
  /** Characters between two evaluations, measured on an ABSOLUTE grid. */
  evalEveryChars: number;
  /**
   * Consecutive non-repeated segments tolerated inside a degenerate run before
   * the onset walk declares the repetition over. Guards the boundary against a
   * stray unique segment, while still stopping before healthy prose.
   */
  onsetGapSegments: number;
}

/** The calibrated defaults (used for every DeepSeek model; overridable in tests). */
export const DEEPSEEK_REPETITION_THRESHOLDS: RepetitionThresholds = {
  windowChars: 2400,
  minWindowChars: 1200,
  minSegments: 24,
  minSegmentChars: 12,
  phraseRun: 8,
  phraseTopCount: 10,
  lowInfoDupShare: 0.85,
  maxUniqueGramRatio: 0.3,
  gramK: 5,
  evalEveryChars: 200,
  onsetGapSegments: 2,
};

/**
 * Which model-output channel a conviction came from. The two channels are judged
 * in SEPARATE windows: reasoning is naturally more repetitive than prose, and
 * mixing them would let a legitimate answer dilute a collapsing reasoning burst
 * (or vice versa). It also tells the reader of the log which channel actually
 * collapsed.
 */
export type RepetitionChannel = "text" | "thinking";

/** What the detector saw when it convicted a window (also the abort evidence). */
export interface RepetitionEvidence {
  /** The signal that dominated: an identical run, or pure low information. */
  kind: "phrase" | "low-information";
  /** The output channel whose window collapsed. */
  channel: RepetitionChannel;
  /** Raw characters examined. */
  windowChars: number;
  /** Usable segments in the window. */
  segments: number;
  /** The most frequent segment, truncated for the log line. */
  topPhrase: string;
  /** How often it occurred. */
  topPhraseCount: number;
  /** Longest run of identical consecutive segments. */
  longestRun: number;
  /** Share of segments that are duplicates of an earlier one (0..1). */
  duplicateShare: number;
  /** Distinct character k-grams over all k-grams (0..1). */
  uniqueGramRatio: number;
}

/** Segment terminators: sentence punctuation of both scripts, plus newlines. */
const SEGMENT_BREAK = /[.!?\n;。！？；]+/;

/** Everything that is not a letter or digit (CJK included); for the k-gram ratio. */
const NON_WORD = /[^0-9a-z\u4e00-\u9fff]+/g;

/** Lowercase and collapse whitespace so formatting cannot hide a repetition. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/**
 * The trailing windowChars of the RAW text — the whole bounded state.
 *
 * Bounding happens on raw text on purpose: segmentation runs on the raw window,
 * so newlines must still be present when it does (see the module header).
 */
function rawWindowOf(text: string, thresholds: RepetitionThresholds): string {
  return text.length <= thresholds.windowChars ? text : text.slice(text.length - thresholds.windowChars);
}

/**
 * Split a RAW window into usable segments, dropping sub-threshold noise.
 *
 * Each segment is normalized AFTER splitting (not before), so segments that
 * differ only in case or internal spacing still compare equal.
 */
function segmentsOf(rawWindow: string, thresholds: RepetitionThresholds): string[] {
  return rawWindow
    .split(SEGMENT_BREAK)
    .map((part) => normalize(part).trim())
    .filter((part) => part.length >= thresholds.minSegmentChars);
}

/** Longest run of consecutive identical segments. */
function longestRun(segments: readonly string[]): number {
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const segment of segments) {
    run = segment === previous ? run + 1 : 1;
    previous = segment;
    if (run > best) best = run;
  }
  return best;
}

interface SegmentStats {
  segments: number;
  topPhrase: string;
  topPhraseCount: number;
  longestRun: number;
  duplicateShare: number;
}

/** The segment-level statistics the phrase leg needs. */
function segmentStats(segments: readonly string[]): SegmentStats {
  const counts = new Map<string, number>();
  for (const segment of segments) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  let topPhrase = "";
  let topPhraseCount = 0;
  for (const [segment, count] of counts) {
    if (count > topPhraseCount) {
      topPhrase = segment;
      topPhraseCount = count;
    }
  }
  return {
    segments: segments.length,
    topPhrase,
    topPhraseCount,
    longestRun: longestRun(segments),
    duplicateShare: 1 - counts.size / segments.length,
  };
}

/**
 * Distinct character k-grams over all k-grams of the compacted window (1 = all
 * new). Normalizes first: the window is raw text and NON_WORD only keeps
 * lowercase letters, so an uppercase character would otherwise be DELETED rather
 * than folded — shrinking the compacted text and inflating novelty.
 */
function uniqueGramRatio(window: string, thresholds: RepetitionThresholds): number {
  const compact = normalize(window).replace(NON_WORD, "");
  const { gramK } = thresholds;
  if (compact.length < gramK) return 1;
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i + gramK <= compact.length; i += 1) {
    seen.add(compact.slice(i, i + gramK));
    total += 1;
  }
  return total === 0 ? 1 : seen.size / total;
}

/** The phrase leg: an identical run, or one segment dominating the window. */
function phraseRepeated(stats: SegmentStats, thresholds: RepetitionThresholds): boolean {
  return stats.longestRun >= thresholds.phraseRun || stats.topPhraseCount >= thresholds.phraseTopCount;
}

/**
 * Judge ONE window. Pure: same text in, same verdict out, no state.
 * Returns null when the window is healthy or too small to judge.
 */
export function evaluateRepetitionWindow(
  text: string,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
  channel: RepetitionChannel = "text",
): RepetitionEvidence | null {
  const window = rawWindowOf(text, thresholds);
  if (window.length < thresholds.minWindowChars) return null;
  const segments = segmentsOf(window, thresholds);
  if (segments.length < thresholds.minSegments) return null;
  const stats = segmentStats(segments);
  const unique = uniqueGramRatio(window, thresholds);
  const phrase = phraseRepeated(stats, thresholds);
  const lowInformation = stats.duplicateShare >= thresholds.lowInfoDupShare && unique <= thresholds.maxUniqueGramRatio;
  if (!phrase || !lowInformation) return null;
  return {
    kind: stats.longestRun >= thresholds.phraseRun ? "phrase" : "low-information",
    channel,
    windowChars: window.length,
    segments: stats.segments,
    topPhrase: stats.topPhrase.slice(0, 120),
    topPhraseCount: stats.topPhraseCount,
    longestRun: stats.longestRun,
    duplicateShare: stats.duplicateShare,
    uniqueGramRatio: unique,
  };
}

/**
 * Where does the trailing degenerate run begin inside text?
 *
 * The detector convicts only once enough repetition has accumulated, so the
 * conviction point always LAGS the true onset — measured on the ported corpus,
 * the lag is typically 1700-3600 characters. This finds the boundary instead:
 * walk back from the end while the running vocabulary of the suffix keeps
 * repeating, and return the offset where it breaks.
 *
 * Pure and bounded: called at most once per conviction, over whatever the caller
 * held back, never on the per-delta path.
 *
 * Two conditions stop the walk, and BOTH are needed. The duplicate-share test
 * alone overshoots badly: while the repeated phrase dominates the tail, the
 * ratio stays above threshold for roughly 1/threshold - 1 further segments, so a
 * healthy prefix gets walked into and dropped. The consecutive-unique bound pins
 * the boundary where repetition actually starts, tolerating a stray unique
 * segment inside an otherwise degenerate run.
 *
 * @returns offset of the first character of the degenerate run; text.length when
 *   no degenerate run is found (nothing to prune).
 */
export function degenerationOnset(
  text: string,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): number {
  const segments: Array<{ start: number; text: string }> = [];
  // A fresh regex per call: a shared /g/ regex would carry `lastIndex` across
  // calls, which is exactly the kind of hidden state that breaks under reuse.
  const scan = /[^.!?\n;。！？；]+/g;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(text)) !== null) {
    const normalized = normalize(match[0]).trim();
    if (normalized.length < thresholds.minSegmentChars) continue;
    segments.push({ start: match.index, text: normalized });
  }
  if (segments.length === 0) return text.length;

  // Walk back from the end, tracking the vocabulary of the CURRENT run only.
  //
  // A global frequency count is the wrong instrument here: in a block that is
  // mostly degenerate, a phrase the healthy prefix used once also appears
  // thousands of times later, so the prefix's own segment scores as a repeat and
  // the walk runs straight through the healthy text. Judging each segment
  // against what the run itself has already said pins the boundary where
  // repetition actually starts.
  const vocabulary = new Set<string>();
  const tolerance = thresholds.onsetGapSegments;
  let uniqueRun = 0;
  let onset = text.length;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment === undefined) break;
    if (vocabulary.has(segment.text)) {
      uniqueRun = 0;
      onset = segment.start;
      continue;
    }
    uniqueRun += 1;
    // Healthy prose resumes: the repetition run starts after this point.
    if (uniqueRun > tolerance) break;
    vocabulary.add(segment.text);
  }
  return onset;
}

/**
 * Pure fold over a whole delta sequence: the test-friendly face of the guard.
 * Feeds every delta, evaluates on the absolute grid, and returns the FIRST
 * conviction (or null). A real caller uses [RepetitionGuard] so it never has to
 * keep the text.
 */
export function detectRepetition(
  deltas: readonly string[],
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): RepetitionEvidence | null {
  const guard = new RepetitionGuard(thresholds);
  for (const delta of deltas) {
    const evidence = guard.push(delta);
    if (evidence !== null) return evidence;
  }
  return null;
}

/** Per-channel online state: one bounded buffer and one absolute grid position. */
interface ChannelState {
  buffer: string;
  /** Characters consumed since the last grid line (always < evalEveryChars). */
  sinceEval: number;
  /** Absolute characters consumed in this channel. */
  consumed: number;
  /** Absolute grid position of the evaluation that convicted, or null. */
  convictionAt: number | null;
}

function newChannel(): ChannelState {
  return { buffer: "", sinceEval: 0, consumed: 0, convictionAt: null };
}

/**
 * The stateful online detector: push one delta at a time.
 *
 * text and thinking deltas are kept in SEPARATE windows (see
 * [RepetitionChannel]) and judged independently. Each window retains only the
 * trailing windowChars of raw text and is judged once per evalEveryChars
 * characters, so cost and memory stay bounded by the window regardless of answer
 * length — and a long healthy answer can never dilute a collapsing reasoning
 * burst.
 */
export class RepetitionGuard {
  private readonly channels: Record<RepetitionChannel, ChannelState> = {
    text: newChannel(),
    thinking: newChannel(),
  };
  private convicted: RepetitionEvidence | null = null;

  constructor(private readonly thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS) {}

  /**
   * Feed one streamed delta; returns the evidence the FIRST time it convicts.
   *
   * The delta is consumed in slices that land evaluations on an ABSOLUTE
   * character grid rather than on whatever boundary the caller happens to use.
   * Accumulating a counter and resetting it to zero discards the overshoot, so
   * the evaluation points drift with chunk size — and because the judgement is
   * made over a fixed-size window, the same text can then convict or not convict
   * purely by accident of chunking. Chunk size is decided by the provider SSE
   * framing, which this module does not control, so the grid must be
   * chunk-independent.
   */
  push(delta: string, channel: RepetitionChannel = "text"): RepetitionEvidence | null {
    if (this.convicted !== null) return null;
    const state = this.channels[channel];
    const every = this.thresholds.evalEveryChars;
    let offset = 0;
    while (offset < delta.length) {
      // Stop exactly on the next grid line so the remainder carries over.
      const take = Math.min(every - state.sinceEval, delta.length - offset);
      state.buffer += delta.slice(offset, offset + take);
      if (state.buffer.length > this.thresholds.windowChars) {
        state.buffer = state.buffer.slice(state.buffer.length - this.thresholds.windowChars);
      }
      state.sinceEval += take;
      offset += take;
      state.consumed += take;
      if (state.sinceEval >= every) {
        state.sinceEval = 0;
        const evidence = evaluateRepetitionWindow(state.buffer, this.thresholds, channel);
        if (evidence !== null) {
          this.convicted = evidence;
          state.convictionAt = state.consumed;
          return evidence;
        }
      }
    }
    return null;
  }

  /** The conviction, once one happened (null while the stream looks healthy). */
  get evidence(): RepetitionEvidence | null {
    return this.convicted;
  }

  /** Raw characters currently retained in one channel's window. */
  retainedChars(channel: RepetitionChannel = "text"): number {
    return this.channels[channel].buffer.length;
  }

  /**
   * Absolute character position of the evaluation that convicted, or null.
   *
   * This is the GRID point where the judgement was made — as opposed to where the
   * caller's chunk happened to end — so it must be identical for every chunking
   * of the same text. That property is what makes detection reproducible against
   * a provider's arbitrary SSE framing.
   */
  convictionAt(channel: RepetitionChannel = "text"): number | null {
    return this.channels[channel].convictionAt;
  }

  /**
   * The window itself, for a caller that has to find the ONSET inside it.
   *
   * Handing out the buffer (rather than a copy of the whole attempt) keeps the
   * onset search bounded by `windowChars`: the conviction point lags the true
   * onset by less than one window in practice, and the search is O(window).
   */
  windowText(channel: RepetitionChannel = "text"): string {
    return this.channels[channel].buffer;
  }
}

/**
 * Is this model id a DeepSeek-family model? The ONLY gate that enables
 * detection, and it is deliberately literal: a case-insensitive substring test
 * on the id, so deepseek-chat, deepseek-reasoner, DeepSeek-V3 and a
 * vendor-prefixed acme/deepseek-r1 all match, and nothing else does.
 */
export function isDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().includes("deepseek");
}

/**
 * Build the guard for one model, or null when the model is out of scope.
 * null is the fail-closed answer: no guard means the loop runs exactly as it did
 * before this module existed.
 */
export function createRepetitionGuard(
  model: string,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): RepetitionGuard | null {
  return isDeepSeekModel(model) ? new RepetitionGuard(thresholds) : null;
}
