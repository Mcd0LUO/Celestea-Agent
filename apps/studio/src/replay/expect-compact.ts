/**
 * INDEPENDENT re-derivation of the frozen compaction plan (W259).
 *
 * This is deliberately a SECOND implementation: the runtime's planner lives in
 * `packages/runtime/src/compact/plan.ts` (written as a straight port of
 * `celestea_studio/src/compact.rs`), while this one is written from the spec text
 * with a different shape (index scan + slice, no helper reuse). A P5 comparison
 * between the two is therefore a cross-implementation check of the STRUCTURE
 * (head turn, kept-tail selection, renumbering, dropping an unterminated tail),
 * not a tautology.
 *
 * The summary string is passed in (the replay reads it back out of the compacted
 * log), so the summary itself is out of scope for this comparison.
 */

import type { SessionEvent } from "@celestea/core";

export const SPEC_THRESHOLD = 8;
export const SPEC_KEEP = 4;
export const SPEC_HEAD_PREFIX = "【上下文压缩】";
export const SPEC_HEAD_ASSISTANT = "上下文已压缩，以上为历史摘要。";

/** Index ranges [start, end) of every complete turn (`turn_start` .. `turn_end`). */
export function completeTurnRanges(events: readonly SessionEvent[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === "turn_start") {
      start = i;
      continue;
    }
    if (ev.type === "turn_end" && start >= 0) {
      ranges.push([start, i + 1]);
      start = -1;
    }
  }
  return ranges;
}

/** The expected post-compaction log, or null when the history is too short. */
export function expectedCompactLog(events: readonly SessionEvent[], summary: string, keep = SPEC_KEEP): SessionEvent[] | null {
  const ranges = completeTurnRanges(events);
  if (ranges.length <= SPEC_THRESHOLD) return null;
  const kept = ranges.slice(Math.max(0, ranges.length - Math.max(1, Math.min(keep, ranges.length))));
  const out: SessionEvent[] = [
    { type: "turn_start", id: "turn-1" },
    { type: "user_message", text: `${SPEC_HEAD_PREFIX}${summary}` },
    { type: "assistant_message", text: SPEC_HEAD_ASSISTANT },
    { type: "turn_end", id: "turn-1", outcome: "completed" },
  ];
  kept.forEach(([from, to], i) => {
    const id = `turn-${i + 2}`;
    for (const ev of events.slice(from, to)) {
      if (ev.type === "turn_start") out.push({ type: "turn_start", id });
      else if (ev.type === "turn_end") out.push({ type: "turn_end", id, ...(ev.outcome === undefined ? {} : { outcome: ev.outcome }) });
      else out.push(ev);
    }
  });
  return out;
}

/** The inner (non-boundary) rows of a turn: what renumbering must NOT touch. */
export function turnBody(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((ev) => ev.type !== "turn_start" && ev.type !== "turn_end");
}

/** Split a serialized log into one entry per complete turn (raw text lines). */
export function rawTurnBodies(text: string, parse: (t: string) => { events: SessionEvent[] }): string[][] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const events = parse(text).events;
  const bodies: string[][] = [];
  let current: string[] | null = null;
  events.forEach((ev, i) => {
    if (ev.type === "turn_start") current = [];
    else if (ev.type === "turn_end") {
      if (current !== null) bodies.push(current);
      current = null;
    } else if (current !== null) current.push(lines[i] ?? "");
  });
  return bodies;
}

/** The summary text embedded in a compacted log's head turn (null when absent). */
export function headSummary(events: readonly SessionEvent[]): string | null {
  const head = events.find((ev) => ev.type === "user_message" && ev.text.startsWith(SPEC_HEAD_PREFIX));
  return head === undefined || head.type !== "user_message" ? null : head.text.slice(SPEC_HEAD_PREFIX.length);
}
