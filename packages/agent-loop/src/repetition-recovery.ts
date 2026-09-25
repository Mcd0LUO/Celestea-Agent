/**
 * W1510 — degenerate-repetition recovery, ported from the host plugin
 * `dsh-guard-repeat-output`.
 *
 * The detector (`repetition.ts`) says WHEN a stream collapsed. This module owns
 * what happens NEXT, and it is deliberately separate: the loop is at its size
 * ceiling, and the recovery is a self-contained procedure with its own ordering
 * rules.
 *
 * ## The ported strategy, in one paragraph
 *
 * A collapsed attempt is DISCARDED, not trimmed: the stream is closed, the
 * attempt never becomes an assistant message, and the call is re-issued on the
 * SAME context — which is what makes it "as if the collapse never happened".
 * The retry is PERTURBED (the reasoning effort steps down one rung) because an
 * identical request tends to reproduce the identical collapse. When the retry
 * budget is spent, the guard stops discarding whole attempts and instead
 * TRUNCATES at the onset of the degeneration, keeping the healthy prefix and
 * asking the model to wrap up — the fallback shape, which ends the turn with a
 * partial but useful answer instead of another error.
 *
 * ## Why the retry ladder is `effort`, not `temperature`
 *
 * Verbatim from the ported plugin: reasoning effort is used instead of
 * temperature because the observed route sets NO temperature (adapter default,
 * unknown), so any absolute value could be LOWER than the default and deepen the
 * loop — repetition is typically a low-temperature failure. Lowering effort also
 * directly shortens the channel that collapses.
 *
 * ## Visibility: the sidecar copy and the JSONL log
 *
 * A conviction discards text, so the ONLY surviving record of what was thrown
 * away is the copy this module writes. That copy is what makes a false positive
 * diagnosable after the fact instead of arguable, and it is never read back into
 * a request, so it cannot pollute the context. Both the copy and the log line
 * are fire-and-forget: diagnostics must never become a control path.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepetitionChannel, RepetitionEvidence } from "./repetition.js";

/**
 * The perturbation ladder: the current reasoning effort steps down one rung
 * after a collapse. An effort outside the ladder (a user-defined tier) is left
 * ALONE rather than guessed at — the ported plugin refuses to invent a value the
 * model may reject.
 */
export const PERTURB_EFFORTS: readonly string[] = ["max", "high", "medium", "low"];

/**
 * The next rung down for a collapsed attempt, or `null` when the route must be
 * left as it is (unknown tier, already at the bottom, or nothing configured).
 */
export function perturbedEffort(current: string | null | undefined): string | null {
  if (typeof current !== "string") return null;
  const index = PERTURB_EFFORTS.indexOf(current);
  if (index === -1 || index === PERTURB_EFFORTS.length - 1) return null;
  return PERTURB_EFFORTS[index + 1] ?? null;
}

/** What the driver must do about one conviction. */
export interface RepetitionPlan {
  /** `retry` = discard the whole attempt and re-issue; `truncate` = keep the prefix. */
  action: "retry" | "truncate";
  /** Retry attempts spent INCLUDING this one. */
  retriesUsed: number;
}

/**
 * Decide between "discard and re-issue" and "truncate at the onset".
 *
 * Pure, so the budget rule is testable without a loop: the first `maxRetries`
 * convictions in a step discard the attempt; the next one truncates. The
 * distinction matters because a discarded attempt costs nothing but a request,
 * while a truncation costs the turn its completeness.
 */
export function planRepetition(retriesUsed: number, maxRetries: number): RepetitionPlan {
  const used = retriesUsed + 1;
  return { action: used <= maxRetries ? "retry" : "truncate", retriesUsed: used };
}

/** The channel as a human reads it, for the instructions and the log line. */
function channelLabel(channel: RepetitionChannel): string {
  return channel === "thinking" ? "reasoning channel" : "reply text";
}

/**
 * The instruction for the LAST allowed truncation in a turn.
 *
 * Deliberately not a "continue": a model that has already collapsed repeatedly
 * will collapse again if pointed back at the same line of work. This closes the
 * turn with something useful — the user gets the conclusion instead of a silent
 * stop — and names the repetition so the model stops restating it.
 */
export function wrapUpText(evidence: RepetitionEvidence, truncations: number): string {
  return `[repetition-guard] Output collapsed into degenerate repetition ${truncations} times in `
    + `this turn (the ${channelLabel(evidence.channel)} kept repeating "${evidence.topPhrase}"); the last occurrence was `
    + `truncated at the point it began. Do not resume the previous line of reasoning — it is what `
    + `keeps collapsing. Instead: state the conclusion or current state ONCE, concisely, in your `
    + `reply text, then end the turn. If work remains, name the single next action in one line `
    + `rather than re-deriving it.`;
}

/** Where the diagnostics of one conviction go; absent paths disable that half. */
export interface RepetitionDiagnostics {
  /** Directory receiving a copy of the discarded text; null = keep none. */
  copyDir?: string | null;
  /** JSONL file receiving one record per conviction; null = no log. */
  logPath?: string | null;
  /** Upper bound on the copied text (a pathological stream must not fill the disk). */
  copyMaxChars?: number;
  /**
   * Characters held back from the live stream so a truncation can land on the
   * true onset instead of at the (later) provable conviction point. `0` disables
   * holdback: the cut then lands at the conviction point, which is the honest
   * pre-holdback behaviour and loses up to one window of degenerate text.
   */
  holdbackChars?: number;
}

/** One conviction, as the log line records it (the shape the plugin emits). */
export interface RepetitionRecord {
  time: string;
  event: "repetition-detected";
  action: "discard-and-retry" | "budget-exhausted";
  sessionId: string | null;
  model: string | null;
  channel: RepetitionChannel;
  kind: RepetitionEvidence["kind"];
  topPhrase: string;
  topPhraseCount: number;
  longestRun: number;
  segments: number;
  duplicateShare: number;
  uniqueGramRatio: number;
  seenChars: number;
  prunedChars: number;
  convictionAt: number | null;
}

/** Round for the log line, the way the plugin does (4 decimals, never a float blob). */
function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** The log record for one conviction. PURE, so its shape is testable. */
export function repetitionRecord(opts: {
  evidence: RepetitionEvidence;
  action: RepetitionRecord["action"];
  sessionId?: string | null;
  model?: string | null;
  seenChars: number;
  prunedChars: number;
  convictionAt?: number | null;
  now?: Date;
}): RepetitionRecord {
  const { evidence } = opts;
  return {
    time: (opts.now ?? new Date()).toISOString(),
    event: "repetition-detected",
    action: opts.action,
    sessionId: opts.sessionId ?? null,
    model: opts.model ?? null,
    channel: evidence.channel,
    kind: evidence.kind,
    topPhrase: evidence.topPhrase,
    topPhraseCount: evidence.topPhraseCount,
    longestRun: evidence.longestRun,
    segments: evidence.segments,
    duplicateShare: round4(evidence.duplicateShare),
    uniqueGramRatio: round4(evidence.uniqueGramRatio),
    seenChars: opts.seenChars,
    prunedChars: opts.prunedChars,
    convictionAt: opts.convictionAt ?? null,
  };
}

/** A filesystem-safe copy name for one conviction (the plugin's naming scheme). */
export function copyName(sessionId: string | null, evidence: RepetitionEvidence, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const who = (sessionId ?? "session").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${who}__${stamp}__${evidence.channel}.txt`;
}

/**
 * Persist the diagnostics of one conviction. NEVER throws and is never awaited
 * on the hot path: a diagnostics failure must not change what the turn does, and
 * must not slow the stream it observes.
 */
export function recordRepetition(
  diagnostics: RepetitionDiagnostics,
  record: RepetitionRecord,
  discarded: string,
): void {
  const dir = diagnostics.copyDir ?? null;
  const logPath = diagnostics.logPath ?? null;
  const cap = diagnostics.copyMaxChars ?? 262_144;
  if (dir !== null && discarded !== "") {
    void writeCopy(dir, cap, copyName(record.sessionId, evidenceOf(record), new Date(record.time)), discarded);
  }
  if (logPath !== null) void appendRecord(logPath, record);
}

/** Rebuild the evidence the copy name needs (the record already carries it). */
function evidenceOf(record: RepetitionRecord): RepetitionEvidence {
  return {
    kind: record.kind,
    channel: record.channel,
    windowChars: 0,
    segments: record.segments,
    topPhrase: record.topPhrase,
    topPhraseCount: record.topPhraseCount,
    longestRun: record.longestRun,
    duplicateShare: record.duplicateShare,
    uniqueGramRatio: record.uniqueGramRatio,
  };
}

async function writeCopy(dir: string, cap: number, name: string, text: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), text.length > cap ? text.slice(0, cap) : text);
  } catch {
    /* diagnostics, never a control path */
  }
}

async function appendRecord(logPath: string, record: RepetitionRecord): Promise<void> {
  try {
    await appendFile(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    /* diagnostics, never a control path */
  }
}
