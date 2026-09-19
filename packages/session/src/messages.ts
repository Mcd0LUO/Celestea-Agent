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

import { deriveMessagesFrom, toolSurfaceValue } from "@celestea/core";
import type { Message, SessionEvent, SessionEventOrigin, StudioMessage } from "@celestea/core";

/** W888: the human-readable label each non-user origin shows in the block. */
const ORIGIN_LABEL: Record<Exclude<SessionEventOrigin, "user">, string> = {
  skill: "技能目录",
  memory: "记忆 · 每轮注入",
  receipt: "回执",
  steering: "插话",
  compact: "压缩摘要",
};

/** The label of a non-user origin ('user' never reaches here). */
export function originLabel(origin: SessionEventOrigin): string {
  return origin === "user" ? "用户" : ORIGIN_LABEL[origin];
}

/** Studio projection of a single event; null for structural markers. */
export function sessionEventToMessage(ev: SessionEvent): StudioMessage | null {
  switch (ev.type) {
    case "turn_start":
    case "turn_end":
      return null;
    case "user_message": {
      // W888: a non-user ORIGIN projects to an inbox row (the UI's existing
      // renderInboxMessage branch). Absent/'user' keeps the exact pre-W888 bytes.
      const origin = ev.origin;
      if (origin !== undefined && origin !== "user") {
        const inbox: StudioMessage = { role: "inbox", kind: origin, content: ev.text, source: originLabel(origin) };
        if (ev.attachments !== undefined && ev.attachments.length > 0) inbox.attachments = ev.attachments;
        return inbox;
      }
      // W804 §4.2D: the Studio projection carries the attachment references (the
      // bytes stay on disk); no attachments => the pre-W804 object byte for byte.
      const out: StudioMessage = { role: "user", content: ev.text };
      if (ev.attachments !== undefined && ev.attachments.length > 0) out.attachments = ev.attachments;
      return out;
    }
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
      // W855 (B6): the log stores the ORIGINAL value; the transcript shows the
      // bounded/annotated FACE (the original can be arbitrarily large) plus the
      // descriptor so a card can badge "N bytes omitted -> locator".
      const out: StudioMessage = {
        role: "tool",
        kind: "result",
        tool_call_id: ev.id,
        tool_value: toolSurfaceValue(ev.value, ev.surface),
        tool_error: ev.error,
      };
      if (ev.parent_id !== undefined) out.tool_parent_id = ev.parent_id;
      if (ev.surface !== undefined) out.tool_surface = ev.surface;
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
