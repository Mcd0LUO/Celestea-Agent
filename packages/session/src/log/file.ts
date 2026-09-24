/**
 * cli-main.jsonl file-level replay — port of
 * `crates/session/src/persistent.rs:282-402`.
 *
 * Contract:
 *   - `file_name_for` sanitizes a session id (only `[A-Za-z0-9._-]` survive) so
 *     a caller-supplied id can never escape the session directory;
 *   - replay keeps the LONGEST VALID PREFIX: blank lines are harmless padding,
 *     and everything from the first unparsable record (a torn tail left by a
 *     crash mid-write) is truncated away — a half record is never replayed;
 *   - a file whose last record has no terminating newline is repaired before
 *     the next append, otherwise the next record would merge into it.
 *
 * Rotation (P0-2, W1503): the append-only log is bounded by rolling the WHOLE
 * file to `<path>.<n>` once it reaches [SESSION_LOG_MAX_BYTES] — the trigger
 * semantics of the usage-ledger precedent (`packages/runtime/src/ledger.ts`):
 * the size is checked BEFORE the write and the roll is a whole-file rename, so
 * every rolled segment is a COMPLETE PREFIX of the stream and a torn segment is
 * never rolled. Reading the segments in order therefore yields exactly the byte
 * stream a never-rotated log would have had.
 *
 * WHY generations instead of the ledger's single replaced `.1`: the ledger and
 * the three audit logs that use it are OBSERVATION logs — losing the oldest
 * segment costs a diagnostic, never a fact. This file is the SOURCE OF TRUTH
 * for the model-visible history, so replacing `.1` on every roll would delete
 * the start of the conversation: after two rolls the projection would differ
 * from a never-rotated log by everything before the second-to-last segment.
 * Generation names (`.1`, `.2`, …) are the same mechanism without that loss;
 * the first roll is byte-for-byte the ledger's `.1`, and the reader is what
 * changes (all segments, oldest first).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSessionEvent, type SessionEvent } from "@celestea/core";

/**
 * Rotation threshold: before a write, a session log at or above this size is
 * rolled to a fresh segment and the next write recreates the current file.
 *
 * 16 MiB is chosen to be the SAME order as the ledger precedent
 * (`USAGE_LEDGER_MAX_BYTES`, 16 MiB, W785 §3.3 P1 ④) and the three audit logs
 * that already rotate at 16 MiB (grants-audit / recovery-audit / fallback-host):
 * one number to remember for "an append-only audit file", never a durability
 * boundary — every rolled segment keeps every row it had. The scale is not
 * copied from the ledger: the real session log grows at 2.76 MB/h / 275 KB/turn
 * (W1502 §2), so 16 MiB is ~6 h / ~60 turns of active conversation — large
 * enough that a normal session never pays for a second segment, small enough
 * that the O(file) readers (studio `messages()`, boot replay) stay in the tens
 * of milliseconds instead of the ~800 ms measured at 100 MB.
 */
export const SESSION_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** Separator before a rolled segment's generation number (`cli-main.jsonl.1`). */
export const SESSION_LOG_SEGMENT_SEPARATOR = ".";

export interface TornRecord {
  /** 1-based line number of the first unparsable record (across the segments). */
  line: number;
  /** Byte offset the record starts at, relative to its own segment. */
  offset: number;
  raw: string;
  error: string;
}

export interface ReplayFileResult {
  events: SessionEvent[];
  /**
   * Byte length of the valid prefix of the segment the replay stopped in — the
   * torn segment ([tornSegment]), or the last existing segment when nothing was
   * torn. SEGMENT-relative, because that is what the caller truncates: a torn
   * segment is repaired at its own valid prefix, never at another file's.
   */
  validBytes: number;
  /** True when an unparsable record followed the valid prefix. */
  truncated: boolean;
  torn: TornRecord | null;
  /** Index into the replayed paths of the segment holding the tear (null = clean). */
  tornSegment: number | null;
}

/** Map a session id to a safe file name (`file_name_for`). */
export function fileNameFor(sessionId: string): string {
  let name = "";
  for (const ch of sessionId) name += /^[A-Za-z0-9._-]$/.test(ch) ? ch : "_";
  if (name === "") name = "session";
  return `${name}.jsonl`;
}

/** The JSONL path used for a session id under a directory (`file_path`). */
export function filePathFor(dir: string, sessionId: string): string {
  return join(dir, fileNameFor(sessionId));
}

/** Strip one trailing `\n` and an optional `\r` (`trim_line_end`). */
export function trimLineEnd(line: Buffer): Buffer {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end -= 1;
  if (end > 0 && line[end - 1] === 0x0d) end -= 1;
  return line.subarray(0, end);
}

/**
 * True when the file is non-empty and its last byte is not a newline — only a
 * hand-crafted/corrupt file can be in this state (`file_lacks_final_newline`).
 */
export function fileLacksFinalNewline(path: string): boolean {
  if (!existsSync(path)) return false;
  const buf = readFileSync(path);
  if (buf.length === 0) return false;
  return buf[buf.length - 1] !== 0x0a;
}

/**
 * The generation number of a rolled segment file name, or null when `name` is
 * not one. Only `<base>.<digits>` counts: `cli-main.jsonl.precompact`,
 * `cli-main.jsonl.tmp-1234` and every other sibling are NOT segments.
 */
export function segmentNumberFor(base: string, name: string): number | null {
  const prefix = `${base}${SESSION_LOG_SEGMENT_SEPARATOR}`;
  if (!name.startsWith(prefix)) return null;
  const digits = name.slice(prefix.length);
  if (!/^[0-9]+$/.test(digits)) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The rolled segments of `path`, oldest generation first (missing dir -> none). */
export function rolledPathsFor(path: string): string[] {
  const dir = dirname(path);
  const base = basename(path);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const numbered: Array<{ generation: number; path: string }> = [];
  for (const name of names) {
    const generation = segmentNumberFor(base, name);
    if (generation !== null) numbered.push({ generation, path: join(dir, name) });
  }
  numbered.sort((a, b) => a.generation - b.generation);
  return numbered.map((entry) => entry.path);
}

/** The ordered segments of `path`: every rolled segment, then the current file. */
export function segmentPathsFor(path: string): string[] {
  return [...rolledPathsFor(path), path];
}

/** The path the NEXT roll of `path` writes (one generation above the newest). */
export function nextRolledPathFor(path: string): string {
  const rolled = rolledPathsFor(path);
  const newest = rolled[rolled.length - 1];
  const generation = newest === undefined ? 0 : (segmentNumberFor(basename(path), basename(newest)) ?? 0);
  return `${path}${SESSION_LOG_SEGMENT_SEPARATOR}${generation + 1}`;
}

/**
 * Replay the log at `path`: every rolled segment first (oldest first), then the
 * current file, keeping the longest valid prefix across all of them.
 *
 * With no segment this is byte-for-byte the single-file replay it has always
 * been. With segments, the concatenation IS the pre-rotation stream (a roll is
 * a whole-file rename, so no byte is lost or reordered), so the projection is
 * identical to a never-rotated log — that equivalence is the whole point of
 * rotating at a write boundary instead of splitting the stream.
 *
 * A tear is only possible at the END of the last existing segment: an earlier
 * segment was renamed whole by a previous generation of the process, and the
 * current file is the one being appended to. Even then the replay stops there,
 * exactly as the single-file replay stopped at its own torn tail.
 */
export function replayFile(path: string): ReplayFileResult {
  return replaySegments(segmentPathsFor(path));
}

/** Replay `paths` in order, keeping the longest valid prefix across the parts. */
export function replaySegments(paths: readonly string[]): ReplayFileResult {
  const events: SessionEvent[] = [];
  let validBytes = 0;
  let lineNumber = 0;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined || !existsSync(path)) continue;
    const part = replayBuffer(readFileSync(path), lineNumber);
    events.push(...part.events);
    if (part.truncated) {
      return { events, validBytes: part.validBytes, truncated: true, torn: part.torn, tornSegment: index };
    }
    validBytes = part.validBytes;
    // ACCUMULATE: the reported line of a tear is the position in the whole
    // logical stream, not the position inside its own segment.
    lineNumber += part.lineCount;
  }
  return { events, validBytes, truncated: false, torn: null, tornSegment: null };
}

interface SegmentReplay {
  events: SessionEvent[];
  /** Byte length of the segment's valid prefix (relative to the segment). */
  validBytes: number;
  /** Physical lines the segment holds (torn line included). */
  lineCount: number;
  truncated: boolean;
  torn: TornRecord | null;
}

/** Replay ONE segment; `firstLine` is the 1-based line number it starts at. */
function replayBuffer(buf: Buffer, firstLine: number): SegmentReplay {
  const events: SessionEvent[] = [];
  let offset = 0;
  let validBytes = 0;
  let lineNumber = firstLine;

  while (offset < buf.length) {
    const newline = buf.indexOf(0x0a, offset);
    const end = newline === -1 ? buf.length : newline + 1;
    const start = offset;
    offset = end;
    lineNumber += 1;

    const record = trimLineEnd(buf.subarray(start, end));
    if (record.length === 0) {
      // Blank line: harmless padding, part of the valid region.
      validBytes = offset;
      continue;
    }
    const parsed = parseSessionEvent(record.toString("utf8"));
    if (!parsed.ok) {
      return {
        events,
        validBytes,
        lineCount: lineNumber - firstLine,
        truncated: true,
        torn: { line: lineNumber, offset: start, raw: record.toString("utf8"), error: parsed.errors.join("; ") },
      };
    }
    events.push(parsed.event);
    validBytes = offset;
  }

  return { events, validBytes, lineCount: lineNumber - firstLine, truncated: false, torn: null };
}
