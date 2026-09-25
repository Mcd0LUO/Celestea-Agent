/**
 * W1510 — the RECOVERY step that runs after the repetition guard aborts an
 * attempt, ported from the host plugin `dsh-guard-repeat-output`.
 *
 * Keeping it out of `loop.ts` is deliberate: the loop is at its size ceiling and
 * the recovery is a self-contained procedure with its own ordering rules. The
 * loop hands in closures (append / build / start / consume) and this module owns
 * the sequence and the fail-soft policy.
 *
 * This module owns the WRAP-UP arm only: the retry budget is spent, so the model
 * is asked to state the conclusion ONCE and end, instead of resuming the line of
 * work that keeps collapsing. The DISCARD-AND-RETRY arm needs no module of its
 * own — it IS the next model call, issued by the driver on a perturbed route
 * (see `perturbation.ts` and `repetition-driver.ts`).
 *
 * Fail-soft, never fail-loud: a recovery that throws would replace the turn's
 * real terminal state with an error. Every failure path returns `false`.
 */

import type { LlmStream, ModelRequest } from "@celestea/core";
import type { RepetitionEvidence } from "./repetition.js";
import { wrapUpText, type RepetitionPlan } from "./repetition-recovery.js";

/** The two verdicts a generation start can produce for a recovery step. */
export type RecoveryStart = { kind: "ok"; stream: LlmStream } | { kind: "failed" };

/** Everything a recovery needs from the loop; the loop owns the real seams. */
export interface RecoveryDeps {
  /** Append an injected instruction row (origin: steering) to the session log. */
  appendInstruction(text: string): void;
  /** Build the request for the next model call (the row above is already in it). */
  buildRequest(): ModelRequest;
  /** Start the generation; the loop maps cancellation and provider errors. */
  start(request: ModelRequest): Promise<RecoveryStart>;
  /** Consume a stream to its end with NO repetition guard attached. */
  consume(stream: LlmStream): Promise<string>;
  /** Append the recovery answer as an assistant row. */
  appendAnswer(text: string): void;
}

/**
 * One instruction-plus-answer round trip: append, build, start, consume, append.
 *
 * The ORDER is the contract. The instruction must be in the log BEFORE the
 * request is built, because the request is derived from the log — reversing the
 * two would send the model a request without the instruction it is answering.
 * An empty answer is reported as `false` rather than written as an empty row.
 */
async function instructionRound(deps: RecoveryDeps, instruction: string): Promise<boolean> {
  deps.appendInstruction(instruction);
  const started = await deps.start(deps.buildRequest());
  if (started.kind === "failed") return false;
  const text = await deps.consume(started.stream);
  if (text.trim() === "") return false;
  deps.appendAnswer(text);
  return true;
}

/**
 * The WRAP-UP recovery: the retry budget is spent, so the turn is closed with a
 * conclusion instead of another error — or another collapse.
 */
export function wrapUpStep(
  deps: RecoveryDeps,
  evidence: RepetitionEvidence,
  plan: RepetitionPlan,
): Promise<boolean> {
  return instructionRound(deps, wrapUpText(evidence, plan.retriesUsed));
}
