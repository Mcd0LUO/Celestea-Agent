/**
 * The default (minimal) session log for worker sessions.
 *
 * A worker conversation needs a `SessionLog` to be drivable. The real
 * implementations — in-memory and JSONL-persistent, including the model-visible
 * projection `deriveMessages` — live in `packages/session`, which this package
 * may NOT import (L1 packages never depend on each other, ARCHITECTURE.md §1.3
 * D2). So the registry takes a `SessionLogFactory` and the composition root
 * injects the real one (`runtime` passes `packages/session`'s
 * `InMemorySessionLog`); the default below only guarantees the registry is
 * constructible in isolation:
 *
 *   - `append` / `events` / `clear` / `nextTurnId` are complete and correct;
 *   - `deriveMessages` returns an EMPTY history, because the projection is owned
 *     by `packages/session`. A driver wired to this default would run a worker
 *     with no visible history — inject a real log factory for driven workers.
 */

import type { Message, SessionEvent, SessionLog } from "@celestea/core";

export type SessionLogFactory = () => SessionLog;

/** Records events, owns the monotonic turn counter, projects nothing. */
export function recordingSessionLog(): SessionLog {
  const events: SessionEvent[] = [];
  let turns = 0;
  return {
    append(event: SessionEvent): void {
      events.push(event);
    },
    events(): SessionEvent[] {
      return [...events];
    },
    deriveMessages(): Message[] {
      return [];
    },
    clear(): void {
      events.length = 0;
    },
    nextTurnId(): string {
      const id = `turn-${turns}`;
      turns += 1;
      return id;
    },
  };
}
