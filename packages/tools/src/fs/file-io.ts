/**
 * File IO for `read_file` / `write_file` / `list_dir`, with the two protections
 * the tool contract promises: **truncation** (a bounded read keeps a huge file
 * from flooding the context) and **binary protection** (a NUL-bearing file is
 * rejected instead of being decoded into mojibake).
 *
 * The guard already arbitrated *where* the path may point; this module only
 * performs the IO and reports structured failures (`<tool>: code=… msg="…"`).
 */

import { open, readdir, writeFile } from "node:fs/promises";

import { contractError } from "../errors.js";
import { ToolFailure } from "../tool-failure.js";

/** Bytes returned by one `read_file` call (beyond this: `truncated`). */
export const MAX_READ_BYTES = 256 * 1024;
/** Entry names returned by one `list_dir` call. */
export const MAX_DIR_ENTRIES = 1000;
/** Window inspected for the binary heuristic. */
export const BINARY_SNIFF_BYTES = 8192;
/** Default `limit` (lines) for a paged `read_file` when only `offset` is given. */
export const DEFAULT_READ_LIMIT = 2000;
/** Bytes read per streaming chunk by `readTextLines`. */
const READ_CHUNK_BYTES = 64 * 1024;

export interface ReadTextResult {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/** One line-window read (`read_file` pagination, W846). */
export interface ReadTextLinesResult {
  /** Byte-exact window: start of `offset` through the end of the last captured line. */
  text: string;
  /** Effective 0-based first line (clamped to the file). */
  offset: number;
  /** Effective line budget. */
  limit: number;
  /** Lines in `text`. */
  lineCount: number;
  /** Total lines in the file (requires a scan to EOF). */
  totalLines: number;
  /** `offset + lineCount < totalLines`. */
  hasMore: boolean;
  /** First line after the window when `hasMore`, else null. */
  nextOffset: number | null;
  /** The 256 KiB byte budget clipped the window before `limit` lines. */
  truncated: boolean;
  /** File size in bytes. */
  totalBytes: number;
}

export interface ListDirResult {
  names: string[];
  truncated: boolean;
  total: number;
}

/** NUL byte inside the sniff window ⇒ binary (the classic, cheap heuristic). */
export function isProbablyBinary(bytes: Buffer): boolean {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}

export async function readTextFile(path: string): Promise<ReadTextResult> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    throw ioFailure("read_file", "io", describe(e));
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw ioFailure("read_file", "io", `'${path}' is a directory, not a file`);
    const wanted = Math.min(MAX_READ_BYTES + 1, Math.max(stat.size, 1));
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (isProbablyBinary(bytes)) {
      throw ioFailure("read_file", "binary_file", `'${path}' looks binary (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes)`);
    }
    const truncated = bytesRead > MAX_READ_BYTES || stat.size > MAX_READ_BYTES;
    return { text: bytes.subarray(0, MAX_READ_BYTES).toString("utf8"), truncated, totalBytes: stat.size };
  } catch (e) {
    throw e instanceof ToolFailure ? e : ioFailure("read_file", "io", describe(e));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Accumulates one line window under the byte budget (read_file pagination). */
class LineWindow {
  private readonly captured: Buffer[] = [];
  private capturedBytes = 0;
  private readonly offset: number;
  private readonly limit: number;
  lineCount = 0;
  totalLines = 0;
  truncated = false;

  constructor(offset: number, limit: number) {
    this.offset = offset;
    this.limit = limit;
  }

  /** Admit one line unit (its bytes including the trailing `\n`, when present). */
  admit(unit: Buffer): void {
    this.totalLines += 1;
    const index = this.totalLines - 1;
    if (index < this.offset || this.lineCount >= this.limit || this.truncated) return;
    if (this.capturedBytes + unit.length <= MAX_READ_BYTES) {
      this.captured.push(unit);
      this.capturedBytes += unit.length;
      this.lineCount += 1;
      return;
    }
    if (this.lineCount === 0) {
      const prefix = utf8WholePrefix(unit, MAX_READ_BYTES);
      if (prefix.length > 0) {
        this.captured.push(prefix);
        this.capturedBytes += prefix.length;
        this.lineCount += 1;
      }
    }
    this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.captured).toString("utf8");
  }
}

/**
 * Feed one buffered chunk through the window; complete line units go to
 * `admit`, the unterminated tail is returned as the carry. A tail larger than
 * the budget with no terminator is itself an over-budget line: admit it and
 * flag that the remainder of the line is discarded.
 */
function drainUnits(data: Buffer, window: LineWindow, state: { discarding: boolean }): Buffer {
  let start = 0;
  for (;;) {
    const nl = data.indexOf(0x0a, start);
    if (nl === -1) break;
    if (state.discarding) state.discarding = false; // this terminator closes the over-budget line
    else window.admit(data.subarray(start, nl + 1));
    start = nl + 1;
  }
  let tail = data.subarray(start);
  if (!state.discarding && tail.length > MAX_READ_BYTES) {
    window.admit(tail);
    state.discarding = true;
    tail = Buffer.alloc(0);
  }
  return tail;
}

/**
 * Line-window read for `read_file` pagination (W846).
 *
 * A SINGLE streaming pass from byte 0: `readTextFile` only ever returns the
 * first MAX_READ_BYTES from offset 0, so an `offset` past that window needs its
 * own reader. The window itself is bounded by MAX_READ_BYTES; `totalLines`
 * costs a scan to EOF (O(file size)) and is the price of exact
 * `hasMore`/`nextOffset`. `truncated` means the byte budget clipped the window
 * before `limit` lines; a line larger than the budget is returned as a
 * UTF-8-safe prefix and `nextOffset` skips past it (use run_shell for such a
 * pathological line).
 */
export async function readTextLines(path: string, offset: number, limit: number): Promise<ReadTextLinesResult> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    throw ioFailure("read_file", "io", describe(e));
  }
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw ioFailure("read_file", "io", `'${path}' is a directory, not a file`);
    const totalBytes = stat.size;
    // Binary protection first: a NUL in the sniff window rejects before windowing.
    const sniffLen = Math.min(BINARY_SNIFF_BYTES, totalBytes);
    if (sniffLen > 0) {
      const sniff = Buffer.alloc(sniffLen);
      const { bytesRead } = await handle.read(sniff, 0, sniffLen, 0);
      if (isProbablyBinary(sniff.subarray(0, bytesRead))) {
        throw ioFailure("read_file", "binary_file", `'${path}' looks binary (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes)`);
      }
    }
    const window = new LineWindow(offset, limit);
    const state = { discarding: false };
    let position = 0;
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      carry = drainUnits(data, window, state);
    }
    if (carry.length > 0 && !state.discarding) window.admit(carry);
    const hasMore = window.totalLines > offset + window.lineCount;
    return {
      text: window.text(),
      offset,
      limit,
      lineCount: window.lineCount,
      totalLines: window.totalLines,
      hasMore,
      nextOffset: hasMore ? offset + window.lineCount : null,
      truncated: window.truncated,
      totalBytes,
    };
  } catch (e) {
    throw e instanceof ToolFailure ? e : ioFailure("read_file", "io", describe(e));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Longest prefix of `buf` no longer than `max` that ends on a UTF-8 boundary. */
function utf8WholePrefix(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, "utf8");
  } catch (e) {
    throw ioFailure("write_file", "io", describe(e));
  }
}

export async function listDirNames(path: string): Promise<ListDirResult> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (e) {
    throw ioFailure("list_dir", "io", describe(e));
  }
  entries.sort();
  return { names: entries.slice(0, MAX_DIR_ENTRIES), truncated: entries.length > MAX_DIR_ENTRIES, total: entries.length };
}

/**
 * The authored omission note (W855).
 *
 * Discipline: this note — and every `truncated` flag it accompanies — means THE
 * BUDGET kept obtainable content out. An upstream that returned an incomplete
 * body is a different fact and keeps its own domain field; it must never be
 * described by this note.
 *
 * The omission is ALWAYS paired with a retrieval instruction (`retrieve`), so
 * the model is never told "there was more" without being told how to get it.
 */
export function truncationNote(
  what: string,
  shown: number,
  total: number,
  unit: string,
  retrieve: string,
): string {
  const base = "[truncated] " + what + ": showing first " + String(shown) + " of " + String(total) + " " + unit + " (budget)";
  return retrieve === "" ? base : base + "; " + retrieve;
}

function ioFailure(tool: string, code: string, message: string): ToolFailure {
  return new ToolFailure(code, contractError(tool, code, message));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
