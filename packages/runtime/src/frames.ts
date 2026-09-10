/**
 * LoopEvent -> SSE frame mapping and the per-turn sink shape.
 *
 * The runtime owns the host-facing event stream: a turn drives the
 * `AgentLoop` seam and every `LoopEvent` (core) it produces becomes exactly one
 * `TurnFrame` — the frozen `contracts/sse-events.json` name plus its payload
 * (`celestea_studio/src/main.rs:667-713`, `loop_event_to_json`).
 *
 * The mapping is injectable (`FrameMapper`): the default below is contract-faithful
 * and complete, and a host that already ships its own mapper (for example
 * `@celestea/agent-loop`'s `loopEventToSse`) passes it in the compose config
 * instead. Either way the runtime never imports an L1 implementation.
 */

import { outcomeError, outcomePhase, type LoopEvent, type SseEventName } from "@celestea/core";

/** One SSE frame: the frozen event name plus its `data:` payload. */
export interface TurnFrame {
  event: SseEventName;
  payload: Record<string, unknown>;
}

/** Maps a core `LoopEvent` onto the host-facing frame. */
export type FrameMapper = (event: LoopEvent) => TurnFrame;

/** Sink handed to the agent loop; structurally identical to `EventSink`. */
export type LoopEventSink = (event: LoopEvent) => void;

/** `loop_event_to_json` — the default, contract-faithful mapping. */
export function loopEventToFrame(ev: LoopEvent): TurnFrame {
  switch (ev.kind) {
    case "text":
      return frame("text", { delta: ev.delta });
    case "thinking":
      return frame("thinking", { delta: ev.delta });
    case "tool_call":
      return frame("tool", { id: ev.id, name: ev.name, args: ev.args });
    case "tool_result":
      return frame("tool_result", {
        id: ev.callId,
        ok: ev.ok,
        value: ev.value,
        render: ev.render,
        error: ev.error,
        decision: ev.decision,
      });
    case "turn_end":
      return frame("turn_end", { outcome: outcomePhase(ev.outcome), error: outcomeError(ev.outcome) });
    case "done":
      return frame("done", { text: ev.text, tool_calls: ev.tool_calls });
  }
}

function frame(event: SseEventName, payload: Record<string, unknown>): TurnFrame {
  return { event, payload };
}
