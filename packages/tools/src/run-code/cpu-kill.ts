/**
 * `RLIMIT_CPU` kills, in the broker's vocabulary (W1516 §3.3).
 *
 * Why this is its own module: the fact "the CHILD's own CPU limit is what killed
 * it" is invisible from the outside. `RLIMIT_CPU` counts CPU time of ONE process
 * and reports itself only as a signal — SIGXCPU at the soft limit, SIGKILL at the
 * hard limit — while the broker's own wall clock is an unrelated timeline that
 * also ends in a kill. Without this distinction a CPU death reached the model as
 * `code=aborted … (killed=false)`: a bare death with no cause, next to a
 * `code=timeout` for the deadline the model actually set. The model then could
 * not tell "my program was too slow for the sandbox's CPU budget" from "my
 * program hit the wall clock I asked for".
 *
 * Keeping the verdict HERE means the message shape is written once, and the
 * broker only supplies the facts.
 */

import { RUN_CODE_ERROR_PREFIX, runCodeFailure } from "./limits.js";

/**
 * SIGXCPU (soft limit) / SIGKILL (hard limit) are how `RLIMIT_CPU` terminates.
 *
 * Both are treated the same on purpose: the kernel sends SIGXCPU first and
 * escalates to SIGKILL if the process does not die, so seeing either means the
 * same thing — the CPU budget is what ended this process.
 */
export function isCpuSignal(signal: string | null): boolean {
  return signal === "SIGXCPU" || signal === "SIGKILL";
}

/** How a child terminated, projected to the primitives a verdict needs. */
export interface ChildDeath {
  /** The BROKER killed it (wall clock / protocol failure), not the kernel. */
  killed: boolean;
  /** It died on a CPU signal (see [isCpuSignal]). */
  cpuExceeded: boolean;
  signal: string | null;
  exitCode: number | null;
}

/** True when the child's OWN `RLIMIT_CPU` — not the broker — ended it. */
export function isCpuKill(death: ChildDeath): boolean {
  return death.cpuExceeded && !death.killed;
}

/**
 * The `cpu_exceeded` failure, in the SAME vocabulary as `run_shell`'s marker.
 *
 * The message NAMES the limit on purpose: that is what lets the model act (raise
 * `timeout_ms`, which now raises the CPU budget with it) instead of guessing
 * whether the sandbox or its own deadline was at fault.
 */
export function cpuExceededMessage(cpuSec: number, death: ChildDeath, capturedBytes: number): string {
  const signal = death.signal ?? "SIGXCPU";
  const code = death.exitCode === null ? "?" : String(death.exitCode);
  return runCodeFailure(
    "cpu_exceeded",
    `killed by the CPU time limit ${cpuSec}s (signal=${signal}, exit_code=${code}; stdout_log_captured_bytes=${capturedBytes}) — raise timeout_ms to raise the CPU budget`,
  ).message;
}

/** What the broker must tell [cpuExceededFailure] about one finished run. */
export interface CpuKillInput {
  /** Terminal state of the child (`null` = it never settled). */
  death: ChildDeath | null;
  /** The `RLIMIT_CPU` the child was spawned with (`null` = unknown). */
  cpuSec: number | null;
  /** The program produced a `__final__`/`__error__` line, so it ran to its end. */
  hasFinal: boolean;
  /** Bytes of program log captured so far (for the message). */
  capturedBytes: number;
}

/**
 * The CPU-kill error for this run, or `null` when something else explains it.
 *
 * The caller passes a higher-priority explanation (an infra or program error) by
 * simply not reaching this function, so a CPU kill can never steal a
 * `code=timeout` or a program exception that already has a better story.
 */
export function cpuExceededFailure(input: CpuKillInput): string | null {
  const { death, cpuSec, hasFinal, capturedBytes } = input;
  if (death === null || !isCpuKill(death) || hasFinal) return null;
  return cpuExceededMessage(cpuSec ?? 0, death, capturedBytes);
}

/** Re-exported so the broker's failure prefix stays reachable from one place. */
export { RUN_CODE_ERROR_PREFIX };
