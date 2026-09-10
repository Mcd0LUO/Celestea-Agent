/**
 * Structured LLM errors (P2a).
 *
 * Rust keeps a plain-string `LlmError` and encodes the semantics in the
 * canonical `llm timeout` message prefix: an error thrown out of `generate`
 * maps to `TurnOutcome::Error { kind: "generate" }`, a stalled stream maps to
 * `kind: "timeout"`, a mid-stream decode failure to `kind: "stream"`.
 * TypeScript can carry that distinction explicitly, so `LlmError` exposes
 * `kind` (the turn-outcome kind a caller should report) plus `isTimeout` and
 * the stage that tripped.
 */

/** Canonical prefix of every timeout error (Rust TIMEOUT_ERROR_PREFIX). */
export const TIMEOUT_ERROR_PREFIX = "llm timeout";

export type LlmErrorKind = "generate" | "stream" | "timeout";

export type TimeoutStage = "connect" | "response" | "idle";

export class LlmError extends Error {
  /** Turn-outcome kind this failure maps to. */
  readonly kind: LlmErrorKind;
  /** True for any timeout; the message then carries the canonical prefix. */
  readonly isTimeout: boolean;
  /** Which guard tripped, when the failure was a timeout. */
  readonly timeoutStage: TimeoutStage | null;

  constructor(
    message: string,
    kind: LlmErrorKind = "generate",
    options?: { isTimeout?: boolean; timeoutStage?: TimeoutStage | null },
  ) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.isTimeout = options?.isTimeout ?? false;
    this.timeoutStage = options?.timeoutStage ?? null;
  }
}

/** Build a structured timeout error with the canonical prefix. */
export function timeoutError(detail: string, stage: TimeoutStage | null = null): LlmError {
  return new LlmError(`${TIMEOUT_ERROR_PREFIX}: ${detail}`, "generate", {
    isTimeout: true,
    timeoutStage: stage,
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
