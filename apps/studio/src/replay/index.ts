/**
 * P5 double-run comparison harness (`pnpm replay:e2e`).
 *
 * Replays the golden fixtures from the retired backend through the
 * TS host (real runtime + offline LLM) and reports, per artifact, whether the
 * output is byte-identical, frozen-golden, independently re-derived or merely
 * self-consistent — plus what still has to be captured before P6.
 */

export * from "./compare.js";
export * from "./expect-compact.js";
export * from "./fixtures.js";
export * from "./host.js";
export * from "./probes.js";
export * from "./session-e2e.js";
export * from "./e2e-replay.js";
export * from "./report.js";
