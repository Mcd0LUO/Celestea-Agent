/**
 * Structured LLM errors (P2a; status/retryability fields: iteration E §4 P0).
 *
 * A1 (W746): the `LlmError` class and its `LlmErrorKind` / `TimeoutStage` /
 * `LlmErrorOptions` vocabulary live in `@celestea/core` (`core/src/stream.ts`)
 * and are re-exported here — this package no longer owns a second `LlmError`,
 * so `instanceof LlmError` and `isTimeoutError` agree across packages. What
 * stays here is provider-side and cannot move to core: the canonical timeout
 * prefix and the error builders.
 *
 * The semantics ride the canonical `llm timeout` message prefix: an error
 * thrown out of `generate` maps to `TurnOutcome::Error { kind: "generate" }`, a
 * stalled stream maps to `kind: "timeout"`, a mid-stream decode failure to
 * `kind: "stream"`. TypeScript can also carry that distinction explicitly, so
 * `LlmError` exposes `kind` (the turn-outcome kind a caller should report) plus
 * `isTimeout` and the stage that tripped.
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

import { LlmError, type LlmErrorKind, type LlmErrorOptions, type TimeoutStage } from "@celestea/core";

export { LlmError };
export type { LlmErrorKind, LlmErrorOptions, TimeoutStage };

/** Canonical prefix of every timeout error (`TIMEOUT_ERROR_PREFIX`). */
export const TIMEOUT_ERROR_PREFIX = "llm timeout";

/**
 * Non-5xx statuses worth retrying (§4.2.2 `retryableStatuses`): request
 * timeout, too early, rate limited. Every 5xx counts as retryable as well.
 */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 425, 429];

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

/**
 * W804 (section 7.6): the upstream report patterns that mean "this model cannot
 * take an image". ONLY known patterns are classified; anything else stays an
 * ordinary status error (we never guess).
 */
export const IMAGE_UNSUPPORTED_MARKERS: readonly string[] = [
  "multimodal input is not supported",
  "model only supports text input",
  "unsupported content type 'image_url'",
  "unsupported content type image_url",
];

/** True when an upstream error body carries a known image-unsupported marker. */
export function isImageUnsupportedBody(body: string): boolean {
  const text = body.toLowerCase();
  return IMAGE_UNSUPPORTED_MARKERS.some((marker) => text.includes(marker));
}

/**
 * A 4xx whose body proves the model rejected image input (section 7.6). It is an
 * LlmError (kind "generate", httpStatus set, NOT retryable to another target)
 * and carries `imageUnsupported = true` so the downgrade decorator recognises it.
 */
export class ImageUnsupportedError extends LlmError {
  readonly imageUnsupported = true;
  constructor(status: number, label: string, bodySnippet: string) {
    super(`stream request failed: ${label}: ${bodySnippet}`, "generate", { httpStatus: status, retryable: false });
    this.name = "ImageUnsupportedError";
  }
}

/** Recognise an [ImageUnsupportedError] across a structural (re-boxed) boundary. */
export function isImageUnsupportedError(e: unknown): e is ImageUnsupportedError {
  if (e instanceof ImageUnsupportedError) return true;
  return typeof e === "object" && e !== null && (e as Record<string, unknown>)["imageUnsupported"] === true;
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

/**
 * `Retry-After` of a failed response, kept OUT of `LlmError`.
 *
 * E §4.2.2 P1 honours the header, but `LlmError` lives in `@celestea/core` and
 * K7/§4.6 forbid widening it for a host-side policy detail. The header is
 * therefore attached on a side channel keyed by the error object: still
 * zero-copy, still invisible to every existing reader (`errors.test.ts` asserts
 * the core fields, which are unchanged), and it never leaks into a message.
 */
const RETRY_AFTER_MS = new WeakMap<object, number>();

/** Attach a parsed `Retry-After` (ms) to the error that carries it. */
export function setRetryAfterMs(error: unknown, ms: number | null): void {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return;
  if (typeof error === "object" && error !== null) RETRY_AFTER_MS.set(error, Math.floor(ms));
}

/** The parsed `Retry-After` of an error, or null when it carried none. */
export function retryAfterMsOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  return RETRY_AFTER_MS.get(error) ?? null;
}

/**
 * `Retry-After` -> milliseconds. Both forms of RFC 9110 are accepted: a
 * delta-seconds value and an HTTP-date. An unparsable header (or a date in the
 * past) is "no wait", never a thrown error.
 */
export function parseRetryAfterHeader(value: string | string[] | undefined, now = Date.now()): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** True for timeout errors (these map to kind "generate" out of generate()). */
export function isTimeoutError(e: unknown): boolean {
  return e instanceof LlmError && e.isTimeout;
}

/** The turn-outcome kind an error maps to (defaults to "generate"). */
export function errorKind(e: unknown): LlmErrorKind {
  return e instanceof LlmError ? e.kind : "generate";
}
