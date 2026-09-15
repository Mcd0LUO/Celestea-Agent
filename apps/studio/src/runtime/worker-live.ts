/**
 * "Does this session instance still hold LIVE worker work?" (W742 §1 / §2.2.4).
 *
 * Extracted from `real-runtime-adapter.ts` verbatim: the predicate is about the
 * WORKER table, not about the adapter, and keeping it beside the other worker
 * views is what keeps the adapter inside the §4.1 file budget.
 *
 * Two things count as live (and only these):
 *   - a RUNNING row — the brief has no terminal verdict yet (W736 freezes a row
 *     exactly once, so RUNNING really does mean "not delivered");
 *   - a worker session with an OPEN turn — a follow-up message being answered;
 *     by then the row is already settled, so the log is the only witness.
 * A parked, settled worker is addressable but idle: it must NOT keep its
 * session's generation frozen, or a config change would never land there.
 */

import { getExtra, hasInProgressTurn, type WorkerRegistry } from "@celestea/workers";
import type { WorkerEntry } from "@celestea/core";

export interface LiveWorkerHost {
  runtime: { workers: WorkerRegistry | null };
}

export function hasLiveWorkersOf(entry: LiveWorkerHost): boolean {
  const workers = entry.runtime.workers;
  return workers !== null && workers.ownEntries().some((row) => row.status === "RUNNING" || openTurnOf(workers, row));
}

/** W742 §1: is a turn OPEN on this worker's own session log? (W736's rule.) */
function openTurnOf(workers: WorkerRegistry, row: WorkerEntry): boolean {
  const log = workers.sessions.logOf(getExtra(row, "sess") ?? "");
  return log !== undefined && hasInProgressTurn(log.events());
}
