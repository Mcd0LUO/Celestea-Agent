/**
 * W1510 — the driver half of the repetition guard: what the LOOP does when an
 * attempt collapses.
 *
 * The detector (`repetition.ts`) judges, `repetition-cut.ts` decides what happens
 * to the characters, and this module owns the third piece: the model round trip
 * that closes a turn whose retry budget is spent, plus the diagnostics of every
 * conviction. It lives outside `loop.ts` because the loop is at its size
 * ceiling, and it takes closures rather than the Context so it stays a plain
 * object with no seam of its own.
 *
 * ## Why the wrap-up is a round trip and not just a stop
 *
 * A collapsed turn still did real work — files were edited, tests were run,
 * decisions were made. Stopping silently throws that away. The ported fallback
 * therefore spends ONE bounded model call asking for the conclusion, and the
 * instruction names the repetition so the model does not resume the line of work
 * that keeps collapsing (see `wrapUpText`).
 *
 * Fail-soft, never fail-loud: the turn's terminal state is already decided
 * (`interrupted`) by the time this runs, and a broken seam here must not replace
 * it with an error.
 */

import type { Llm, LlmStream, LoopEvent, ModelRequest, SessionLog } from "@celestea/core";
import { raceAbort, closeIterator, errorMessage } from "./cancel.js";
import type { RepetitionEvidence } from "./repetition.js";
import {
  recordRepetition,
  repetitionRecord,
  type RepetitionDiagnostics,
  type RepetitionPlan,
} from "./repetition-recovery.js";
import { wrapUpStep, type RecoveryStart } from "./repetition-run.js";
import { discardedText } from "./repetition-cut.js";
import type { StreamOutcome } from "./step.js";

/** Everything the driver needs from the loop, handed over as closures. */
export interface CollapseDeps {
  session: SessionLog;
  llm: Llm;
  signal: AbortSignal | undefined;
  /** Diagnostics sink; null = the conviction is not persisted anywhere. */
  diagnostics: RepetitionDiagnostics | null;
  /** Stamped on the log line; null is honest rather than invented. */
  sessionId: string | null;
  model: string;
  /** The loop's own request builder, so the round trip sees the same history. */
  buildRequest(): ModelRequest;
  /** The loop's event sink, so streamed deltas reach the UI live. */
  emit(event: LoopEvent): void;
}

export class CollapseDriver {
  constructor(private readonly deps: CollapseDeps) {}

  /** Persist one conviction: the JSONL line, plus a copy of the discarded text. */
  log(stream: StreamOutcome, plan: RepetitionPlan): void {
    const evidence = stream.repetition;
    if (evidence === null || this.deps.diagnostics === null) return;
    recordRepetition(
      this.deps.diagnostics,
      repetitionRecord({
        evidence,
        action: plan.action === "retry" ? "discard-and-retry" : "budget-exhausted",
        sessionId: this.deps.sessionId,
        model: this.deps.model,
        seenChars: stream.streamedText.length + stream.reasoningText.length,
        prunedChars: stream.prunedChars,
        convictionAt: stream.onset,
      }),
      discardedText(stream),
    );
  }

  /**
   * The budget-exhausted arm: one bounded call asking the model to close the
   * turn. A failure here leaves the turn `interrupted` with the kept prefix.
   */
  async wrapUp(evidence: RepetitionEvidence, plan: RepetitionPlan): Promise<void> {
    const { session } = this.deps;
    try {
      await wrapUpStep(
        {
          appendInstruction: (text) => session.append({ type: "user_message", text, origin: "steering" }),
          buildRequest: () => this.deps.buildRequest(),
          start: (request) => this.start(request),
          consume: (stream) => this.consume(stream),
          appendAnswer: (text) => session.append({ type: "assistant_message", text }),
        },
        evidence,
        plan,
      );
    } catch (error) {
      // A recovery failure is not the turn's failure: `interrupted` still stands.
      this.deps.emit({ kind: "text", delta: `[repetition-guard] recovery failed: ${errorMessage(error)}` });
    }
  }

  /** Start the recovery call; cancellation and provider failure both mean "no answer". */
  private async start(request: ModelRequest): Promise<RecoveryStart> {
    const raced = await raceAbort(this.deps.signal, this.deps.llm.generate(request));
    return raced.outcome === "ok" ? { kind: "ok", stream: raced.value } : { kind: "failed" };
  }

  /**
   * Consume the recovery stream to its end. Deliberately NO repetition guard: a
   * guard here could abort the recovery it triggered. Reasoning deltas are
   * emitted live but not persisted — a bounded side step has no replay value.
   */
  private async consume(stream: LlmStream): Promise<string> {
    let text = "";
    const iter = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await raceAbort(this.deps.signal, iter.next());
      if (next.outcome === "aborted") {
        closeIterator(iter);
        break;
      }
      if (next.outcome === "failed" || next.value.done === true) break;
      const event = next.value.value;
      if (event.kind === "text") {
        this.deps.emit({ kind: "text", delta: event.text });
        text += event.text;
      } else if (event.kind === "thinking") {
        this.deps.emit({ kind: "thinking", delta: event.text });
      }
    }
    return text;
  }
}
