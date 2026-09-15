/**
 * W783 §7 — the two session-log rows of the user-question feature.
 *
 * WHY THEY EXIST AT ALL: `tool_result` has no `decision` field, so a question's
 * state would otherwise live only in an SSE frame and vanish on reload. These
 * rows are the durable record: a reconnecting client rebuilds the card from
 * `user_question`, and a replay can tell "the user answered" from "the clock ran
 * out" by finding (or not finding) the matching `user_answer`.
 *
 * WHAT THEY ARE NOT: model-visible history. Both projections SKIP them, because
 * the model already receives the outcome as the ordinary `tool_result` of
 * `ask_user_question` — projecting them too would invent a second copy of the
 * same decision and break the tool_call/tool_result pairing.
 *
 * The row shape is additive (W783 §7.2): a reader that does not know these two
 * types treats them exactly like any other unknown row — a torn tail.
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem, SessionEvent } from "@celestea/core";
import type { PendingQuestion } from "./question-registry.js";

/** The `user_question` row of one parked request. */
export function questionAskedRow(question: PendingQuestion): SessionEvent {
  return {
    type: "user_question",
    id: question.requestId,
    questions: [...question.questions],
    // Both timings are written explicitly, so a replay can compute "expired"
    // from the row alone (read-time judgement, §6.1) with no timer involved.
    expires_at: question.expiresAt,
    timeout_ms: question.timeoutMs,
  };
}

/**
 * The `user_answer` row of one settled request.
 *
 * `timedOut` is written as `timed_out` and is what distinguishes the §6.3
 * expiry ("nobody was there") from a real answer that selected nothing.
 */
export function questionAnsweredRow(requestId: string, answers: readonly AskUserQuestionAnswerItem[], timedOut: boolean): SessionEvent {
  return { type: "user_answer", id: requestId, answers: [...answers], timed_out: timedOut };
}

/** The questions of a `user_question` row, as the seam's item shape. */
export function askedItemsOf(event: { questions?: unknown }): AskUserQuestionItem[] {
  const raw = event.questions;
  return Array.isArray(raw) ? (raw as AskUserQuestionItem[]) : [];
}
