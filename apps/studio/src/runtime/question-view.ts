/**
 * W783 — the host-side view of the pending-question table.
 *
 * This module is what the HTTP layer talks to: it publishes parked questions on
 * the session's SSE bus, resolves them when the human answers, and renders the
 * §7 recovery list. Keeping it out of `real-runtime-adapter.ts` is not cosmetic —
 * that file is the engine seam and has a hard size budget; more importantly, none
 * of this needs the engine, only the table plus a way to reach the bus.
 *
 * The one thing it deliberately does NOT do is write the `user_answer` log row:
 * the session's own service owns that, because it is the single place that
 * observes EVERY settlement (a real answer and a §6.3 timeout alike).
 */

import { questionFrame, type TurnFrame } from "@celestea/runtime";
import type { AskUserQuestionAnswerItem } from "@celestea/core";
import type { PendingQuestion, QuestionRegistry } from "../question-registry.js";
import type { PendingQuestionView, QuestionAnswerOutcome } from "../runtime-adapter.js";

/** Where a question frame goes and which turn number it belongs to. */
export interface QuestionPublisher {
  /** Emit one `question` SSE frame for `sessionId` (null = detached). */
  emit: (sessionId: string | null, turn: number, frame: TurnFrame) => void;
  /** The session-local turn number currently running, or 0 when idle. */
  turnOf: (sessionId: string | null) => number;
}

/** The pending-question table as the host sees it. */
export class QuestionView {
  constructor(
    private readonly registry: QuestionRegistry,
    private readonly publisher: QuestionPublisher,
  ) {}

  /** Publish one parked question (§9 item 9) — deadline and timeout included. */
  publish(sessionId: string | null, question: PendingQuestion): void {
    const frame = questionFrame({
      session: sessionId,
      id: question.requestId,
      questions: question.questions,
      expiresAt: question.expiresAt,
      timeoutMs: question.timeoutMs,
    });
    this.publisher.emit(sessionId, this.publisher.turnOf(sessionId), frame);
  }

  /**
   * Answer one pending question (`POST /api/questions/{id}/answer`). Resolving
   * the parked promise is what wakes the tool call — no message is injected
   * (§4.2), because a message would only be steering the parked turn cannot drain.
   *
   * A refusal is a first-class answer, never a silent success: `unknown` and
   * `mismatch` are caller errors, while `timed_out`/`settled` report the §6.2
   * race in whichever direction it actually resolved.
   */
  answer(requestId: string, answers: AskUserQuestionAnswerItem[], sessionId?: string): QuestionAnswerOutcome {
    const question = this.registry.get(requestId);
    if (question === undefined) return { ok: false, reason: "unknown" };
    // W9206-32: the guard is NOT optional. Request ids are sequential (`q-<n>`),
    // so an omitted `session` used to skip the check entirely and let a stale
    // tab answer another session's question by guessing the id. An absent field
    // is now compared as `null`, which is exactly the detached generation's own
    // value — so a legitimate detached-scope answer still matches, and any other
    // session's question is refused.
    if ((sessionId ?? null) !== question.sessionId) return { ok: false, reason: "mismatch" };
    if (question.isSettled) {
      return { ok: false, reason: question.settlement === "timed_out" ? "timed_out" : "settled" };
    }
    const session = question.sessionId;
    question.answer(answers);
    this.registry.remove(requestId);
    return { ok: true, session };
  }

  /**
   * Every question still answerable, with the deadline judged AT READ TIME
   * (§6.1) so a reconnecting client rebuilds the card and its countdown without
   * trusting its own clock.
   */
  list(sessionId?: string | null, now = Date.now()): PendingQuestionView[] {
    return this.registry
      .all()
      .filter((question) => sessionId === undefined || question.sessionId === sessionId)
      .map((question) => ({
        id: question.requestId,
        session: question.sessionId,
        questions: question.questions,
        expires_at: question.expiresAt,
        timeout_ms: question.timeoutMs,
        remaining_ms: question.remainingMs(now),
        expired: question.isExpired(now),
      }));
  }
}