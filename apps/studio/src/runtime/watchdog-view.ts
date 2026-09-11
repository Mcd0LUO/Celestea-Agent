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
import type { Watchdog } from "@celestea/workers";
import { aggregateWorkerStatus } from "./worker-bridge.js";
import type { WorkerSessionRow, WorkerStatusReport } from "../runtime-adapter.js";

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
 * watchdog verdict moves it) plus the number of live sweepers.
 */
export function workerStatusOf(rows: readonly WorkerSessionRow[], watchdogs: number, wid?: string): WorkerStatusReport {
  const report = aggregateWorkerStatus(rows, wid);
  return watchdogs === 0 ? report : { ...report, watchdogs };
}
