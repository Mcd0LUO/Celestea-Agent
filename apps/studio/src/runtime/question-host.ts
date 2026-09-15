/**
 * W783 — the host's user-question capability in ONE object.
 *
 * Three things have to exist together and must never drift apart:
 *   - the process-wide [QuestionRegistry] (so `POST /api/questions/{id}/answer`
 *     can find a request from its id alone, whichever session asked);
 *   - the [QuestionView] that publishes a parked question on the session's SSE
 *     bus and renders the §7 recovery list;
 *   - the wiring the composer hands to each session generation.
 *
 * Bundling them keeps `real-runtime-adapter.ts` — the engine seam, which has a
 * hard size budget and should stay about the engine — down to a handle and three
 * one-line delegations. The bus and the turn numbering are reached through
 * callbacks, so the adapter stays the only thing that knows how to reach them.
 */

import type { AskUserQuestionAnswerItem } from "@celestea/core";
import { createQuestionRegistry, type PendingQuestion, type QuestionRegistry } from "../question-registry.js";
import type { PendingQuestionView, QuestionAnswerOutcome } from "../runtime-adapter.js";
import { QuestionView, type QuestionPublisher } from "./question-view.js";

/** The host's question capability: table + view, created once per process. */
export class QuestionHost {
  private readonly registry: QuestionRegistry = createQuestionRegistry();
  private readonly view: QuestionView;

  constructor(publisher: QuestionPublisher) {
    this.view = new QuestionView(this.registry, publisher);
  }

  /** The table (what the composer wires each session's service to). */
  table(): QuestionRegistry {
    return this.registry;
  }

  /** Publish one parked question (§9 item 9). */
  publish(sessionId: string | null, question: PendingQuestion): void {
    this.view.publish(sessionId, question);
  }

  /** Answer one pending question (`POST /api/questions/{id}/answer`). */
  answer(requestId: string, answers: AskUserQuestionAnswerItem[], sessionId?: string): QuestionAnswerOutcome {
    return this.view.answer(requestId, answers, sessionId);
  }

  /** Every question still answerable (`GET /api/questions`, §7 recovery). */
  list(sessionId?: string | null): PendingQuestionView[] {
    return this.view.list(sessionId);
  }
}
