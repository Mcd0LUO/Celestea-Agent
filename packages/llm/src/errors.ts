/**
 * Structured LLM errors (P2a; status/retryability fields: iteration E §4 P0).
 *
 * Rust keeps a plain-string `LlmError` and encodes the semantics in the
 * canonical `llm timeout` message prefix: an error thrown out of `generate`
 * maps to `TurnOutcome::Error { kind: "generate" }`, a stalled stream maps to
 * `kind: "timeout"`, a mid-stream decode failure to `kind: "stream"`.
 * TypeScript can carry that distinction explicitly, so `LlmError` exposes
 * `kind` (the turn-outcome kind a caller should report) plus `isTimeout` and
 * the stage that tripped.
 *
 * Iteration E §4 P0 adds the machine-readable *failure cause* on top of the
 * message text: `httpStatus` (the status of the response that failed, `null`
 * when no response ever arrived) and `retryable` (whether another attempt or
 * another target could plausibly succeed). The defaults are the conservative
 * pair `(null, false)`: a failure carrying no evidence of being transient is
 * treated as a local/configuration problem, not as something to retry.
 * Nothing reads these fields yet — P0 is observability only, so every message,
 * throw site, SSE frame and statusline field is byte-for-byte unchanged.
 */

/** Canonical prefix of every timeout error (Rust TIMEOUT_ERROR_PREFIX). */
export const TIMEOUT_ERROR_PREFIX = "llm timeout";

export type LlmErrorKind = "generate" | "stream" | "timeout";

export type TimeoutStage = "connect" | "response" | "idle";

/**
 * Non-5xx statuses worth retrying (§4.2.2 `retryableStatuses`): request
 * timeout, too early, rate limited. Every 5xx counts as retryable as well.
 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 425, 429];

/** Extra structured fields of `LlmError` (all optional; defaults are safe). */
export interface LlmErrorOptions {
  isTimeout?: boolean;
  timeoutStage?: TimeoutStage | null;
  /** Status of the failed HTTP response; `null` = no response arrived. */
  httpStatus?: number | null;
  /** Whether retrying / switching target could plausibly help. */
  retryable?: boolean;
}

export class LlmError extends Error {
  /** Turn-outcome kind this failure maps to. */
  readonly kind: LlmErrorKind;
  /** True for any timeout; the message then carries the canonical prefix. */
  readonly isTimeout: boolean;
  /** Which guard tripped, when the failure was a timeout. */
  readonly timeoutStage: TimeoutStage | null;
  /** HTTP status of the failing response; `null` when none was received. */
  readonly httpStatus: number | null;
  /** True for transient causes (timeouts, transport, 408/425/429/5xx). */
  readonly retryable: boolean;

  constructor(message: string, kind: LlmErrorKind = "generate", options?: LlmErrorOptions) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.isTimeout = options?.isTimeout ?? false;
    this.timeoutStage = options?.timeoutStage ?? null;
    this.httpStatus = options?.httpStatus ?? null;
    this.retryable = options?.retryable ?? false;
  }
}

/** Would another attempt / another target help, judged from the status alone? */
export function isRetryableStatus(status: number | null): boolean {
  if (status === null) return false;
  return status >= 500 || RETRYABLE_HTTP_STATUSES.includes(status);
}

/**
 * Build the non-2xx error. The message format is unchanged from W511
 * (`stream request failed: <label>: <body snippet>`): the status becomes
 * machine-readable *in addition* to the text, never instead of it.
 */
export function statusError(status: number, label: string, bodySnippet = ""): LlmError {
  return new LlmError(`stream request failed: ${label}: ${bodySnippet}`, "generate", {
    httpStatus: status,
    retryable: isRetryableStatus(status),
  });
}

/** Transport failure before any response (DNS/TCP/TLS/socket): retryable. */
export function networkError(message: string): LlmError {
  return new LlmError(message, "generate", { retryable: true });
}

/**
 * The caller aborted the turn. Cooperative cancellation does not normally
 * reach this package (the runner resolves it as the `cancelled` outcome), so
 * this is the structured vocabulary for an aborted request rather than a new
 * throw site; an abort is never retryable (§4.2.2).
 */
export function cancelledError(message = "turn cancelled by the caller"): LlmError {
  return new LlmError(message, "generate", { retryable: false });
}

/** Build a structured timeout error with the canonical prefix. */
export function timeoutError(detail: string, stage: TimeoutStage | null = null): LlmError {
  return new LlmError(`${TIMEOUT_ERROR_PREFIX}: ${detail}`, "generate", {
    isTimeout: true,
    timeoutStage: stage,
    retryable: true,
  });
}

/** Response headers never arrived: `llm timeout: response headers ... (url)`. */
export function responseHeaderTimeoutError(ms: number, url: string): LlmError {
  return timeoutError(`response headers not received within ${ms}ms (${url})`, "response");
}

/** TCP/TLS connect never completed within the connect timeout. */
export function connectTimeoutError(ms: number, url: string): LlmError {
  return timeoutError(`connect timeout: no TCP connection within ${ms}ms (${url})`, "connect");
}

/** Message of a stalled-stream failure (yielded as failed{kind:"timeout"}). */
export function streamIdleTimeoutMessage(ms: number): string {
  return `stream idle timeout: no data chunk for ${ms}ms`;
}

/** True for timeout errors (these map to kind "generate" out of generate()). */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof LlmError && e.isTimeout;
}

/** The turn-outcome kind an error maps to (defaults to "generate"). */
export function errorKind(e: unknown): LlmErrorKind {
  return e instanceof LlmError ? e.kind : "generate";
}
