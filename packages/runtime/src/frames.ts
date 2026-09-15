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

/**
 * W783: one parked user question.
 *
 * This frame is NOT produced by the agent loop — a question parks the tool call,
 * so no `LoopEvent` exists to map. It is host-emitted, which is why it is built
 * here rather than in `loopEventToFrame`: the module that owns every frozen SSE
 * payload owns this one too, so the two can never drift apart.
 *
 * `expires_at` is an absolute deadline and `timeout_ms` the resolved wait (§6.1),
 * so a client can draw the countdown from the frame alone and judge expiry with
 * the server's clock rather than its own.
 */
export function questionFrame(input: QuestionFrameInput): TurnFrame {
  return frame("question", {
    session: input.session,
    id: input.id,
    questions: [...input.questions],
    expires_at: input.expiresAt,
    timeout_ms: input.timeoutMs,
  });
}

/** What [questionFrame] needs: the request as the pending table holds it. */
export interface QuestionFrameInput {
  session: string | null;
  id: string;
  questions: readonly unknown[];
  expiresAt: number;
  timeoutMs: number;
}
