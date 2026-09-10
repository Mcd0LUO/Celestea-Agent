/**
 * Compaction planning — port of `celestea_studio/src/compact.rs:60-190`.
 *
 * The plan is a pure function of (events, summary, keep):
 *   1. split the log into COMPLETE turns (`turn_start ..= turn_end`); an
 *      unterminated tail and everything before the first `turn_start` are
 *      dropped — only a closed turn may enter the new log;
 *   2. refuse to compact at or below [COMPACT_THRESHOLD] complete turns;
 *   3. new log = one synthetic head turn (turn-1: the summary) + the last K
 *      complete turns, renumbered turn-2..turn-(K+1) but otherwise byte-identical
 *      (tool / thinking rows stay inside their turn, the outcome is preserved).
 *
 * The `turn-<n>` prefix is the engine-native turn id: `PersistentSessionLog`
 * only recognises that prefix when it restores its counter, so renumbering is
 * what keeps the next live turn id from colliding with what is on disk.
 */

import type { SessionEvent } from "@celestea/core";
import { clip, SUMMARY_KEEP_MAX_CHARS } from "./transcript.js";

/** Complete turns at or below this count are "not enough history" to compact. */
export const COMPACT_THRESHOLD = 8;
/** How many most-recent complete turns survive a compaction. */
export const COMPACT_KEEP_TURNS = 4;
/** Head turn user message prefix (the summary is appended verbatim). */
export const COMPACT_HEAD_PREFIX = "【上下文压缩】";
/** Head turn assistant message (fixed text, not model-generated). */
export const COMPACT_HEAD_ASSISTANT = "上下文已压缩，以上为历史摘要。";
/** Note of the "nothing to do" branch. */
export const COMPACT_NOTE_SKIPPED = "历史不足，无需压缩";

/** Note of the compacted branch (`已压缩：摘要轮 + 最近K轮`). */
export function compactNote(keep: number): string {
  return `已压缩：摘要轮 + 最近${keep}轮`;
}

/** Engine-native turn id (`turn-<n>`). */
export function compactTurnId(n: number): string {
  return `turn-${n}`;
}

/**
 * Cut the event stream into complete turns. A repeated/nested `turn_start`
 * discards the previous unterminated fragment; rows before the first
 * `turn_start` are dropped.
 */
export function splitCompleteTurns(events: readonly SessionEvent[]): SessionEvent[][] {
  const turns: SessionEvent[][] = [];
  let current: SessionEvent[] | null = null;
  for (const ev of events) {
    if (ev.type === "turn_start") {
      current = [ev];
      continue;
    }
    if (current === null) continue; // orphan before the first turn_start
    current.push(ev);
    if (ev.type === "turn_end") {
      turns.push(current);
      current = null;
    }
  }
  return turns;
}

/** Number of complete turns (the threshold predicate). */
export function countCompleteTurns(events: readonly SessionEvent[]): number {
  return splitCompleteTurns(events).length;
}

/**
 * Replace a turn's boundary ids with `id`; every other row is copied verbatim,
 * including the terminal outcome (renumbering is not a semantic rewrite).
 */
export function renumberTurn(turn: readonly SessionEvent[], id: string): SessionEvent[] {
  return turn.map((ev) => {
    if (ev.type === "turn_start") return { type: "turn_start", id };
    if (ev.type === "turn_end") return { type: "turn_end", id, ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }) };
    return ev;
  });
}

/** The complete turns a compaction with `keep` preserves (never empty). */
export function keptTurns(events: readonly SessionEvent[], keep: number): SessionEvent[][] {
  const turns = splitCompleteTurns(events);
  const k = Math.max(1, Math.min(keep, turns.length));
  return turns.slice(turns.length - k);
}

/**
 * The post-compaction event list, or null when the log is at/below the
 * threshold (nothing to compact). `keep` is clamped to `[1, turn count]`.
 */
export function planCompaction(events: readonly SessionEvent[], summary: string, keep: number): SessionEvent[] | null {
  if (countCompleteTurns(events) <= COMPACT_THRESHOLD) return null;
  const head = compactTurnId(1);
  const out: SessionEvent[] = [
    { type: "turn_start", id: head },
    { type: "user_message", text: `${COMPACT_HEAD_PREFIX}${clip(summary.trim(), SUMMARY_KEEP_MAX_CHARS)}` },
    { type: "assistant_message", text: COMPACT_HEAD_ASSISTANT },
    { type: "turn_end", id: head, outcome: "completed" },
  ];
  keptTurns(events, keep).forEach((turn, i) => out.push(...renumberTurn(turn, compactTurnId(i + 2))));
  return out;
}
