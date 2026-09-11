/**
 * The boot decision table of §1.2.3, as one pure function over an OPEN log.
 *
 *   checkpoint         | log                        | action
 *   -------------------|----------------------------|-------------------------------
 *   missing            | dangling turn_start        | NOTHING (may be another writer)
 *   invalid / foreign  | anything                   | NOTHING + observation
 *   clean_shutdown     | anything                   | NOTHING (a clean exit is not a crash)
 *   open_turn = null   | dangling (legacy/another)  | NOTHING (not ours to close)
 *   open_turn = turn-N | no turn_start turn-N      | NOTHING (log cleared/rotated)
 *   open_turn = turn-N | turn_start + turn_end     | clear open_turn only (idempotent)
 *   open_turn = turn-N | turn_start, no turn_end   | APPEND turn_end:interrupted
 *
 * The repair is triggered by a DOUBLE SIGNATURE — the checkpoint says a turn was
 * open AND the log actually holds that `turn_start` without its `turn_end` — so
 * it can never append a row the engine would not have written itself (K4: the
 * log is append-only, and every synthesized row is a legal `TurnOutcome`).
 *
 * Idempotence: the second boot sees the `turn_end` its predecessor appended, so
 * it takes the "clear open_turn only" row and appends nothing (A2).
 */

import type { SessionEvent, SessionLog } from "@celestea/core";
import { CheckpointStore } from "./checkpoint.js";

export type RecoveryAction =
  | "closed_turn"
  | "cleared_open_turn"
  | "skipped_no_checkpoint"
  | "skipped_invalid_checkpoint"
  | "skipped_clean_shutdown"
  | "skipped_untracked"
  | "skipped_no_signature";

export interface RecoveryOutcome {
  action: RecoveryAction;
  /** The turn the checkpoint named (null when there was none). */
  turn_id: string | null;
  /** True only for [RecoveryAction.closed_turn]: exactly ONE row was appended. */
  appended: boolean;
  dangling_before: string[];
  dangling_after: string[];
  /** Fail-safe observations (ignored checkpoint, failed sidecar write). */
  warnings: string[];
}

/** `turn_start` ids that have no matching `turn_end` (crash residue, G1-1). */
export function danglingTurnIds(events: readonly SessionEvent[]): string[] {
  const started: string[] = [];
  const closed = new Set<string>();
  for (const ev of events) {
    if (ev.type === "turn_start") started.push(ev.id);
    else if (ev.type === "turn_end") closed.add(ev.id);
  }
  return started.filter((id) => !closed.has(id));
}

/** Everything an outcome is made of (one object: the rule caps the parameters). */
interface OutcomeParts {
  action: RecoveryAction;
  turnId: string | null;
  appended: boolean;
  before: string[];
  after: string[];
  warnings: string[];
}

function outcomeOf(parts: OutcomeParts): RecoveryOutcome {
  return {
    action: parts.action,
    turn_id: parts.turnId,
    appended: parts.appended,
    dangling_before: parts.before,
    dangling_after: parts.after,
    warnings: parts.warnings,
  };
}

/** Decide + repair ONE session. Never throws, never rewrites an existing row. */
export function recoverOpenTurn(log: SessionLog, store: CheckpointStore): RecoveryOutcome {
  const read = store.load();
  const before = danglingTurnIds(log.events());
  const skip = (action: RecoveryAction, turnId: string | null = null): RecoveryOutcome =>
    outcomeOf({ action, turnId, appended: false, before, after: before, warnings: store.warnings() });
  if (read.kind === "missing") return skip("skipped_no_checkpoint");
  if (read.kind === "invalid") return skip("skipped_invalid_checkpoint");
  if (read.value.clean_shutdown) return skip("skipped_clean_shutdown");
  const open = read.value.open_turn;
  if (open === null) return skip("skipped_untracked");
  const events = log.events();
  if (!events.some((ev) => ev.type === "turn_start" && ev.id === open.id)) return skip("skipped_no_signature", open.id);
  if (events.some((ev) => ev.type === "turn_end" && ev.id === open.id)) {
    store.clearOpenTurn(); // the previous boot already repaired it: nothing to append
    return outcomeOf({ action: "cleared_open_turn", turnId: open.id, appended: false, before, after: before, warnings: store.warnings() });
  }
  log.append({ type: "turn_end", id: open.id, outcome: "interrupted" });
  store.recordSynthesizedTurnEnd(open.id);
  return outcomeOf({ action: "closed_turn", turnId: open.id, appended: true, before, after: danglingTurnIds(log.events()), warnings: store.warnings() });
}
