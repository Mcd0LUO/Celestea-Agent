/**
 * SessionLog seam — the `SessionLog` trait of
 * `crates/core/src/session_log.rs:87-99`.
 *
 * The log is the single source of truth for a conversation: it records
 * SessionEvents in insertion order and derives the model-visible history on
 * demand. `packages/session` provides the in-memory and JSONL-backed
 * implementations and registers one as a plugin; `core` never imports them
 * (dependency direction: session -> core).
 *
 * A2 (W746): the seam now also owns the two things every implementation used to
 * have to re-implement — the projection ([deriveMessagesFrom]) and the turn-id
 * math ([formatTurnId] / [maxTurnNumber]). A backend only owns STORAGE
 * ([EventStore]) and hands it to [projectingSessionLog]; the store type rejects a
 * backend that ships its own `deriveMessages`, so the "legal-looking log with an
 * empty history" that `packages/workers/src/log.ts` used to be is no longer
 * expressible.
 */

import type { Message } from "./message.js";
import type { SessionEvent } from "./types.js";
import { deriveMessagesFrom } from "./projection.js";
import { formatTurnId, maxTurnNumber } from "./turn-id.js";

export interface SessionLog {
  /** Append one event (insertion order is the contract). */
  append(event: SessionEvent): void;
  /** A copy of the recorded events, in insertion order. */
  events(): SessionEvent[];
  /** The model-visible projection of [events]. */
  deriveMessages(): Message[];
  /** Drop every event (the turn-id counter never resets in the in-memory log). */
  clear(): void;
  /**
   * Allocate the next unique turn id (`"turn-<n>"`, monotonic). The LOG owns
   * the counter — not the agent loop — so ids never repeat across loop
   * instances, and a persistent log restores its counter from the max turn id
   * replayed from disk.
   */
  nextTurnId(): string;
}

/** Well-known token for the session log service in a Context. */
export const SESSION_LOG_SERVICE = "celestea.core.SessionLog";

// ---------------------------------------------------------------------------
// The storage half + core's default projection (A2)
// ---------------------------------------------------------------------------

/**
 * The storage backend a SessionLog is built on: events in, events out. Neither
 * the projection nor the turn ids are the store's business.
 *
 * `deriveMessages?: never` is the point of the type. The projection is core's
 * ([deriveMessagesFrom]), so a store that ships its own `deriveMessages` — above
 * all one that returns `[]` — is not assignable to [projectingSessionLog]. That
 * is what makes the empty-history log `packages/workers/src/log.ts` used to be a
 * type error instead of a plausible-looking alternative implementation.
 */
export interface EventStore {
  /** Append one event (insertion order is the contract). */
  append(event: SessionEvent): void;
  /** A copy of the recorded events, in insertion order. */
  events(): SessionEvent[];
  /** Drop every event. */
  clear(): void;
  /** Refused: the projection is the seam's, never the store's (A2). */
  deriveMessages?: never;
}

/** An in-memory event store (the trivial backend, and the default one). */
export function memoryEventStore(): EventStore {
  let recorded: SessionEvent[] = [];
  return {
    append(event: SessionEvent): void {
      recorded.push(event);
    },
    events(): SessionEvent[] {
      return [...recorded];
    },
    clear(): void {
      recorded = [];
    },
  };
}

/**
 * Build a `SessionLog` over a store: core owns the projection and the ids, the
 * store owns persistence.
 *
 * The counter starts at `maxTurnNumber(store.events()) + 1` — 0 for an empty
 * store, and beyond every id already on disk for a replayed one (so a restart
 * never reuses an id) — and never resets, not even on `clear()` (ids stay
 * unique for the life of the log).
 */
export function projectingSessionLog(store: EventStore): SessionLog {
  let turnCounter = maxTurnNumber(store.events()) + 1;
  return {
    append(event: SessionEvent): void {
      store.append(event);
    },
    events(): SessionEvent[] {
      return store.events();
    },
    deriveMessages(): Message[] {
      return deriveMessagesFrom(store.events());
    },
    clear(): void {
      store.clear();
    },
    nextTurnId(): string {
      return formatTurnId(turnCounter++);
    },
  };
}
