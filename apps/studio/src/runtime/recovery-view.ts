/**
 * `GET /api/status.recovery` (E §1.3 P1 ②) — the LIVE view of one session's
 * checkpoint, appended to an existing endpoint (P1 adds no endpoint).
 *
 * Every field answers a question the operator could otherwise only answer by
 * reading two files by hand:
 *
 *   - `recovered_turns` — which turns THIS engine had to close after a crash
 *     (the sidecar's `repaired[]`, the durable record of R1-1);
 *   - `dangling_turns`  — how many turns the LOG leaves open right now. It is a
 *     judgement about the log (K4: the log is the truth), so it is counted from
 *     the events, using the same rule as `analyzeReplay().danglingTurns`;
 *   - `degraded`        — the log and the disk forked (`writeErrorCount>0`, G1-6);
 *   - `last_outcome`    — the phase of the LAST `turn_end` in the log, which is
 *     what "was the previous turn interrupted?" really asks.
 *
 * Nothing here composes an instance: a session with no live generation reports
 * the empty block (zeros, no turns) rather than waking an engine for a poll.
 */

import { outcomePhase, type SessionEvent, type SessionLog } from "@celestea/core";
import { checkpointStoreOf, writeErrorCountOf } from "@celestea/session";

/** The `recovery` block of `/api/status` (a pure addition, always present). */
export interface RecoveryView {
  session: string | null;
  /** Turn ids this engine closed after a crash (`checkpoint.repaired[]`). */
  recovered_turns: string[];
  /** `turn_start` rows without a `turn_end` right now. */
  dangling_turns: number;
  /** True when the session log has refused a write (disk ≠ memory). */
  degraded: boolean;
  /** Phase of the log's last `turn_end` (null = the log has no closed turn). */
  last_outcome: string | null;
}

/** The empty block: no live instance, no checkpoint, no log. */
export function emptyRecoveryView(session: string | null): RecoveryView {
  return { session, recovered_turns: [], dangling_turns: 0, degraded: false, last_outcome: null };
}

/** Build the block from the session's LIVE log (a checkpointed one, normally). */
export function recoveryViewOf(log: SessionLog | null | undefined, session: string | null): RecoveryView {
  if (log === null || log === undefined) return emptyRecoveryView(session);
  const events = log.events();
  const store = checkpointStoreOf(log);
  const checkpoint = store?.load() ?? null;
  const repaired = checkpoint !== null && checkpoint.kind === "ok" ? checkpoint.value.repaired : [];
  return {
    session,
    recovered_turns: repaired.map((r) => r.turn_id),
    dangling_turns: danglingOf(events),
    // The LIVE counter wins over the sampled one: it is the same number the log
    // itself reports right now, and a sticky `>0` in the sidecar keeps a past
    // fork visible even after a healthy restart (which is intended).
    degraded: writeErrorCountOf(log) > 0 || (checkpoint !== null && checkpoint.kind === "ok" && checkpoint.value.degraded.log_write_errors > 0),
    last_outcome: lastOutcomeOf(events),
  };
}

/** `turn_start` minus `turn_end` — the rule of `analyzeReplay().danglingTurns`. */
function danglingOf(events: readonly SessionEvent[]): number {
  let open = 0;
  for (const event of events) {
    if (event.type === "turn_start") open += 1;
    else if (event.type === "turn_end") open -= 1;
  }
  return Math.max(0, open);
}

function lastOutcomeOf(events: readonly SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && event.type === "turn_end") return outcomePhase(event.outcome);
  }
  return null;
}
