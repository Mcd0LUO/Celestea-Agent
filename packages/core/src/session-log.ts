/**
 * SessionLog seam — the `SessionLog` trait of
 * `crates/core/src/session_log.rs:87-99`.
 *
 * The log is the single source of truth for a conversation: it records
 * SessionEvents in insertion order and derives the model-visible history on
 * demand. Nothing here is concrete — `packages/session` provides the in-memory
 * and JSONL-backed implementations and registers one as a plugin; `core` never
 * imports them (dependency direction: session -> core).
 */

import type { Message } from "./message.js";
import type { SessionEvent } from "./types.js";

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
