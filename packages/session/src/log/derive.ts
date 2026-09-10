/**
 * The engine's `derive_messages` projection — a 1:1 port of
 * `crates/session/src/log.rs:73-204`.
 *
 * Rules (all of them are contract, each has a Rust unit test):
 *   - `TurnStart` / `TurnEnd` are structural markers, never projected;
 *   - `ThinkingDelta` is replay-only decoration (W252), never projected;
 *   - `ToolCall` rows are ACCUMULATED, not projected: consecutive calls merge
 *     into ONE assistant message carrying one `tool_call` content per call
 *     (LLM protocols require all tool calls of a turn in a single message);
 *   - the accumulator is flushed before any other event, and after the last
 *     event;
 *   - rows with `parent_id` (W255 run_code sub-calls) stay in the log for
 *     audit/replay but never reach the model: both the call and its result are
 *     skipped — the outer run_code round trip is all the model sees;
 *   - `ToolResult` projects to a tool message whose text is `"Error: {err}"`
 *     when the error is a non-empty string, otherwise the serde_json text of
 *     the value (`"null"` when absent).
 *
 * `balance_tool_calls` (W267) then makes the projection protocol-valid: every
 * assistant tool_calls message must be followed by one tool message per call.
 */

import {
  assistantText,
  serdeJsonString,
  toolCallIds,
  toolResultMessage,
  userMessage,
  type Message,
  type SessionEvent,
  type ToolCall,
} from "@celestea/core";

/** W267 synthetic result text — byte-for-byte the engine's string (b046564). */
export const CANCELLED_TOOL_CALL_TEXT = "Error: tool call was cancelled before execution (no result recorded)";

/** The model-visible history of a session log (Rust `derive_messages_from`). */
export function deriveMessagesFrom(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  const pending: ToolCall[] = [];

  for (const event of events) {
    if (event.type === "tool_call") {
      // Sub-call rows (parent_id present) are audit-only.
      if (event.parent_id === undefined) {
        pending.push({ id: event.id, name: event.name, args: event.args });
      }
      continue;
    }
    flushToolCalls(messages, pending);
    const message = projectEvent(event);
    if (message !== null) messages.push(message);
  }

  // Trailing tool calls (no following event) still need flushing.
  flushToolCalls(messages, pending);
  balanceToolCalls(messages);
  return messages;
}

/**
 * Flush accumulated tool calls as ONE assistant message (`flush_tool_calls`).
 * It drains the accumulator, mirroring Rust's `std::mem::take`.
 */
export function flushToolCalls(messages: Message[], pending: ToolCall[]): void {
  if (pending.length === 0) return;
  const calls = pending.splice(0, pending.length);
  messages.push({
    role: "assistant",
    content: calls.map((call) => ({ type: "tool_call" as const, content: call })),
    tool_call_id: null,
  });
}

/**
 * Project one non-tool-call event (`project`). Returns null for the events the
 * model never sees.
 */
export function projectEvent(event: SessionEvent): Message | null {
  switch (event.type) {
    case "user_message":
      return userMessage(event.text);
    case "assistant_message":
      return assistantText(event.text);
    case "tool_result":
      if (event.parent_id !== undefined) return null; // W255 sub-call result
      return toolResultMessage(event.id, toolResultText(event.error, event.value));
    case "turn_start":
    case "turn_end":
    case "thinking_delta":
      return null;
    case "tool_call":
      // Rust: unreachable!("ToolCall must be accumulated by derive_messages…")
      throw new Error("ToolCall must be accumulated by derive_messages, not projected");
  }
}

/** The text of a projected ToolResult: error first, else the value as JSON. */
export function toolResultText(error: string | null | undefined, value: unknown): string {
  if (typeof error === "string" && error.length > 0) return `Error: ${error}`;
  return serdeJsonString(value === undefined ? null : value);
}

/**
 * W267 protocol balance: every assistant `tool_calls` message is followed by
 * one `tool` message per call id. A cancelled/interrupted turn can stop between
 * ToolCall and ToolResult, leaving a dangling call that makes the whole history
 * invalid for OpenAI-compatible upstreams ("insufficient tool messages
 * following tool_calls message"). A synthetic cancelled result is inserted for
 * each unanswered call; the log itself is untouched (audit keeps the truth).
 *
 * UPSTREAM PARITY NOTE: the cursor advance `i = j + inserted + 1` is ported
 * unchanged from `crates/session/src/log.rs:149`, including its quirk — when a
 * call message is fully answered, the message sitting right after its results
 * is skipped by the cursor, so an unbalanced trailing call message in exactly
 * that position is NOT balanced (see `log/derive.test.ts:mirrors the upstream
 * cursor quirk`). Parity with the engine is the contract here; the quirk is
 * reported upstream rather than diverged from silently.
 */
export function balanceToolCalls(messages: Message[]): void {
  let i = 0;
  while (i < messages.length) {
    const current = messages[i];
    if (current === undefined) break;
    const callIds = toolCallIds(current);
    if (callIds.length === 0) {
      i += 1;
      continue;
    }
    // Results must be the contiguous tool messages right after the call.
    const answered: string[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      const id = messages[j]?.tool_call_id;
      if (id !== null && id !== undefined) answered.push(id);
      j += 1;
    }
    let inserted = 0;
    for (const id of callIds) {
      if (answered.includes(id)) continue;
      messages.splice(j + inserted, 0, toolResultMessage(id, CANCELLED_TOOL_CALL_TEXT));
      inserted += 1;
    }
    i = j + inserted + 1;
  }
}
