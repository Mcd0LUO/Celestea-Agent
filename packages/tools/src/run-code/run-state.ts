/**
 * The mutable state of ONE `run_code` round trip, plus the time budget it runs
 * under (W1516).
 *
 * Kept apart from the broker so the broker stays the protocol/orchestration file
 * and this stays the data it accumulates: the log ledger, the sub-call budget,
 * the terminal child state and the outcome fields. Nothing here executes
 * anything, so the shapes can be read (and asserted) without the loop around
 * them.
 */

/** Terminal state of the child, plus its captured stderr. */
export interface Settled {
  exitCode: number | null;
  /** The child was killed because it did not exit within the grace period. */
  killed: boolean;
  /** The child was killed by ITS OWN `RLIMIT_CPU` (see `cpu-kill.ts`). */
  cpuExceeded: boolean;
  signal: string | null;
  stderrText: string;
  stderrTruncated: boolean;
}

/**
 * How the child terminated, BEFORE its stderr is attached.
 *
 * [Settled] is this plus the captured stderr, which is drained separately (and
 * can outlive the exit) — so this is the honest type of what the exit wait alone
 * can report.
 */
export type ChildTermination = Omit<Settled, "stderrText" | "stderrTruncated">;

/** The two time dimensions of one run (W1516 §3.1). */
export interface RunBudget {
  /** The effective WALL CLOCK in ms (the broker's own deadline). */
  timeoutMs: number;
  /**
   * The `RLIMIT_CPU` handed to the child, derived from `timeoutMs`.
   *
   * Both live together so the deadline the broker enforces and the CPU budget the
   * child received cannot drift apart — and so a `cpu_exceeded` failure can NAME
   * the exact number the sandbox was given.
   */
  cpuSec: number;
}

/** Mutable state of one run (logs, budget, outcome). */
export interface RunState {
  logs: string;
  logsTruncated: boolean;
  subOutputBytes: number;
  subOutputDropped: number;
  dispatched: number;
  hasFinal: boolean;
  finalValue: unknown;
  programError: string | null;
  infraError: string | null;
  settle: Settled | null;
  /** The `RLIMIT_CPU` the child was spawned with (null before the spawn). */
  cpuSec: number | null;
}

export function newRunState(): RunState {
  return {
    logs: "",
    logsTruncated: false,
    subOutputBytes: 0,
    subOutputDropped: 0,
    dispatched: 0,
    hasFinal: false,
    finalValue: null,
    programError: null,
    infraError: null,
    settle: null,
    cpuSec: null,
  };
}
