/**
 * Per-step bookkeeping types and the pure folds of one model step.
 *
 * Kept apart from the loop driver so the verdict vocabulary ("what did this
 * step decide?") is readable on its own: a step can end the turn, ask for
 * another step, be cancelled, or fail to start at all.
 */

import { messageTexts, messageToolCalls, type LlmStream, type Message, type StreamEvent, type ToolCall, type TurnOutcome } from "@celestea/core";
import type { RepetitionEvidence } from "./repetition.js";
import type { RepetitionPlan } from "./repetition-recovery.js";

/** Verdict of one model step, consumed by the step loop. */
export type StepResult =
  /** The turn is over (completed, or a torn stream after a done frame). */
  | { kind: "final"; outcome: TurnOutcome }
  /** Tool calls were dispatched; step again. */
  | { kind: "continue" }
  /** Cancelled by the caller's signal (or a repetition abort). */
  | { kind: "cancelled" }
  /**
   * W1510: the stream collapsed into degenerate repetition and the attempt was
   * DISCARDED. The driver re-issues the call with a perturbed route; the step
   * budget is not debited for an attempt that produced nothing.
   */
  | { kind: "retry"; evidence: RepetitionEvidence; retriesUsed: number };

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
  /** W1510: set when the repetition guard convicted this stream. */
  repetition: RepetitionEvidence | null;
  /**
   * W1510: how many characters of the held-back tail are DEGENERATION and must
   * not be released. Non-zero only when a conviction exhausted the retry budget
   * and the caller held text back, in which case the healthy prefix before
   * `degenerationOnset` is kept and the rest is dropped. Zero means "release
   * everything" — the pre-W1510 behaviour, byte for byte.
   */
  prune: number;
  /** W1510: retry attempts already spent in this step (drives the budget). */
  retries: number;
  /** W1510: retry attempts spent by the time the step ended (reported to the driver). */
  retriesUsed: number;
  /** W1510: what the driver must do about the conviction (null = no conviction). */
  repetitionPlan: RepetitionPlan | null;
  /** W1510: onset offset inside the convicted window, for the log line. */
  onset: number | null;
  /**
   * W1510: every text delta of this attempt, in order. Kept ONLY so a truncation
   * can find the onset inside the reply itself — the same reason the reasoning
   * buffer is kept, for the other channel.
   */
  streamedText: string;
  /**
   * W1510: every thinking delta of this attempt, in order — the reasoning
   * counterpart of `streamedText`, kept so a reasoning collapse can be cut at
   * its onset before anything is persisted.
   */
  reasoningText: string;
  /**
   * W1510: characters actually dropped as degeneration when the attempt was
   * released. Filled in by `repetition-cut.ts`, which is the only place that
   * knows what the onset search really cut — `prune` is the pre-release estimate.
   */
  prunedChars: number;
}

export function emptyStreamOutcome(): StreamOutcome {
  return {
    assistantText: "",
    toolCalls: [],
    sawDone: false,
    doneMessage: null,
    cancelled: false,
    terminal: null,
    repetition: null,
    prune: 0,
    retries: 0,
    retriesUsed: 0,
    repetitionPlan: null,
    onset: null,
    streamedText: "",
    reasoningText: "",
    prunedChars: 0,
  };
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
