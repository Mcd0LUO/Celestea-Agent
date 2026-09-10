/**
 * Per-step bookkeeping types and the pure folds of one model step.
 *
 * Kept apart from the loop driver so the verdict vocabulary ("what did this
 * step decide?") is readable on its own: a step can end the turn, ask for
 * another step, be cancelled, or fail to start at all.
 */

import { messageTexts, messageToolCalls, type LlmStream, type Message, type StreamEvent, type ToolCall, type TurnOutcome } from "@celestea/core";

/** Verdict of one model step, consumed by the step loop. */
export type StepResult =
  /** The turn is over (completed, or a torn stream after a done frame). */
  | { kind: "final"; outcome: TurnOutcome }
  /** Tool calls were dispatched; step again. */
  | { kind: "continue" }
  | { kind: "cancelled" };

/** What starting one model response produced. */
export type GenerateResult =
  | { kind: "ok"; stream: LlmStream }
  | { kind: "cancelled" }
  | { kind: "failed"; outcome: TurnOutcome };

/** Everything the loop learned from one response stream. */
export interface StreamOutcome {
  assistantText: string;
  toolCalls: ToolCall[];
  sawDone: boolean;
  doneMessage: Message | null;
  cancelled: boolean;
  terminal: TurnOutcome | null;
}

export function emptyStreamOutcome(): StreamOutcome {
  return { assistantText: "", toolCalls: [], sawDone: false, doneMessage: null, cancelled: false, terminal: null };
}

/** Fold the authoritative `done` message into the step accumulators. */
export function absorbDone(out: StreamOutcome, message: Message): void {
  out.sawDone = true;
  out.doneMessage = message;
  out.assistantText += messageTexts(message).join("");
  out.toolCalls.push(...messageToolCalls(message));
}

/** `failed` / `interrupted` are terminal: they decide the turn's state. */
export function terminalFromStreamEvent(ev: StreamEvent): TurnOutcome {
  return ev.kind === "failed" ? { error: { kind: ev.kindOf, message: ev.message } } : "interrupted";
}
