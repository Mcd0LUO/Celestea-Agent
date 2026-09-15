/**
 * The host's user-question service (W783 §4.1, §5, §6).
 *
 * One instance per composed session generation, all sharing the process-wide
 * [QuestionRegistry]: the service validates the request, parks a
 * [PendingQuestion], publishes the `question` SSE frame and then awaits the
 * ASYNC answerer waterfall. The parked promise is what the tool call is waiting
 * on, so an answer resolves it directly (§4.2) instead of being injected as a
 * message — the injection path is exactly the deadlock §2.2 documents.
 *
 * The three increments over the official implementation:
 *   - **maximum wait** (§6): an absolute `expires_at` judged at read time plus a
 *     `setTimeout` that actively settles the parked promise. Neither half alone
 *     is enough: the deadline survives a restart and answers "how long is left",
 *     while the timer is what stops a tool from hanging forever.
 *   - **timeout decides nothing** (§6.3): `{answers: [], timed_out: true}`. No
 *     default option is selected and the turn is not ended — the tool
 *     description tells the model to carry on with its own judgement.
 *   - **sub-agent guard** (§5.3): a worker-driven turn throws `DELEGATED_CALLER`
 *     instead of parking forever with no human on the other end.
 */

import {
  askTimeoutMs,
  currentAskUserCaller,
  USER_QUESTION_REQUEST_EVENT,
  UserQuestionError,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
  type AskUserQuestionOutcome,
  type AskUserQuestionRequest,
  type EventBus,
} from "@celestea/core";
import { PendingQuestion, type QuestionRegistry } from "./question-registry.js";

/** What the service needs from the host (all injected — no Context lookups). */
export interface UserQuestionServiceOptions {
  registry: QuestionRegistry;
  /** The session's event bus (`runWaterfallAsync` dispatches to answerers). */
  bus: EventBus;
  /** The session asking; `null` = the detached generation. */
  sessionId: string | null;
  /** Is this session's runtime instance still live? (§5.3 `CALLER_NOT_LIVE`) */
  isLive?: () => boolean;
  /** Publish one request to the UI (the `question` SSE frame, §9 item 9). */
  publish?: (question: PendingQuestion) => void;
  /**
   * Record the request in the session log (§7 `user_question`). Absent = no
   * persistence (the request then simply cannot be replayed after a restart).
   */
  record?: (question: PendingQuestion) => void;
  /**
   * Record how it ENDED (§7 `user_answer`). Called for BOTH paths — a real
   * answer and a timeout — right here, because this is the single place that
   * observes every settlement, whatever woke the question up.
   */
  recordAnswer?: (requestId: string, answers: AskUserQuestionAnswerItem[], timedOut: boolean) => void;
  /** Clock override (tests pin the deadline arithmetic). */
  now?: () => number;
}

/** The service the `ask_user_question` tool consumes. */
export interface HostUserQuestionService {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionOutcome>;
  /** The unanswered questions of THIS session (§7 recovery). */
  pending(): PendingQuestion[];
  /** One pending question by id, or undefined. */
  find(requestId: string): PendingQuestion | undefined;
}

/** The rejection an empty question list produces (§5.3 `EMPTY_QUESTIONS`). */
function emptyQuestions(): UserQuestionError {
  return new UserQuestionError("ask_user_question requires at least one question", "EMPTY_QUESTIONS");
}

/** The rejection a non-root (owned) caller produces (§5.3 `DELEGATED_CALLER`). */
function delegatedCaller(owner: string | null): UserQuestionError {
  const who = owner === null ? "another live agent" : `agent '${owner}'`;
  return new UserQuestionError(
    `human interaction is unavailable while the calling agent is owned by ${who}; `
      + "include the unresolved question or decision in the child agent's final result",
    "DELEGATED_CALLER",
  );
}

/** The rejection a dead asking generation produces (§5.3 `CALLER_NOT_LIVE`). */
function callerNotLive(): UserQuestionError {
  return new UserQuestionError("human interaction requires the exact live calling generation", "CALLER_NOT_LIVE");
}

/** The rejection an unanswered waterfall produces (§5.3 `NO_PROVIDER`). */
function noAnswerer(): UserQuestionError {
  return new UserQuestionError("no user-questions answerer accepted the request", "NO_PROVIDER");
}

/**
 * `intent` asserts two things the types cannot (§3.3): the named `approve` label
 * is one of THIS question's options, and a plan-review carries the plan it
 * reviews. Either gap would show the user a choice the asker never offered — or
 * an approval of something invisible — so it is caught here, at the asker.
 */
function validateIntent(question: AskUserQuestionItem): void {
  const intent = question.intent;
  if (intent === undefined) return;
  if (!(question.options ?? []).some((option) => option.label === intent.approve)) {
    throw new UserQuestionError(
      `question ${question.id} declares intent ${intent.kind} whose approve label ${JSON.stringify(intent.approve)} names none of its options`,
      "BAD_INTENT",
    );
  }
  if (question.detail === undefined) {
    throw new UserQuestionError(`question ${question.id} declares intent ${intent.kind} without the detail it reviews`, "BAD_INTENT");
  }
}

/** Run every request-shape check that must fail BEFORE a question is parked. */
function validateRequest(request: AskUserQuestionRequest): void {
  if (request.questions.length === 0) throw emptyQuestions();
  for (const question of request.questions) validateIntent(question);
}

/** The service body: validate, park, dispatch, settle (§5.1/§5.2/§6). */
class HostUserQuestions implements HostUserQuestionService {
  private readonly opts: UserQuestionServiceOptions;
  private readonly now: () => number;

  constructor(opts: UserQuestionServiceOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  pending(): PendingQuestion[] {
    return this.opts.registry.ofSession(this.opts.sessionId);
  }

  find(requestId: string): PendingQuestion | undefined {
    return this.opts.registry.get(requestId);
  }

  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionOutcome> {
    if (request.signal?.aborted === true) throw new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED");
    validateRequest(request);
    this.assertCaller();
    const timeoutMs = askTimeoutMs(request.timeoutMs);
    const question = this.park(request, timeoutMs);
    try {
      const outcome = await this.dispatch(question);
      // §7: the log records how it ended BEFORE the tool resumes, so a replay
      // can tell a real answer from the §6.3 expiry without any timer.
      this.opts.recordAnswer?.(question.requestId, outcome.answers, outcome.timed_out);
      return outcome;
    } finally {
      // Every exit path unregisters: a settled question is never listed again.
      this.opts.registry.remove(question.requestId);
    }
  }

  /** §5.3: only an unowned root turn has a human to answer it. */
  private assertCaller(): void {
    const caller = currentAskUserCaller();
    if (caller.kind === "delegated") throw delegatedCaller(caller.owner);
    if (this.opts.isLive !== undefined && !this.opts.isLive()) throw callerNotLive();
  }

  /** Create the pending entry, arm both timeout tracks and announce it. */
  private park(request: AskUserQuestionRequest, timeoutMs: number): PendingQuestion {
    const question = new PendingQuestion({
      requestId: this.opts.registry.nextRequestId(),
      sessionId: this.opts.sessionId,
      questions: request.questions,
      expiresAt: this.now() + timeoutMs,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    this.opts.registry.add(question);
    // The ACTIVE half of the double track (§6.1) — without it a tool whose
    // answer never arrives would hang for the life of the process.
    question.armTimer(this.now);
    this.opts.publish?.(question);
    this.opts.record?.(question);
    return question;
  }

  /**
   * Hand the parked question to the answerer waterfall.
   *
   * The BOTTOM of the chain awaits the pending question, because in this host
   * the human is out of process: the browser answers over
   * `POST /api/questions/{id}/answer` and that resolves this very promise. A
   * composed layer (a plan-review presenter, a test harness) may still CLAIM the
   * request by returning an outcome of its own without ever calling `next()`.
   *
   * Either way the value that comes back is the human's answer, which is what
   * lets a question be answered while the turn slot is occupied (§4.2).
   */
  private async dispatch(question: PendingQuestion): Promise<AskUserQuestionOutcome> {
    const event: AskUserQuestionRequest = {
      questions: [...question.questions],
      timeoutMs: Math.max(0, question.expiresAt - this.now()),
    };
    try {
      return await this.opts.bus.runWaterfallAsync<AskUserQuestionRequest, AskUserQuestionOutcome>(
        USER_QUESTION_REQUEST_EVENT,
        event,
        () => question.result,
      );
    } catch (error) {
      // A layer that delegated the SERVICE's own question left nobody to answer
      // it: report the seam as unclaimed rather than leaking the sentinel.
      if (question.isDelegation(error)) throw noAnswerer();
      throw error;
    }
  }
}

/** Build the service of ONE composed session generation. */
export function createUserQuestionService(opts: UserQuestionServiceOptions): HostUserQuestionService {
  return new HostUserQuestions(opts);
}
