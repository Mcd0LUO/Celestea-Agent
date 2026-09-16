/**
 * The user-question seam — L1 types only (design §4.1 A1).
 *
 * Three layers, exactly like the official DSH implementation:
 *   1. **here** — the service interface, the service token, the error taxonomy
 *      and the wire-shaped request/answer types. `core` stays L1: no
 *      implementation, no transport, no storage.
 *   2. the HOST (`apps/studio`) implements the service and owns the pending
 *      table;
 *   3. `packages/tools` consumes it through the `ask_user_question` tool, which
 *      receives the service by CONSTRUCTION (the `runShellTool({sandbox})`
 *      pattern) because `packages/tools` never sees a Context.
 *
 * Why the answer cannot travel as a message: while the tool is awaited the
 * session's turn slot is occupied, so `POST /api/turn` becomes steering, and
 * steering is only drained at step boundaries — a boundary the parked tool call
 * never reaches (§2.2). The answer therefore resolves the pending promise
 * through the waterfall's RETURN VALUE (§4.2), never through message injection.
 *
 * `AskUserQuestionOutcome.timed_out` is this repo's increment: DSH waits without
 * any TTL, while §6 gives the wait a maximum and returns an EMPTY answer set
 * rather than deciding for the model.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label. */
  label: string;
  /** Optional extra context rendered by capable UIs. */
  description?: string;
}

/**
 * A caller-declared presentation intent. It changes presentation only, never the
 * protocol: the answer encoding is identical with or without one, so a UI that
 * does not know the tag renders the generic option list (§3.3).
 */
export interface AskUserQuestionIntent {
  /** A plan submitted for review: `detail` carries the plan, `approve` the verdict. */
  kind: "plan-review";
  /**
   * The option label that approves the plan; every other option declines it.
   * Named rather than positional so no UI infers the verdict from option order.
   */
  approve: string;
}

/** One question in a user-questions request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided question id, echoed in the answer. */
  id: string;
  /** The question to display. */
  question: string;
  /** Optional supporting detail, kept OUT of option labels (§3.2 rule 3). */
  detail?: string;
  /** Optional short heading. */
  header?: string;
  /** Optional choices; absent = free-text only. */
  options?: AskUserQuestionOption[];
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean;
  /** Optional presentation intent. */
  intent?: AskUserQuestionIntent;
}

/** Answer to one question. `selected` holds LABELS, never indices (§3.2 rule 1). */
export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  /** Optional free-text answer, co-existing with `selected`. */
  custom?: string;
}

/** The human's answer, or the empty set a timeout returns (§6.3). */
export interface AskUserQuestionOutcome {
  answers: AskUserQuestionAnswerItem[];
  /** `true` = the wait expired; the system decided nothing on the model's behalf. */
  timed_out: boolean;
}

/**
 * One request to the answerer waterfall.
 *
 * There is no `sessionId` here on purpose: the service is composed PER SESSION
 * (the host builds one instance for each generation), so the asking session is
 * already the instance's own identity and can never be spoofed by the caller.
 */
export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[];
  /**
   * Optional maximum wait in ms; clamped by [askTimeoutMs] (absent/non-positive
   * = [DEFAULT_ASK_TIMEOUT_MS]). Never means "wait forever".
   */
  timeoutMs?: number;
  /** Lifetime of the wait: aborting it rejects with `ASK_ABORTED`. */
  signal?: AbortSignal;
}

/** The service seam the `ask_user_question` tool consumes. */
export interface UserQuestionService {
  /**
   * Ask the answerer waterfall and wait for the human's answer.
   *
   * @throws {UserQuestionError} `EMPTY_QUESTIONS` / `BAD_INTENT` on a malformed
   *   request, `DELEGATED_CALLER` when a sub-agent asks, `CALLER_NOT_LIVE` when
   *   the asking generation is gone, `ASK_ABORTED` when the signal aborted,
   *   `NO_PROVIDER` when no answerer claimed the request.
   */
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionOutcome>;
}

/** Well-known token for the user-question service (host-provided). */
export const USER_QUESTION_SERVICE = "celestea.core.UserQuestionService";

/**
 * The waterfall event a request travels on. Answerers receive
 * `(request, next)`: return an outcome to CLAIM the request, call `next()` to
 * delegate to the next layer (§5.2).
 */
export const USER_QUESTION_REQUEST_EVENT = "user-questions/request";

/** The stable error taxonomy of §5.3 (the DSH code set). */
export const USER_QUESTION_ERROR_CODES = [
  "ASK_ABORTED",
  "ASK_CANCELLED",
  "BAD_INTENT",
  "CALLER_NOT_LIVE",
  "DELEGATED_CALLER",
  "EMPTY_QUESTIONS",
  "NO_PROVIDER",
] as const;

export type UserQuestionErrorCode = (typeof USER_QUESTION_ERROR_CODES)[number];

/** A user-question failure carrying its stable code. */
export class UserQuestionError extends Error {
  readonly code: UserQuestionErrorCode;

  constructor(message: string, code: UserQuestionErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserQuestionError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Caller identity (§5.3) — the sub-agent guard
// ---------------------------------------------------------------------------

/**
 * Who is asking. An OWNED child agent has no human answerer and would block
 * forever, so it is refused instead of being allowed to wait (§5.3).
 *
 * This repo has no agent-object registry (DSH resolves `ctx.get("agents")`), so
 * ownership is expressed as the async scope the worker driver enters around
 * every turn it drives: a root turn runs outside it, a driven worker turn inside
 * it. That is the same boundary — runtime ownership, not durable session
 * lineage.
 */
export type AskUserCaller = { kind: "root" } | { kind: "delegated"; owner: string | null };

/** The implicit caller of any turn that did not enter [delegatedCallerScope]. */
export const ROOT_ASK_CALLER: AskUserCaller = { kind: "root" };

const callerScope = new AsyncLocalStorage<AskUserCaller>();

/** The caller of the turn currently running on this async context. */
export function currentAskUserCaller(): AskUserCaller {
  return callerScope.getStore() ?? ROOT_ASK_CALLER;
}

/** Run one driven (owned) agent turn: everything inside is a delegated caller. */
export function delegatedCallerScope<T>(owner: string | null, fn: () => Promise<T>): Promise<T> {
  return callerScope.run({ kind: "delegated", owner }, fn);
}

// ---------------------------------------------------------------------------
// The wait budget (§6.4)
// ---------------------------------------------------------------------------

/** Default maximum wait for an answer (ms). */
export const DEFAULT_ASK_TIMEOUT_MS = 300000;

/** Hard ceiling for the tool's `timeout_ms` override (ms). */
export const MAX_ASK_TIMEOUT_MS = 3600000;

/**
 * Clamp a requested wait into `[1, MAX_ASK_TIMEOUT_MS]`. An absent, non-finite or
 * non-positive request means the default — never "wait forever".
 *
 * W834 F06 (R3 batch A): the lower bound is applied AFTER the floor. Flooring
 * first let a request in (0, 1) — e.g. `timeout_ms: 0.5` — become 0, and
 * `setTimeout(0)` expired the question before a human could answer it.
 */
export function askTimeoutMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_ASK_TIMEOUT_MS;
  return Math.max(1, Math.min(Math.floor(requested), MAX_ASK_TIMEOUT_MS));
}
