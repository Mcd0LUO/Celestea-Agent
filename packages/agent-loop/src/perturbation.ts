/**
 * W1510 — the perturbation seam: how a re-issued attempt reaches the wire on a
 * DIFFERENT route.
 *
 * ## Why a wrapper is needed at all
 *
 * The ported strategy re-issues a collapsed attempt with the reasoning effort
 * stepped down one rung (see `repetition-recovery.ts` for why effort and not
 * temperature). Reasoning effort is NOT part of the frozen `ModelRequest`
 * contract — it lives on the CLIENT — so the loop cannot express it in a
 * request. Something between the loop and the client has to hold it, and this is
 * that something.
 *
 * ## Shape, and why it is not a new seam
 *
 * `withRepetitionPerturbation(inner, host)` returns the SAME `Llm` interface
 * everything already consumes, exactly like the fallback decorator
 * (`@celestea/llm`'s `createFallbackLlm`). The loop only says WHEN a retry
 * follows a collapse (`noteRetry()`); the wrapper owns WHICH rung that becomes,
 * because only the host knows the current effort.
 *
 * ## Degradation is explicit
 *
 * The engine profile is a frozen 12-key contract, so the perturbed effort is
 * carried in a mutable cell rather than smuggled into `Profile`. A host that
 * cannot rebuild its client (the offline seam, an injected test client) returns
 * the SAME client from `apply`: the retry still happens, on the unchanged route,
 * and the only difference is that no rung was stepped down. That is an honest
 * degradation, not a silent one — the conviction is logged either way.
 */

import type { Llm, LlmStream, ModelRequest } from "@celestea/core";
import { perturbedEffort } from "./repetition-recovery.js";

/** What a host must provide for the perturbation to reach the wire. */
export interface PerturbationHost {
  /** The route's reasoning effort RIGHT NOW; the ladder starts from here. */
  currentEffort: string | null;
  /**
   * Rebuild (or return) the client to use for the next attempt, given the
   * perturbed effort. Returning the SAME client is the documented degradation.
   */
  apply(effort: string): Llm;
}

/** The seam the loop sees: an `Llm` that can be told a retry is coming. */
export interface PerturbableLlm extends Llm {
  /**
   * Step the route down one rung for the NEXT request. A no-op when the effort
   * is outside the ladder or already at the bottom — the ported plugin refuses
   * to invent a value the model may reject.
   */
  noteRetry(): void;
}

/**
 * Wrap `inner` so the next request can be issued on a perturbed route.
 *
 * The armed effort is consumed by the first request that follows it, so a
 * perturbation is confined to exactly one attempt — the one that follows a
 * collapse — and never becomes the session's route.
 */
export function withRepetitionPerturbation(inner: Llm, host: PerturbationHost): PerturbableLlm {
  let current: Llm = inner;
  let effort: string | null = host.currentEffort;
  let armed: string | null = null;
  return {
    async generate(req: ModelRequest): Promise<LlmStream> {
      if (armed !== null) {
        const next = armed;
        armed = null;
        current = host.apply(next);
      }
      return current.generate(req);
    },
    noteRetry(): void {
      const next = perturbedEffort(effort);
      if (next === null) return;
      effort = next;
      armed = next;
    },
  };
}

/** Is this `Llm` able to take a perturbation? The loop degrades when it is not. */
export function isPerturbable(llm: Llm): llm is PerturbableLlm {
  return typeof (llm as Partial<PerturbableLlm>).noteRetry === "function";
}
