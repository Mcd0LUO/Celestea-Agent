/**
 * Agent loop seam (P1 placeholder).
 *
 * P0 freezes: the LoopEvent -> SSE mapping, the terminal outcome vocabulary,
 * and the cancel semantics (cooperative, checked at interruptible points).
 */

import type { LoopEvent, SseEventName, TurnOutcome } from "@celestea/core";

/** outcome -> SSE phase (src/main.rs:716-726). */
export function outcomePhase(o: TurnOutcome): string {
  if (typeof o === "string") return o;
  return "error";
}

export function outcomeError(o: TurnOutcome): string | null {
  if (typeof o === "string") return null;
  return `${o.error.kind}: ${o.error.message}`;
}

/** LoopEvent -> (SSE event name, payload) exactly as loop_event_to_json does. */
export function loopEventToSse(ev: LoopEvent): { event: SseEventName; payload: Record<string, unknown> } {
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
          ok: ev.error === null,
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

export interface CancelSignal {
  cancelled: boolean;
  cancel(): void;
}

export function createCancelSignal(): CancelSignal {
  const s: CancelSignal = {
    cancelled: false,
    cancel() {
      s.cancelled = true;
    },
  };
  return s;
}

/** max_steps = 0 means ZERO steps in the engine, hence MIN_STEPS = 4096. */
export const MIN_STEPS = 4096;
export const STATUS_TICK_MS = 2000;
