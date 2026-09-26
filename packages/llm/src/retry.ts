/**
 * Same-target retry decorator (W9104) — a `Llm`, not a new seam.
 *
 * The fallback decorator (`fallback.ts`) HAND OVER to another target; this one
 * re-issues the SAME request against the SAME target. They are two different
 * questions and they compose in a fixed order:
 *
 *     createRetryLlm({ inner })            <- retries target A maxRetries times
 *       └─ createFallbackLlm({ clientFor }) <- then hands over to target B
 *
 * **Why retry-first** (the order is a product decision, not an accident): a
 * 503/timeout/idle-stall is usually a blip on an endpoint that is otherwise
 * serving this deployment well. Switching target costs a different MODEL
 * (quality changes under the user) plus a cold connection; retrying the same
 * target first keeps the user's configured model in force, and only an endpoint
 * that fails `maxRetries + 1` times in a row is treated as "this target is
 * down" and left behind. The fallback decorator's per-target failure counter
 * (`failureThreshold`) therefore keeps counting the retried attempt, which is
 * exactly what "consecutive failures on this target" should mean.
 *
 * What this decorator owns (each mechanically testable):
 *   1. the TRIGGER TABLE — reused verbatim from `fallback.ts`
 *      (`describeFailure` / `describeEvent` / `isProducedEvent`); no second
 *      classification vocabulary exists. A non-retryable status (400/401/403/
 *      404/422), a caller abort and a produced attempt are all terminal;
 *   2. the PRODUCED LOCK — once a text/thinking delta reached the consumer the
 *      attempt is NEVER re-issued (re-issuing would drop text the user already
 *      saw and double-bill the provider);
 *   3. BACKOFF — attempt k waits `backoffMs * 2^k`, capped at `maxDelayMs`; a
 *      `Retry-After` the failure carried wins, and (mirroring the fallback
 *      decorator's `respectRetryAfter` rule) a header beyond the cap is not
 *      waited out at all. The sleep is injectable, so tests never really wait;
 *   4. VISIBILITY — every retry is reported through `onRetry`, so "this was a
 *      retry" can never be silent.
 *
 * Honest boundary: the ledger books ONE step per `generate()` call, so an
 * un-armed (no fallback) retry sequence is one ledger row whose attempt count is
 * 1 while the audit/SSE channel shows every retry. Per-attempt ledger rows are
 * the fallback decorator's job (it owns `beginStep` per target attempt).
 */

import {
  DEFAULT_FALLBACK_POLICY,
  describeEvent,
  describeFailure,
  isProducedEvent,
  type FailureInfo,
  type StatusTable,
} from "./fallback.js";
import type { Llm, LlmStream, ModelRequestDraft, StreamEvent } from "./seam.js";

/**
 * Hard ceiling of EXTRA same-target attempts. The value is the extra retries,
 * never the total: `maxRetries: 3` = up to 4 attempts on one target.
 */
export const MAX_RETRIES = 3;

/** The retry policy: counts, backoff and the shared status trigger table. */
export interface RetryPolicy {
  /** EXTRA attempts on the same target (0 = never retry). Clamped to [0, MAX_RETRIES]. */
  maxRetries: number;
  /** Base backoff: attempt k waits `backoffMs * 2^k` ms. */
  backoffMs: number;
  /** Ceiling for one wait, and the `Retry-After` cutoff (fallback口径). */
  maxDelayMs: number;
  /** Honour the failure's `Retry-After`; false = pure backoff. */
  respectRetryAfter: boolean;
  /** Reused from the fallback trigger table (one home, two decorators). */
  notRetryableStatuses: number[];
  retryableStatuses: number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  backoffMs: 500,
  maxDelayMs: 60_000,
  respectRetryAfter: true,
  notRetryableStatuses: [...DEFAULT_FALLBACK_POLICY.notRetryableStatuses],
  retryableStatuses: [...DEFAULT_FALLBACK_POLICY.retryableStatuses],
};

/**
 * The one place "how many retries" is turned into a legal number. Non-numbers
 * (and NaN/Infinity) fall back to the default, everything else is truncated and
 * clamped into [0, MAX_RETRIES] — the ceiling is a product rule, so a caller
 * cannot raise it by passing a bigger number.
 */
export function clampRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RETRY_POLICY.maxRetries;
  return Math.min(MAX_RETRIES, Math.max(0, Math.trunc(value)));
}

/**
 * How long attempt `retryIndex` (0-based) waits before it is re-issued.
 * `Retry-After` wins when it fits inside `maxDelayMs`; a header beyond the cap
 * returns 0, mirroring the fallback decorator's "beyond the cap we move on"
 * rule (`fallback.ts:honourRetryAfter`).
 */
export function retryDelayMs(info: { retryAfterMs: number | null }, retryIndex: number, policy: RetryPolicy): number {
  const retryAfter = policy.respectRetryAfter ? info.retryAfterMs : null;
  if (retryAfter !== null) return retryAfter > policy.maxDelayMs ? 0 : retryAfter;
  return Math.min(policy.backoffMs * 2 ** Math.max(0, retryIndex), policy.maxDelayMs);
}

/** One retry, as reported to the host (audit line + SSE `status` frame). */
export interface RetryAttemptInfo {
  /** Index of the attempt ABOUT to run: 1 = the first retry. */
  attempt: number;
  /** Chain target name when the caller knows one (fallback armed); null otherwise. */
  target: string | null;
  /** Model this retry was issued against. */
  model: string | null;
  /** `http_503` / `timeout_idle` / `stream` / `network` / `generate`. */
  reason: string;
  httpStatus: number | null;
  retryAfterMs: number | null;
  /** The wait actually applied before the retry (0 = immediate). */
  delayMs: number;
  /** text/thinking deltas already delivered (always 0 on a retry). */
  produced: number;
  maxRetries: number;
  message: string;
}

export interface RetryLlmOptions {
  inner: Llm;
  policy?: Partial<RetryPolicy>;
  /** Target name reported on every retry (null = the host has no chain). */
  target?: string | null;
  /** Model reported on every retry (null = the inner seam knows it). */
  model?: string | null;
  /** Called once per retry, BEFORE the backoff sleep. */
  onRetry?: (info: RetryAttemptInfo) => void;
  /** Injectable backoff (tests never really wait). */
  sleep?: (ms: number) => Promise<void>;
}

/** The decorator + the two diagnostics the host/tests read. */
export interface RetryLlm extends Llm {
  /** Retries actually performed by THIS decorator (diagnostics/tests). */
  retries(): number;
  /** The resolved policy (clamped). */
  policy(): RetryPolicy;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The mutable state of ONE decorator instance (so the loop stays a function). */
interface RetryRuntime {
  opts: RetryLlmOptions;
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  retries: number;
}

export function createRetryLlm(opts: RetryLlmOptions): RetryLlm {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...(opts.policy ?? {}) };
  policy.maxRetries = clampRetries(policy.maxRetries);
  const rt: RetryRuntime = { opts, policy, sleep: opts.sleep ?? sleepMs, retries: 0 };
  return {
    // EAGER on the pre-stream phase on purpose: a request that never opened a
    // response must REJECT out of `generate()`, exactly like the undecorated
    // seam. Returning a lazy generator would turn a 503 into a "torn stream" for
    // every caller that awaits `generate()` inside its own try/catch.
    generate: async (req: ModelRequestDraft): Promise<LlmStream> => attemptLoop(rt, req, await openAttempt(rt, req, 0)),
    retries: () => rt.retries,
    policy: () => ({ ...rt.policy }),
  };
}

/** The verdict of one consumed attempt (the fallback decorator's shape). */
type AttemptOutcome =
  | { kind: "done" }
  | { kind: "failed"; info: FailureInfo; terminal: StreamEvent | null; error: unknown };

/** An OPENED attempt: the stream plus the retry index it was issued under. */
interface OpenAttempt {
  stream: LlmStream;
  retry: number;
}

/**
 * Open one attempt, retrying the PRE-STREAM phase until a response exists or the
 * failure is terminal. Split out so `generate()` can run it eagerly while the
 * mid-stream phase stays in the generator below — the two phases must not share
 * a `try` because only the first one may reject out of `generate()`.
 */
async function openAttempt(rt: RetryRuntime, req: ModelRequestDraft, startRetry: number): Promise<OpenAttempt> {
  for (let retry = startRetry; ; retry++) {
    try {
      return { stream: await rt.opts.inner.generate(req), retry };
    } catch (error) {
      const info = describeFailure(error, 0, rt.policy);
      if (!canRetry(rt, info, retry, error)) throw error;
      await backoff(rt, info, retry);
    }
  }
}

/**
 * Retry the SAME target while the failure is retryable and nothing was produced.
 * The pre-stream throw and the mid-stream terminal share one predicate
 * (`canRetry`), which is why the two branches below read the same.
 */
async function* attemptLoop(rt: RetryRuntime, req: ModelRequestDraft, first: OpenAttempt): LlmStream {
  let current = first;
  for (;;) {
    const outcome = yield* consume(current.stream, rt.policy);
    if (outcome.kind === "done") return;
    if (!canRetry(rt, outcome.info, current.retry, outcome.error)) {
      if (outcome.error !== null) throw outcome.error;
      if (outcome.terminal !== null) yield outcome.terminal;
      return;
    }
    await backoff(rt, outcome.info, current.retry);
    current = await openAttempt(rt, req, current.retry + 1);
  }
}

/**
 * A retry is legal only while the failure is retryable, nothing was produced,
 * the budget is left, and the caller did not ABORT.
 *
 * The abort guard is explicit even though `describeFailure` already answers
 * "not retryable" for an unstructured error: a cancellation that reaches this
 * seam shaped like a transient stream failure (a destroyed response read) must
 * still never be re-issued — the user asked for the turn to stop, and a retry
 * would keep a cancelled turn alive behind their back.
 */
function canRetry(rt: RetryRuntime, info: FailureInfo, retry: number, error: unknown): boolean {
  if (isAbort(error)) return false;
  return info.retryable && info.produced === 0 && retry < rt.policy.maxRetries;
}

/** A caller cancellation, recognised structurally (core's LlmError or a DOMError). */
export function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const rec = error as Record<string, unknown>;
  if (rec["name"] === "AbortError") return true;
  const signal = rec["signal"];
  return typeof signal === "object" && signal !== null && (signal as { aborted?: unknown }).aborted === true;
}

/** Report the retry, then wait (the order is the visibility contract). */
async function backoff(rt: RetryRuntime, info: FailureInfo, retry: number): Promise<void> {
  const delayMs = retryDelayMs(info, retry, rt.policy);
  rt.retries += 1;
  rt.opts.onRetry?.({
    attempt: retry + 1,
    target: rt.opts.target ?? null,
    model: rt.opts.model ?? null,
    reason: info.reason,
    httpStatus: info.httpStatus,
    retryAfterMs: info.retryAfterMs,
    delayMs,
    produced: info.produced,
    maxRetries: rt.policy.maxRetries,
    message: info.message,
  });
  if (delayMs > 0) await rt.sleep(delayMs);
}

/** Forward one attempt's events, counting what the consumer has already seen. */
async function* consume(stream: LlmStream, policy: StatusTable): AsyncGenerator<StreamEvent, AttemptOutcome, undefined> {
  let produced = 0;
  try {
    for await (const event of stream) {
      if (isProducedEvent(event)) produced += 1;
      if (event.kind === "done") {
        yield event;
        return { kind: "done" };
      }
      if (event.kind === "failed" || event.kind === "interrupted") {
        return { kind: "failed", info: describeEvent(event, produced), terminal: event, error: null };
      }
      yield event;
    }
  } catch (error) {
    return { kind: "failed", info: describeFailure(error, produced, policy), terminal: null, error };
  }
  // A provider stream that ended without a terminal event: the same torn-stream
  // verdict the fallback decorator reaches, and retryable while nothing was seen.
  return { kind: "failed", info: describeEvent({ kind: "interrupted" }, produced), terminal: { kind: "interrupted" }, error: null };
}
