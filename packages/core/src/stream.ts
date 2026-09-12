/**
 * The LLM request/stream seam payloads — ports of
 * `crates/core/src/message.rs:65-153` (ModelRequest / StreamEvent / LlmError).
 *
 * `StreamEvent` is what a provider adapter yields: incremental deltas for the
 * UI, then exactly one authoritative terminal event. Terminal variants never
 * follow each other (`Done` after `Failed`/`Interrupted` is a contract
 * violation), because the engine's five TurnOutcome states are derived from
 * which terminal event arrived.
 *
 * A1 (W746): this module is the SINGLE source of the LLM vocabulary. Provider
 * packages (`@celestea/llm`) re-export these symbols instead of redeclaring
 * them, so `instanceof LlmError` and every structural type agree across
 * packages. `LlmError` here carries the structured classification TS needs
 * (Rust keeps a plain `String`) — see the class doc.
 */

import type { Message, Usage } from "./message.js";
import type { ToolSpec } from "./types.js";

/**
 * `ModelRequest` — everything the model adapter needs for one call.
 *
 * A1 (W746): there is exactly ONE `ModelRequest` in the repo — `@celestea/llm`
 * re-exports this one instead of declaring a structurally-similar copy. The
 * shape is unchanged (the engine and the host both fill every field), and the
 * provider's wire mapper reads it with the same "absent == empty" fallbacks it
 * always had (`model` empty -> the configured model).
 */
export interface ModelRequest {
  model: string;
  system: string | null;
  messages: Message[];
  tools: ToolSpec[];
  max_tokens: number | null;
  temperature: number | null;
}

export type StreamEvent =
  /** A final-answer text delta. */
  | { kind: "text"; text: string }
  /** A chain-of-thought / reasoning delta (never enters the model history). */
  | { kind: "thinking"; text: string }
  /** Provider-reported usage for this response, just before the terminal event. */
  | { kind: "usage"; usage: Usage }
  /** The single authoritative final message. */
  | { kind: "done"; message: Message }
  /** The stream/generation broke mid-flight; terminal (no Done follows). */
  | { kind: "failed"; kindOf: "generate" | "stream"; message: string }
  /** Torn stream without a terminal frame; terminal (no Done follows). */
  | { kind: "interrupted" };

export const STREAM_EVENT_KINDS = ["text", "thinking", "usage", "done", "failed", "interrupted"] as const;
export type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

/**
 * The turn-outcome kind a provider failure maps to.
 *
 * "generate" = the pre-stream `generate()` call failed; "stream" = the stream
 * broke mid-flight; "timeout" = a guard tripped (connect / response-header /
 * SSE idle). Rust carries the classification in the `llm timeout:` message
 * prefix; TS carries it as a field AS WELL (never instead of the text).
 */
export type LlmErrorKind = "generate" | "stream" | "timeout";

/** Which guard tripped when a failure was a timeout. */
export type TimeoutStage = "connect" | "response" | "idle";

/** Extra structured fields of `LlmError` (all optional; defaults are safe). */
export interface LlmErrorOptions {
  isTimeout?: boolean;
  timeoutStage?: TimeoutStage | null;
  /** Status of the failed HTTP response; `null` = no response arrived. */
  httpStatus?: number | null;
  /** Whether retrying / switching target could plausibly help. */
  retryable?: boolean;
}

/**
 * `LlmError` — the provider-facing failure (`LlmError(String)` in Rust).
 *
 * Rust encodes the semantics in the canonical `llm timeout: …` message prefix;
 * TS adds the machine-readable fields on top of the unchanged text:
 * `kind` (the turn-outcome kind a caller should report), `isTimeout` +
 * `timeoutStage`, `httpStatus` and `retryable` (the conservative default pair
 * is `(null, false)`: a failure with no evidence of being transient is a
 * local/configuration problem, not something to retry).
 */
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

/** `LlmStream` — `Pin<Box<dyn Stream<Item = StreamEvent> + Send>>`. */
export type LlmStream = AsyncIterable<StreamEvent>;

/** True for the two terminal variants (no further event may follow). */
export function isTerminalStreamEvent(ev: StreamEvent): boolean {
  return ev.kind === "done" || ev.kind === "failed" || ev.kind === "interrupted";
}
