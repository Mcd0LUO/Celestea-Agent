/**
 * The two projections of the session log.
 *
 * 1. Studio projection (GET /api/sessions/{id}/messages) — src/api.rs:94-135.
 *    Per-event, independent, NO pairing/dropping; thinking rows are included;
 *    orphan tool_result rows are emitted; tool rows carry tool_parent_id.
 * 2. Engine `derive_messages` — the model-visible history (see ./log/derive.ts):
 *    turn markers and thinking are skipped, run_code sub-call rows
 *    (parent_id present) are skipped, consecutive tool calls merge into ONE
 *    assistant message, and unanswered calls are balanced with a synthetic
 *    cancelled result.
 *
 * Keeping both explicit is the whole point: they differ, and the difference is
 * contract.
 */

import { deriveMessagesFrom } from "@celestea/core";
import type { Message, SessionEvent, StudioMessage } from "@celestea/core";

/** Studio projection of a single event; null for structural markers. */
export function sessionEventToMessage(ev: SessionEvent): StudioMessage | null {
  switch (ev.type) {
    case "turn_start":
    case "turn_end":
      return null;
    case "user_message":
      return { role: "user", content: ev.text };
    case "assistant_message":
      return { role: "assistant", content: ev.text };
    case "thinking_delta":
      return { role: "thinking", content: ev.text };
    case "tool_call": {
      const out: StudioMessage = {
        role: "tool",
        kind: "call",
        tool_call_id: ev.id,
        tool_name: ev.name,
        tool_args: ev.args,
      };
      if (ev.parent_id !== undefined) out.tool_parent_id = ev.parent_id;
      return out;
    }
    case "tool_result": {
      const out: StudioMessage = {
        role: "tool",
        kind: "result",
        tool_call_id: ev.id,
        tool_value: ev.value,
        tool_error: ev.error,
      };
      if (ev.parent_id !== undefined) out.tool_parent_id = ev.parent_id;
      return out;
    }
  }
}

/** The Studio message list for a whole log (golden-compared against Rust). */
export function projectMessages(events: readonly SessionEvent[]): StudioMessage[] {
  const out: StudioMessage[] = [];
  for (const ev of events) {
    const m = sessionEventToMessage(ev);
    if (m !== null) out.push(m);
  }
  return out;
}

/**
 * Engine model-visible projection (`derive_messages`). Returns the Rust
 * `Message` shape (`role` / `content[]` / `tool_call_id`), not the Studio shape.
 */
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  return deriveMessagesFrom(events);
}
