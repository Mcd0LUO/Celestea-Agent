/**
 * Compaction orchestration (port of `celestea_studio/src/compact.rs:410-500`).
 *
 * One call is: read -> parse -> threshold -> summarize -> plan -> atomic rewrite.
 * Every branch is explicit and observable, because the HTTP layer has to answer
 * three different ways:
 *   - `compacted:false` (at/below [COMPACT_THRESHOLD] complete turns) is a
 *     NORMAL 200 with the frozen "历史不足，无需压缩" note;
 *   - `compacted:true` carries `kept_turns` and the "已压缩…" note;
 *   - a read/summary/write failure throws — the caller turns it into a 500 with
 *     the message (never a silent no-op that left the log untouched).
 *
 * Parsing mirrors the host's `parse_session_jsonl`: blank lines are padding and
 * parsing STOPS at the first unparsable record (a torn tail is not content).
 */

import { readFileSync } from "node:fs";
import { parseSessionEvent, type SessionEvent } from "@celestea/core";
import { COMPACT_KEEP_TURNS, COMPACT_NOTE_SKIPPED, compactNote, countCompleteTurns, planCompaction } from "./plan.js";
import { rewriteAtomic } from "./rewrite.js";
import type { Summarizer } from "./summarize.js";
import { renderTranscript } from "./transcript.js";

export interface CompactionInput {
  /** Absolute path of the session log (`<session dir>/cli-main.jsonl`). */
  logPath: string;
  summarize: Summarizer;
  /** Surviving complete turns (default [COMPACT_KEEP_TURNS]). */
  keep?: number;
  /** Injection seams for tests (defaults: real fs). */
  readText?: (path: string) => string;
  write?: (path: string, events: readonly SessionEvent[]) => void;
}

export interface CompactionResult {
  compacted: boolean;
  /** Present (as a number) only when `compacted === true`. */
  kept_turns: number | null;
  note: string;
  /** Complete turns found in the log BEFORE the decision. */
  turns_before: number;
  /** The new event list, or null when nothing was compacted. */
  events: SessionEvent[] | null;
}

/** JSONL text -> events; blank lines are padding, a torn tail stops parsing. */
export function parseEventLog(text: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parseSessionEvent(line.trim());
    if (!parsed.ok) break;
    events.push(parsed.event);
  }
  return events;
}

function readLog(input: CompactionInput): string {
  try {
    return (input.readText ?? ((p: string): string => readFileSync(p, "utf8")))(input.logPath);
  } catch (e) {
    throw new Error(`读取会话日志失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Run one compaction. Throws on read/summarize/write failure; returns the
 * skipped branch when the history is too short to be worth a summary request.
 */
export async function runCompaction(input: CompactionInput): Promise<CompactionResult> {
  const keep = input.keep ?? COMPACT_KEEP_TURNS;
  const events = parseEventLog(readLog(input));
  const turns = countCompleteTurns(events);
  if (turns <= 0 || planCompaction(events, "", keep) === null) {
    return { compacted: false, kept_turns: null, note: COMPACT_NOTE_SKIPPED, turns_before: turns, events: null };
  }
  const summary = await input.summarize(renderTranscript(events));
  const planned = planCompaction(events, summary, keep);
  if (planned === null) throw new Error("内部错误：压缩计划为空");
  (input.write ?? rewriteAtomic)(input.logPath, planned);
  return { compacted: true, kept_turns: Math.min(keep, turns), note: compactNote(keep), turns_before: turns, events: planned };
}
