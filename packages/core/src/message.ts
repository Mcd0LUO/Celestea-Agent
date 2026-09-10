/**
 * The model-visible message model — a 1:1 port of
 * `celestea_harness/crates/core/src/message.rs`.
 *
 * Rust shapes ported here:
 *   Role      enum { System, User, Assistant, Tool }      (serde lowercase)
 *   ToolCall  { id, name, args: Value }
 *   Content   enum { Text(String), ToolCall(ToolCall) }   (tag="type", content="content")
 *   Message   { role, content: Vec<Content>, tool_call_id: Option<String> }
 *   ToolSpec  { name, description, parameters }           (declared in ./types.ts)
 *   Usage     { prompt_tokens, completion_tokens, total_tokens,
 *               cache_read, reasoning_tokens }             (flat counters)
 *
 * Field names and content-tag names are contract, not style: the LLM request
 * builder and every engine projection depend on them. Do not rename anything.
 */

// ---------------------------------------------------------------------------
// Role / Content / ToolCall / Message
// ---------------------------------------------------------------------------

/** `Role` — serde `rename_all = "lowercase"`. */
export const ROLES = ["system", "user", "assistant", "tool"] as const;
export type Role = (typeof ROLES)[number];

/** `ToolCall` — the id is the provider call id, `args` is the raw JSON value. */
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

/**
 * `Message` — one entry of the model-visible history.
 *
 * `content` is always a list (an assistant turn that calls tools carries one
 * `tool_call` item per call in a SINGLE message); `tool_call_id` is set only for
 * `role = "tool"`, so a result can be matched to its call.
 */
export interface Message {
  role: Role;
  content: Content[];
  tool_call_id: string | null;
}

// Constructors mirror Rust's `impl Message` (same names, camelCase).

/** `Message::user`. */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::system`. */
export function systemMessage(text: string): Message {
  return { role: "system", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::assistant_text`. */
export function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::assistant_tool_call`. */
export function assistantToolCall(call: ToolCall): Message {
  return { role: "assistant", content: [{ type: "tool_call", content: call }], tool_call_id: null };
}

/** `Message::tool_result`. */
export function toolResultMessage(id: string, text: string): Message {
  return { role: "tool", content: [{ type: "text", content: text }], tool_call_id: id };
}

/** Rust-style namespace: `Message::user(…)` → `Message.user(…)`. */
export const Message = {
  user: userMessage,
  system: systemMessage,
  assistantText,
  assistantToolCall,
  toolResult: toolResultMessage,
} as const;

// ---------------------------------------------------------------------------
// Content helpers (the Rust code pattern-matches; these are the TS equivalents)
// ---------------------------------------------------------------------------

export function isTextContent(c: Content): c is TextContent {
  return c.type === "text";
}

export function isToolCallContent(c: Content): c is ToolCallContent {
  return c.type === "tool_call";
}

/** The tool calls carried by a message (empty for a text-only message). */
export function messageToolCalls(m: Message): ToolCall[] {
  const out: ToolCall[] = [];
  for (const c of m.content) if (isToolCallContent(c)) out.push(c.content);
  return out;
}

/** The ids of the tool calls carried by a message. */
export function toolCallIds(m: Message): string[] {
  return messageToolCalls(m).map((tc) => tc.id);
}

/** The text blocks of a message, in order. */
export function messageTexts(m: Message): string[] {
  const out: string[] = [];
  for (const c of m.content) if (isTextContent(c)) out.push(c.content);
  return out;
}

/** The single text block of a text-only message, or null. */
export function messageText(m: Message): string | null {
  const texts = messageTexts(m);
  return texts.length === 1 ? (texts[0] ?? null) : null;
}

/** True when the message carries at least one tool call. */
export function hasToolCalls(m: Message): boolean {
  return m.content.some(isToolCallContent);
}

// ---------------------------------------------------------------------------
// Usage (message.rs:81-108)
// ---------------------------------------------------------------------------

/** Provider-reported token usage for one LLM response (`Usage` in Rust). */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  reasoning_tokens: number;
}

/** All-zero usage (`Usage::default`). */
export function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, reasoning_tokens: 0 };
}

/** `Usage::is_empty` — true when every counter is zero. */
export function usageIsEmpty(u: Usage): boolean {
  return (
    u.prompt_tokens === 0 &&
    u.completion_tokens === 0 &&
    u.total_tokens === 0 &&
    u.cache_read === 0 &&
    u.reasoning_tokens === 0
  );
}

/** `Usage::add` — per-field sum, returning a new value. */
export function usageAdd(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cache_read: a.cache_read + b.cache_read,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
  };
}

/** Sum a list of usages (`Usage +=` in a loop). */
export function usageSum(usages: readonly Usage[]): Usage {
  let total = zeroUsage();
  for (const u of usages) total = usageAdd(total, u);
  return total;
}

/** Cache-hit ratio as reported by the statusline (`cache_read / prompt_tokens`). */
export function cacheHitRatio(u: Usage): number {
  return u.prompt_tokens === 0 ? 0 : u.cache_read / u.prompt_tokens;
}
