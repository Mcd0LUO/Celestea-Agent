/**
 * The LLM request/stream seam payloads — ports of
 * `crates/core/src/message.rs:65-153` (ModelRequest / StreamEvent / LlmError).
 *
 * `StreamEvent` is what a provider adapter yields: incremental deltas for the
 * UI, then exactly one authoritative terminal event. Terminal variants never
 * follow each other (`Done` after `Failed`/`Interrupted` is a contract
 * violation), because the engine's five TurnOutcome states are derived from
 * which terminal event arrived.
 */

import type { Message, Usage } from "./message.js";
import type { ToolSpec } from "./types.js";

/** `ModelRequest` — everything the model adapter needs for one call. */
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

/** `LlmError(String)` — the provider-facing failure message. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** `LlmStream` — `Pin<Box<dyn Stream<Item = StreamEvent> + Send>>`. */
export type LlmStream = AsyncIterable<StreamEvent>;

/** True for the two terminal variants (no further event may follow). */
export function isTerminalStreamEvent(ev: StreamEvent): boolean {
  return ev.kind === "done" || ev.kind === "failed" || ev.kind === "interrupted";
}
