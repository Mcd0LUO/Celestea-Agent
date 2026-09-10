/**
 * The LLM seam — the vocabulary a provider adapter and its callers share (P2a).
 *
 * TODO(core-seam): W271 is landing the `Llm` seam in `packages/core`
 * (`packages/core/src/message.ts` already carries the ported Role/Content/
 * Message/Usage shapes; the `Llm` trait + stream events are still in flight).
 * Until `@celestea/core` exports them, this package owns this vocabulary and
 * keeps it shaped exactly like the Rust core types, so switching over is a pure
 * import change — see README.md §"core seam adapter" for the two-line diff.
 *
 * Field names and content tag names are contract, not style (`type` +
 * `content`, `tool_call_id`, flat usage counters): do not rename anything.
 */

import type { Usage } from "./usage.js";

/** `Role` — serde `rename_all = "lowercase"`. */
export const ROLES = ["system", "user", "assistant", "tool"] as const;
export type Role = (typeof ROLES)[number];

/** `ToolCall` — the provider call id plus the raw JSON arguments. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** `Content::Text` — `{"type":"text","content":"…"}`. */
export interface TextContent {
  type: "text";
  content: string;
}

/** `Content::ToolCall` — `{"type":"tool_call","content":{…}}`. */
export interface ToolCallContent {
  type: "tool_call";
  content: ToolCall;
}

export type Content = TextContent | ToolCallContent;

/** `Message` — one entry of the model-visible history. */
export interface Message {
  role: Role;
  content: Content[];
  /** Set only for `role = "tool"` (matches a result to its call). */
  tool_call_id: string | null;
}

/** `ToolSpec` — an OpenAI-compatible function tool declaration. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `ModelRequest` — one turn's request (field names are contract). */
export interface ModelRequest {
  /** Empty/absent falls back to the client's configured model. */
  model?: string;
  system?: string | null;
  messages: Message[];
  tools?: ToolSpec[];
  /** Explicit output cap; falls back to the client's max_output_tokens. */
  max_tokens?: number | null;
  temperature?: number | null;
}

/**
 * `StreamEvent` — the streamed turn. Reasoning/text deltas stream live, a usage
 * event rides just before the terminal event, and the turn ends with exactly
 * one of done / failed / interrupted — never a fake done (R1).
 *
 * Shape = `@celestea/core` `stream.ts` (discriminator `kind`, delta field
 * `text`, terminal failure field `kindOf`), so the swap is an import change.
 * `kindOf` is a free-form string in Rust (`StreamEvent::Failed { kind, .. }`)
 * whose live values are "stream" (mid-stream decode failure) and "timeout"
 * (SSE idle guard); core's TS union currently lists "generate" | "stream" only
 * and must be widened (see README §"core seam adapter").
 */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "done"; message: Message }
  | { kind: "failed"; kindOf: "generate" | "stream" | "timeout"; message: string }
  | { kind: "interrupted" };

/** The streamed turn: an async iterable of events. */
export type LlmStream = AsyncIterable<StreamEvent>;

/** The `Llm` seam every provider adapter implements. */
export interface Llm {
  /** Start a streaming turn; pre-stream failures reject with an LlmError. */
  generate(req: ModelRequest): Promise<LlmStream>;
}

// ---------------------------------------------------------------------------
// Message constructors (same names as the Rust `impl Message`)
// ---------------------------------------------------------------------------

export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", content: text }], tool_call_id: null };
}

export function systemMessage(text: string): Message {
  return { role: "system", content: [{ type: "text", content: text }], tool_call_id: null };
}

export function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", content: text }], tool_call_id: null };
}

export function assistantToolCall(call: ToolCall): Message {
  return { role: "assistant", content: [{ type: "tool_call", content: call }], tool_call_id: null };
}

export function toolResultMessage(id: string, text: string): Message {
  return { role: "tool", content: [{ type: "text", content: text }], tool_call_id: id };
}

/** Concatenate the text parts of a message's content (joined with "\n"). */
export function collectMessageText(content: readonly Content[]): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.content)
    .join("\n");
}

/** The tool calls of a message, in order. */
export function messageToolCalls(message: Message): ToolCall[] {
  return message.content
    .filter((part): part is ToolCallContent => part.type === "tool_call")
    .map((part) => part.content);
}

/** Drain a stream into an array (helper for tests/CLI; consumers stream live). */
export async function collectStream(stream: LlmStream): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
