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
    // W783 §7: the two host-side question rows. The Studio projection is the
    // per-event transcript surface the UI replays, so a parked question and its
    // answer stay visible there (an unanswered row is how a restart looks).
    case "user_question": {
      const out: StudioMessage = {
        role: "question",
        kind: "question",
        question_id: ev.id,
        content: ev.questions,
      };
      if (ev.expires_at !== undefined) out.question_expires_at = ev.expires_at;
      return out;
    }
    case "user_answer": {
      const out: StudioMessage = {
        role: "question",
        kind: "answer",
        question_id: ev.id,
        content: ev.answers,
      };
      if (ev.timed_out !== undefined) out.question_timed_out = ev.timed_out;
      return out;
    }
  }
}

/** The Studio message list for a whole log (golden-compared against HTTP). */
export function projectMessages(events: readonly SessionEvent[]): StudioMessage[] {
  const out: StudioMessage[] = [];
  for (const ev of events) {
    const m = sessionEventToMessage(ev);
    if (m !== null) out.push(m);
  }
  return out;
}

/**
 * Engine model-visible projection (`derive_messages`). Returns the engine's
 * `Message` shape (`role` / `content[]` / `tool_call_id`), not the Studio shape.
 */
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  return deriveMessagesFrom(events);
}
