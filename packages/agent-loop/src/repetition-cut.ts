/**
 * W1510 — what happens to the text of a convicted attempt, ported from the host
 * plugin `dsh-guard-repeat-output`.
 *
 * The detector says WHEN a stream collapsed. The driver decides WHICH arm runs
 * (see `repetition-recovery.ts`). This module owns the third question — what
 * happens to the characters — and it is separate because that question needs
 * both the stream outcome and the reasoning buffer, and because the loop is at
 * its size ceiling.
 *
 * ## The two arms
 *
 *   DISCARD  — the attempt produced nothing usable, so nothing is written. The
 *              reasoning burst is dropped WITHOUT a row, which is the only way a
 *              1.4 MB degenerate `thinking_delta` can be prevented.
 *   TRUNCATE — the attempt began healthily and then collapsed. The prefix before
 *              the onset is KEPT (it is real work) and only the degeneration is
 *              dropped, so the turn ends with something useful instead of
 *              nothing.
 *
 * ## Why the onset is searched, not assumed
 *
 * The detector can only convict once enough repetition accumulated, so the
 * conviction point LAGS the true onset — measured on the ported corpus, by
 * 1700-3600 characters. Cutting at the conviction point would release exactly
 * that much degenerate text into the log. `degenerationOnset` walks back to
 * where the repetition actually began, which is what makes the cut precise.
 */

import type { SessionLog } from "@celestea/core";
import { degenerationOnset, DEEPSEEK_REPETITION_THRESHOLDS, type RepetitionThresholds } from "./repetition.js";
import type { StreamOutcome } from "./step.js";
import type { ThinkingBuffer } from "./thinking.js";

/** What the release did, for the conviction log line. */
export interface ReleaseResult {
  /** Characters dropped as degeneration (0 on the discard arm). */
  prunedChars: number;
  /** Offset of the degeneration inside the text it was found in, or null. */
  onset: number | null;
}

/** Nothing was pruned: the healthy path, or the discard arm. */
const NOTHING_PRUNED: ReleaseResult = { prunedChars: 0, onset: null };

/**
 * The text a conviction threw away, for the sidecar copy.
 *
 * On the DISCARD arm that is the whole attempt (the copy is then the only record
 * of it); on the TRUNCATE arm it is the degeneration after the onset. The copy is
 * never read back into a request, so it cannot pollute the context.
 */
export function discardedText(stream: StreamOutcome): string {
  if (stream.repetition === null) return "";
  const source = stream.repetition.channel === "thinking" ? stream.reasoningText : stream.streamedText;
  const cut = stream.repetitionPlan?.action === "retry" ? 0 : (stream.onset ?? 0);
  return source.slice(cut);
}

/**
 * Release the text of one finished attempt according to its verdict.
 *
 * Called exactly once per attempt, from the loop, right where the stream-end
 * flush used to be — so a healthy attempt behaves byte-for-byte as before.
 */
export function releaseAfterStream(
  stream: StreamOutcome,
  thinking: ThinkingBuffer,
  session: SessionLog,
  thresholds: RepetitionThresholds = DEEPSEEK_REPETITION_THRESHOLDS,
): ReleaseResult {
  const evidence = stream.repetition;
  if (evidence === null) {
    thinking.flush();
    return NOTHING_PRUNED;
  }
  const plan = stream.repetitionPlan;
  if (plan !== null && plan.action === "retry") {
    // DISCARD: the whole attempt is thrown away, reasoning included.
    thinking.discard();
    return NOTHING_PRUNED;
  }
  return truncate(stream, thinking, session, thresholds);
}

/**
 * The TRUNCATE arm: keep everything before the onset, drop the rest.
 *
 * The channel decides WHICH text is cut. A reasoning collapse cuts the held
 * reasoning (persisted as one `thinking_delta` row); a reply collapse cuts the
 * streamed answer (persisted as one `assistant_message` row). Either way the
 * text after the onset never reaches the log.
 */
function truncate(
  stream: StreamOutcome,
  thinking: ThinkingBuffer,
  session: SessionLog,
  thresholds: RepetitionThresholds,
): ReleaseResult {
  if (stream.repetition?.channel === "thinking") {
    const held = thinking.heldText();
    const onset = degenerationOnset(held, thresholds);
    thinking.releaseUpTo(onset);
    stream.onset = onset;
    return { prunedChars: held.length - onset, onset };
  }
  const text = stream.streamedText;
  const onset = degenerationOnset(text, thresholds);
  const kept = text.slice(0, onset);
  if (kept !== "") session.append({ type: "assistant_message", text: kept });
  thinking.flush();
  stream.onset = onset;
  return { prunedChars: text.length - onset, onset };
}
