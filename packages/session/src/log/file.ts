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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEvent, type SessionEvent } from "@celestea/core";

export interface TornRecord {
  /** 1-based line number of the first unparsable record. */
  line: number;
  /** Byte offset the record starts at. */
  offset: number;
  raw: string;
  error: string;
}

export interface ReplayFileResult {
  events: SessionEvent[];
  /** Byte length of the valid prefix (what the caller truncates to). */
  validBytes: number;
  /** True when an unparsable record followed the valid prefix. */
  truncated: boolean;
  torn: TornRecord | null;
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

/** Replay a JSONL file line by line, keeping the longest valid prefix. */
export function replayFile(path: string): ReplayFileResult {
  const events: SessionEvent[] = [];
  if (!existsSync(path)) return { events, validBytes: 0, truncated: false, torn: null };

  const buf = readFileSync(path);
  let offset = 0;
  let validBytes = 0;
  let lineNumber = 0;

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
        truncated: true,
        torn: { line: lineNumber, offset: start, raw: record.toString("utf8"), error: parsed.errors.join("; ") },
      };
    }
    events.push(parsed.event);
    validBytes = offset;
  }

  return { events, validBytes, truncated: false, torn: null };
}
