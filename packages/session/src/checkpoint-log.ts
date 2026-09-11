/**
 * The checkpoint decorator: a `SessionLog` that records its own turn boundary.
 *
 * WHY a decorator and not a hook in the runtime: the `turn_start`/`turn_end`
 * rows are appended by the AGENT LOOP (the log is resolved from the Context per
 * turn), so the ONLY place that sees every boundary — whoever drives the turn —
 * is the log itself. Wrapping it keeps the checkpoint exact without touching
 * the frozen `SessionLog` seam (no new method, no new event, K5/K4).
 *
 * Discipline:
 *   - forwarding is transparent (a Proxy binds every other member to the inner
 *     log, so `path` / `close()` / `writeErrorCount()` keep working for the host
 *     and for the registry's `turnNo` restoration);
 *   - the checkpoint is written AFTER the row reached the log, so a crash in
 *     between can only lose an OPEN-TURN MARKER, never invent a repair: the boot
 *     decision table then reads "no checkpoint" and does nothing (fail-safe);
 *   - a checkpoint failure NEVER propagates into a turn (observation only).
 */

import type { SessionEvent, SessionLog } from "@celestea/core";
import { CheckpointStore } from "./checkpoint.js";

/** Access key of the wrapped store (symbol: invisible to JSON / spread). */
export const CHECKPOINT_STORE = Symbol.for("celestea.session.checkpointStore");

/** Wrap `log` so every turn boundary lands in `store` (§1.2.2 write timings). */
export function checkpointedLog(log: SessionLog, store: CheckpointStore): SessionLog {
  const handler: ProxyHandler<SessionLog> = {
    get(target, prop) {
      if (prop === CHECKPOINT_STORE) return store;
      if (prop === "append") return (event: SessionEvent): void => appendObserved(target, store, event);
      if (prop === "clear") {
        return (): void => {
          target.clear();
          store.clearOpenTurn(); // an emptied log has no open turn any more
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  };
  return new Proxy(log, handler);
}

/** The store behind a decorated log (null for a plain / missing log). */
export function checkpointStoreOf(log: SessionLog | null | undefined): CheckpointStore | null {
  if (log === null || log === undefined) return null;
  const store = (log as { [CHECKPOINT_STORE]?: unknown })[CHECKPOINT_STORE];
  return store instanceof CheckpointStore ? store : null;
}

/** Graceful-exit mark of a decorated log (`true` = the next boot repairs nothing). */
export function markCleanShutdown(log: SessionLog | null | undefined): boolean {
  const store = checkpointStoreOf(log);
  if (store === null) return false;
  store.noteLogWriteErrors();
  store.markCleanShutdown();
  return true;
}

/** The log's own degradation counter, when it has one (0 otherwise). */
export function writeErrorCountOf(log: SessionLog | null | undefined): number {
  const read = (log as { writeErrorCount?: unknown } | null | undefined)?.writeErrorCount;
  return typeof read === "function" ? Number(read.call(log)) : 0;
}

function appendObserved(log: SessionLog, store: CheckpointStore, event: SessionEvent): void {
  log.append(event);
  try {
    if (event.type === "turn_start") store.turnStarted(event.id);
    else if (event.type === "turn_end") store.turnEnded(event.outcome);
  } catch (e) {
    process.stderr.write(`[celestea-session] checkpoint not updated: ${String(e)}\n`);
  }
}
