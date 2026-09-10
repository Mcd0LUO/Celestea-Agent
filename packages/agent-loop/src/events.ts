/**
 * Turn-level event plumbing — port of `crates/agent-loop/src/events.rs`.
 *
 * A running turn delivers every [LoopEvent] it produces to an injected
 * [EventSink], in log order: the LLM stream deltas (text / thinking / done)
 * plus the tool lifecycle (tool_call + the FULL ToolOutput of every result) so
 * a rich UI can draw tool cards without scraping the session log.
 *
 * P0-A: every started turn emits exactly ONE terminal
 * `{ kind: "turn_end" }` carrying the real terminal state — consumers map it
 * onto their "done"/status envelope, so cancelled / error / step-limit /
 * interrupted turns can never be mistaken for completed ones.
 *
 * The builders below are the only place where core values become events, so
 * the log and the event stream can never drift apart.
 */

import {
  messageTexts,
  messageToolCalls,
  type LoopEvent,
  type Message,
  type ToolCall,
  type ToolDecision,
  type ToolOutput,
  type TurnOutcome,
} from "@celestea/core";

/** A sink receives every LoopEvent of a turn, in log order. */
export type EventSink = (event: LoopEvent) => void;

/** `Some(ToolDecision::Allow)` -> `"allow"`: the flat label of the SSE payload. */
export function decisionLabel(decision: ToolDecision | null): "allow" | "deny" | "ask" | null {
  return decision === null ? null : decision.kind;
}

export function toolCallEvent(call: ToolCall): LoopEvent {
  return { kind: "tool_call", id: call.id, name: call.name, args: call.args };
}

/** The full ToolOutput rides the event: value, authored render, error, verdict. */
export function toolResultEvent(output: ToolOutput): LoopEvent {
  return {
    kind: "tool_result",
    callId: output.call_id,
    ok: output.error === null,
    value: output.value,
    render: output.render,
    error: output.error,
    decision: decisionLabel(output.decision),
  };
}

/** The authoritative assistant reply of one model step (not terminal). */
export function doneEvent(message: Message): LoopEvent {
  return {
    kind: "done",
    text: messageTexts(message).join(""),
    tool_calls: messageToolCalls(message).map((call) => ({ id: call.id, name: call.name, args: call.args })),
  };
}

/** The single terminal verdict of the turn. */
export function turnEndEvent(outcome: TurnOutcome): LoopEvent {
  return { kind: "turn_end", outcome };
}
