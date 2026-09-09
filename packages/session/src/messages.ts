/**
 * The two projections of the session log.
 *
 * 1. Studio projection (GET /api/sessions/{id}/messages) — src/api.rs:94-135.
 *    Per-event, independent, NO pairing/dropping; thinking rows are included;
 *    orphan tool_result rows are emitted; tool rows carry tool_parent_id.
 * 2. Engine `derive_messages` — the model-visible history: turn markers and
 *    thinking are skipped, and run_code sub-call rows (parent_id present) are
 *    skipped too.
 *
 * Keeping both explicit is the whole point of P0: they differ, and the
 * difference is contract.
 */

import type { SessionEvent, StudioMessage } from "@celestea/core";

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

export function projectMessages(events: readonly SessionEvent[]): StudioMessage[] {
  const out: StudioMessage[] = [];
  for (const ev of events) {
    const m = sessionEventToMessage(ev);
    if (m !== null) out.push(m);
  }
  return out;
}

export interface DerivedMessage {
  role: "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown }>;
  tool_call_id?: string;
  tool_value?: unknown;
  tool_error?: string | null;
}

/**
 * Engine model-visible projection. Rows with parent_id (run_code sub-calls)
 * and thinking/turn markers never reach the model.
 */
export function deriveMessages(events: readonly SessionEvent[]): DerivedMessage[] {
  const out: DerivedMessage[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "turn_start":
      case "turn_end":
      case "thinking_delta":
        break;
      case "user_message":
        out.push({ role: "user", content: ev.text });
        break;
      case "assistant_message":
        out.push({ role: "assistant", content: ev.text });
        break;
      case "tool_call":
        if (ev.parent_id !== undefined) break; // run_code sub-call: audit only
        out.push({ role: "assistant", tool_calls: [{ id: ev.id, name: ev.name, args: ev.args }] });
        break;
      case "tool_result":
        if (ev.parent_id !== undefined) break;
        out.push({ role: "tool", tool_call_id: ev.id, tool_value: ev.value, tool_error: ev.error });
        break;
    }
  }
  return out;
}
