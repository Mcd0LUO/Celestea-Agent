/**
 * Turn id ownership and arithmetic (session_log.rs:94-98).
 *
 * A2 (W746): the turn-id math lives in CORE, next to the `SessionLog` seam that
 * promises it. `SessionLog.nextTurnId()` is a seam method, so `formatTurnId` /
 * `nextTurnNumber` cannot be private to one implementation package: every
 * backend must mint the same ids, and `packages/session` re-exports these.
 *
 * The LOG owns the counter, not the loop: next_turn_number only recognises the
 * `turn-<n>` prefix and restores its counter from the max replayed id, so ids
 * are monotonic and never reused after a restart.
 */

import type { SessionEvent } from "./types.js";

const TURN_ID = /^turn-(\d+)$/;

export function parseTurnNumber(id: string): number | null {
  const m = TURN_ID.exec(id);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function formatTurnId(n: number): string {
  return `turn-${n}`;
}

/** Max turn-<n> seen in the log; -1 when none. */
export function maxTurnNumber(events: readonly SessionEvent[]): number {
  let max = -1;
  for (const ev of events) {
    if (ev.type !== "turn_start" && ev.type !== "turn_end") continue;
    const n = parseTurnNumber(ev.id);
    if (n !== null && n > max) max = n;
  }
  return max;
}

/** The next id the log would allocate. */
export function nextTurnId(events: readonly SessionEvent[]): string {
  return formatTurnId(nextTurnNumber(events));
}

/**
 * Rust `next_turn_number` (persistent.rs:391-402): max `turn-<n>` in the log
 * plus one, or 0 when the log holds no such id. Legacy ids (e.g. `"t1"`) are
 * ignored, so a replayed counter never collides with an id already on disk.
 */
export function nextTurnNumber(events: readonly SessionEvent[]): number {
  return maxTurnNumber(events) + 1;
}

export interface TurnIdAudit {
  ids: string[];
  nonMonotonic: Array<{ index: number; previous: string; current: string }>;
  duplicates: string[];
  malformed: string[];
}

/** Verify the monotonicity + uniqueness contract of turn_start ids. */
export function auditTurnIds(events: readonly SessionEvent[]): TurnIdAudit {
  const ids: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const malformed: string[] = [];
  const nonMonotonic: Array<{ index: number; previous: string; current: string }> = [];
  let previous = -1;
  let previousId = "";

  for (const ev of events) {
    if (ev.type !== "turn_start") continue;
    ids.push(ev.id);
    if (seen.has(ev.id)) duplicates.push(ev.id);
    seen.add(ev.id);
    const n = parseTurnNumber(ev.id);
    if (n === null) {
      malformed.push(ev.id);
      continue;
    }
    if (n <= previous) {
      nonMonotonic.push({ index: ids.length - 1, previous: previousId, current: ev.id });
    }
    previous = n;
    previousId = ev.id;
  }
  return { ids, nonMonotonic, duplicates, malformed };
}
