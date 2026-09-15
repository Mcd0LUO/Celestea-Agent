/**
 * The pending-question table (W783 §5.1) — one [PendingQuestion] per unanswered
 * request, plus the process-wide registry the HTTP layer answers into.
 *
 * Shape mirrors the official DSH `PendingQuestion` (same four members, same
 * delegation sentinel, same abort wiring), with the two behaviours this repo
 * adds:
 *
 *   1. **it can EXPEND** (§6). `expires_at` is an ABSOLUTE deadline judged at
 *      read time (the `grants.ts: isExpired` pattern), and `timeout()` is the
 *      active half that makes the parked `await` settle even if nobody ever
 *      reads the table. The timer is cleared on every settlement, so a live
 *      registry never holds a stray handle.
 *   2. **the §6.2 race is not a bug.** The user answering and the clock
 *      expiring are both legitimate; whoever arrives first wins and the loser
 *      is TOLD it lost (`answer()` returns false) instead of throwing. The
 *      strict double-settle guard stays internal, where a second settlement
 *      really is a defect.
 *
 * `result` is the promise the waterfall layer hands back, so an answer RESOLVES
 * the parked tool call directly — the answer never travels as a message (§4.2).
 */

import type { AskUserQuestionItem, AskUserQuestionOutcome } from "@celestea/core";
import { UserQuestionError } from "@celestea/core";

/** `Promise.withResolvers` without the ES2024 lib dependency. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: () => boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      done = true;
      res(value);
    };
    reject = (reason: unknown) => {
      done = true;
      rej(reason);
    };
  });
  return { promise, resolve, reject, settled: () => done };
}

/** How a pending question ended (what the SSE frame and the log row report). */
export type QuestionSettlement = "answered" | "timed_out" | "cancelled" | "aborted";

/** Everything one pending question needs to exist. */
export interface PendingQuestionInit {
  requestId: string;
  sessionId: string | null;
  questions: readonly AskUserQuestionItem[];
  /** Absolute deadline in ms (the authoritative half of the §6.1 double track). */
  expiresAt: number;
  /** The RESOLVED maximum wait (what the log row and the SSE frame report). */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The empty answer a timeout returns — the system decides NOTHING for the model. */
export const TIMED_OUT_OUTCOME: AskUserQuestionOutcome = { answers: [], timed_out: true };

/** One unanswered question, awaiting the human. */
export class PendingQuestion {
  readonly requestId: string;
  readonly sessionId: string | null;
  readonly questions: readonly AskUserQuestionItem[];
  readonly expiresAt: number;
  /** The resolved maximum wait in ms (§6.4). */
  readonly timeoutMs: number;
  /** The promise the answerer waterfall returns to the parked tool call. */
  readonly result: Promise<AskUserQuestionOutcome>;

  private readonly completion = deferred<AskUserQuestionOutcome>();
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: (() => void) | undefined;
  /** Rejection sentinel that asks the waterfall to try the layer behind us. */
  private readonly delegated = Symbol("pending question delegated");
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private outcome: QuestionSettlement | null = null;

  constructor(init: PendingQuestionInit) {
    this.requestId = init.requestId;
    this.sessionId = init.sessionId;
    this.questions = init.questions;
    this.expiresAt = init.expiresAt;
    this.timeoutMs = init.timeoutMs;
    this.result = this.completion.promise;
    this.signal = init.signal;
    if (init.signal === undefined) {
      this.onAbort = undefined;
      return;
    }
    this.onAbort = () => this.abort(abortedQuestion());
    init.signal.addEventListener("abort", this.onAbort, { once: true });
    // A signal that was ALREADY aborted never fires the event again.
    if (init.signal.aborted) this.onAbort();
  }

  /** Has this question already been settled (answered, expired, cancelled…)? */
  get isSettled(): boolean {
    return this.settled;
  }

  /** How it ended, or null while it is still answerable. */
  get settlement(): QuestionSettlement | null {
    return this.outcome;
  }

  /** Read-time expiry (§6.1, the authoritative half): `now >= expires_at`. */
  isExpired(now: number): boolean {
    return now >= this.expiresAt;
  }

  /** Milliseconds left, floored at 0 (what the UI counts down). */
  remainingMs(now: number): number {
    return Math.max(0, this.expiresAt - now);
  }

  /**
   * The human answered. Returns false when the question was already settled —
   * that is the §6.2 race, not a defect, so the caller reports it instead of
   * throwing. `timed_out` is always false here: a real answer arrived.
   */
  answer(answers: AskUserQuestionOutcome["answers"]): boolean {
    return this.settle("answered", () => this.completion.resolve({ answers, timed_out: false }));
  }

  /** The deadline passed: settle with the EMPTY answer set (§6.3). */
  timeout(): boolean {
    return this.settle("timed_out", () => this.completion.resolve(TIMED_OUT_OUTCOME));
  }

  /** The user dismissed the card (§5.1 `cancel`). */
  cancel(reason = "the user cancelled ask_user_question"): boolean {
    return this.settle("cancelled", () => this.completion.reject(new UserQuestionError(reason, "ASK_CANCELLED")));
  }

  /** Transport / scope / plugin lifetime ended (§5.1 `abort`). */
  abort(reason: unknown): boolean {
    return this.settle("aborted", () => this.completion.reject(reason));
  }

  /**
   * This layer will not answer: reject with the delegation sentinel so the
   * waterfall runs the next layer. Silent when already settled (DSH behaviour).
   */
  delegate(): boolean {
    if (this.settled) return false;
    return this.settle("aborted", () => this.completion.reject(this.delegated));
  }

  /** Did [delegate] produce this rejection reason? */
  isDelegation(reason: unknown): boolean {
    return reason === this.delegated;
  }

  /**
   * Arm the active half of the double track (§6.1). The timer only ever calls
   * [timeout], which is a no-op once the user answered first.
   */
  armTimer(now: () => number): void {
    if (this.settled || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timeout();
    }, Math.max(0, this.expiresAt - now()));
    // Never hold the process open for a question nobody is waiting on.
    this.timer.unref?.();
  }

  /** One settlement, ever: the strict guard that exposes a real double-settle. */
  private settle(kind: QuestionSettlement, commit: () => void): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.outcome = kind;
    this.disarm();
    commit();
    return true;
  }

  /** Drop the timer and the abort listener — no handle outlives the question. */
  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.signal !== undefined && this.onAbort !== undefined) {
      this.signal.removeEventListener("abort", this.onAbort);
    }
  }
}

/** The rejection an aborted wait produces (§5.3 `ASK_ABORTED`). */
export function abortedQuestion(cause?: unknown): UserQuestionError {
  return new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED", cause === undefined ? undefined : { cause });
}

/**
 * The process-wide pending table.
 *
 * It is ONE registry per host process, not one per session: the answer endpoint
 * addresses a request by id alone and must find it without being told which
 * session asked. Each generation's own service registers into this shared table,
 * which is also what lets `GET /api/sessions/{id}/questions` filter by session.
 */
export class QuestionRegistry {
  private readonly pending = new Map<string, PendingQuestion>();
  private counter = 0;

  /** Mint a request id (`q-<n>`); unique for the life of the process. */
  nextRequestId(): string {
    this.counter += 1;
    return `q-${this.counter}`;
  }

  /** Register a question; a duplicate id is a bug, so it fails loudly. */
  add(question: PendingQuestion): void {
    if (this.pending.has(question.requestId)) {
      throw new Error(`question '${question.requestId}' is already pending`);
    }
    this.pending.set(question.requestId, question);
  }

  /** Drop a settled question (idempotent). */
  remove(requestId: string): void {
    this.pending.delete(requestId);
  }

  get(requestId: string): PendingQuestion | undefined {
    return this.pending.get(requestId);
  }

  /** Every unanswered question, oldest first (registration order). */
  all(): PendingQuestion[] {
    return [...this.pending.values()];
  }

  /** The unanswered questions of ONE session (`null` = the detached generation). */
  ofSession(sessionId: string | null): PendingQuestion[] {
    return this.all().filter((question) => question.sessionId === sessionId);
  }

  /** How many questions are still parked (diagnostics / tests). */
  size(): number {
    return this.pending.size;
  }
}

/** A fresh table (one per host process). */
export function createQuestionRegistry(): QuestionRegistry {
  return new QuestionRegistry();
}
