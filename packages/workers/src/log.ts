/**
 * The default session log for worker sessions.
 *
 * A worker conversation needs a `SessionLog` to be drivable. The real
 * implementations — in-memory and JSONL-persistent — live in `packages/session`,
 * which this package may NOT import (L1 packages never depend on each other,
 * ARCHITECTURE.md §1.3 D2). So the registry takes a `SessionLogFactory` and the
 * composition root injects the real one (`runtime` passes `packages/session`'s
 * `InMemorySessionLog`).
 *
 * A2 (W746): the default below is now a COMPLETE log, not a stub. It used to
 * return an empty history from `deriveMessages()` and justify that with "the
 * projection is owned by packages/session" — which meant a worker wired to the
 * default saw no history at all while looking like a legal `SessionLog`. The
 * projection is core's now (`deriveMessagesFrom`), so this package can mount it
 * over a plain event store and keep the seam's promise:
 *
 *   - `append` / `events` / `clear` / `nextTurnId` are complete and correct;
 *   - `deriveMessages` is the real engine projection (core-owned), so a driver
 *     wired to this default sees exactly what `packages/session` would show.
 */

import { memoryEventStore, projectingSessionLog, type SessionLog } from "@celestea/core";

export type SessionLogFactory = () => SessionLog;

/** Records events, owns the monotonic turn counter, projects via core. */
export function recordingSessionLog(): SessionLog {
  return projectingSessionLog(memoryEventStore());
}
