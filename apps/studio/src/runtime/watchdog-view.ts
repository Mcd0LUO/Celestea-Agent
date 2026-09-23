/**
 * W740 — the watchdog's read-only face on the host.
 *
 * The watchdog itself lives in `packages/workers` (adjudication) and is mounted
 * by `packages/runtime`'s composition root (cadence + teardown). What is left for
 * the host is READING it, and this module is that reading, so the adapter stays
 * about the HTTP contract:
 *
 *   - `watchdogOf` / `watchdogRunningOf` — one session's sweep handle;
 *   - `watchdogCount` — how many live instances sweep (the `worker_status`
 *     projection's `watchdogs` field);
 *   - `workerStatusOf` — the `by_status` fold over the merged rows, tagged with
 *     that count.
 *
 * Everything here PEEKS. A session that was never composed is not composed just
 * to answer a diagnostic: liveness must never be the thing that creates an engine.
 */

import type { SessionRuntime, SessionRuntimeRegistry } from "@celestea/runtime";
import type { Watchdog, WorkerRecoveryReport } from "@celestea/workers";
import { aggregateWorkerStatus } from "./worker-bridge.js";
import type { WorkerContextUsage, WorkerSessionRow, WorkerStatusReport } from "../runtime-adapter.js";

/** The session's watchdog, or null when it has no instance / the watchdog is off. */
export function watchdogOf(registry: SessionRuntimeRegistry, session?: string | null): Watchdog | null {
  return registry.peek(session ?? null)?.runtime.watchdog ?? null;
}

/** Is this session's sweep timer running? */
export function watchdogRunningOf(registry: SessionRuntimeRegistry, session?: string | null): boolean {
  return watchdogOf(registry, session)?.running ?? false;
}

/** Live instances currently sweeping their worker rows. */
export function watchdogCount(entries: readonly SessionRuntime[]): number {
  let running = 0;
  for (const entry of entries) if (entry.runtime.watchdog?.running === true) running += 1;
  return running;
}

/**
 * The process-wide worker status: `by_status` counted from the merged rows (so a
 * watchdog verdict moves it), the number of live sweepers, and — E §2.3 P0 ③ —
 * the boot observer's judgement of the PERSISTED table (`stale[]` / `orphans[]`).
 * The last two are PURE ADDITIONS to the frozen response shape.
 */
/**
 * Everything the status fold needs beyond the live rows themselves. ONE object
 * (not a sixth parameter): every field is an optional addition, so the frozen
 * shape only grows by the fields the caller actually supplies.
 */
export interface WorkerStatusInput {
  wid?: string;
  recovery?: WorkerRecoveryReport | null;
  contextOf?: (sess: string) => WorkerContextUsage | null;
  /** W1470b: previous-generation rows — reported, never counted. */
  inherited?: readonly WorkerSessionRow[];
}

export function workerStatusOf(rows: readonly WorkerSessionRow[], watchdogs: number, input: WorkerStatusInput = {}): WorkerStatusReport {
  const report = aggregateWorkerStatus(rows, input.wid, input.contextOf, input.inherited ?? []);
  const sweepers = watchdogs === 0 ? report : { ...report, watchdogs };
  return input.recovery == null ? sweepers : { ...sweepers, stale: input.recovery.stale, orphans: input.recovery.orphans };
}
