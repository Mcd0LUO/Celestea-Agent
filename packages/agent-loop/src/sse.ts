/**
 * LoopEvent -> (SSE event name, payload) — the exact mapping of
 * `celestea_studio/src/main.rs:667-713` (`loop_event_to_json`).
 *
 * Kept in this package because it is contract, not transport: the frozen
 * `contracts/sse-events.json` table is checked against it, and the host
 * (`apps/studio`) only publishes the resulting frames. Phase/error labels come
 * from `core` (`outcomePhase` / `outcomeError`), so the agent loop never keeps
 * a second copy of that vocabulary.
 */

import { outcomeError, outcomePhase, type LoopEvent, type SseEventName } from "@celestea/core";

export interface SseFrame {
  event: SseEventName;
  payload: Record<string, unknown>;
}

/** LoopEvent -> (SSE event name, payload) exactly as `loop_event_to_json`. */
export function loopEventToSse(ev: LoopEvent): SseFrame {
  switch (ev.kind) {
    case "text":
      return { event: "text", payload: { delta: ev.delta } };
    case "thinking":
      return { event: "thinking", payload: { delta: ev.delta } };
    case "tool_call":
      return { event: "tool", payload: { id: ev.id, name: ev.name, args: ev.args } };
    case "tool_result":
      return {
        event: "tool_result",
        payload: {
          id: ev.callId,
          ok: ev.ok,
          value: ev.value,
          render: ev.render,
          error: ev.error,
          decision: ev.decision,
        },
      };
    case "turn_end":
      return { event: "turn_end", payload: { outcome: outcomePhase(ev.outcome), error: outcomeError(ev.outcome) } };
    case "done":
      return { event: "done", payload: { text: ev.text, tool_calls: ev.tool_calls } };
  }
}
