/**
 * InMemorySessionLog — port of `crates/session/src/log.rs:16-66`.
 *
 * An in-memory, append-only session log: insertion order is the single source
 * of truth and the model history is always derived from it, never stored
 * separately. The turn-id counter is owned by the LOG (not the agent loop) and
 * never resets — not even on `clear` — so ids never repeat across loop
 * instances (P0-A unique turn identity).
 */

import { deriveMessagesFrom, formatTurnId, type Message, type SessionEvent, type SessionLog } from "@celestea/core";

export class InMemorySessionLog implements SessionLog {
  private recorded: SessionEvent[] = [];
  private turnCounter = 0;

  /** Create an empty session log. */
  static create(): InMemorySessionLog {
    return new InMemorySessionLog();
  }

  append(event: SessionEvent): void {
    this.recorded.push(event);
  }

  /** A copy of the recorded events (Rust `events()` clones the Vec). */
  events(): SessionEvent[] {
    return [...this.recorded];
  }

  deriveMessages(): Message[] {
    return deriveMessagesFrom(this.recorded);
  }

  /** Drop every event; the id counter deliberately survives (Rust `clear`). */
  clear(): void {
    this.recorded = [];
  }

  nextTurnId(): string {
    return formatTurnId(this.turnCounter++);
  }

  /** The next number the counter would hand out (diagnostics / recovery). */
  peekTurnNumber(): number {
    return this.turnCounter;
  }

  /** Restore the counter after a replay (`PersistentSessionLog` recovery). */
  restoreTurnCounter(next: number): void {
    this.turnCounter = next;
  }
}
