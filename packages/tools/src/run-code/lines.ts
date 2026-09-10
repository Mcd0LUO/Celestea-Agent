/**
 * Line framing and byte budgets for the `run_code` broker
 * (`crates/tools/src/run_code.rs:488-560`).
 *
 * The child speaks a line protocol on stdout, so the parent needs three things
 * the sandbox's capped whole-stream captures cannot give it:
 * - **one `\n`-terminated line at a time, with a deadline** — the wall clock is
 *   enforced while waiting, not after the stream ends;
 * - **a per-line byte budget** — an over-long line is drained and dropped, never
 *   buffered and never parsed as protocol (a truncated JSON line is not JSON);
 * - **UTF-8 safe cuts** — a budget never splits a multi-byte character, so a
 *   truncated value or log stays valid text.
 */

import type { Readable } from "node:stream";

import { TIMED_OUT } from "../sandbox/async.js";

/** One framed stdout line plus whether its byte budget cut it. */
export interface BoundedLine {
  text: string;
  truncated: boolean;
}

const NEWLINE = 0x0a;
/** Longest UTF-8 sequence (a 4-byte code point) — the cut look-back window. */
const MAX_UTF8_SEQUENCE = 4;

/**
 * `\n`-framed reader over a byte stream with a per-line cap and a deadline.
 * Feed-driven (no async iterators): the broker asks for one line at a time and
 * always re-arms the *remaining* wall clock, so a silent child cannot stall it.
 */
export class LineReader {
  private readonly queued: BoundedLine[] = [];
  private readonly parts: Buffer[] = [];
  private bytes = 0;
  private cut = false;
  private done = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly stream: Readable | null,
    private readonly maxLineBytes: number,
  ) {
    if (stream === null) {
      this.done = true;
      return;
    }
    stream.on("data", (chunk: Buffer | string) => {
      this.feed(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      this.signal();
    });
    const end = (): void => {
      this.done = true;
      this.signal();
    };
    stream.on("end", end);
    stream.on("close", end);
    stream.on("error", end);
  }

  /**
   * The next complete line, `null` at EOF, or [`TIMED_OUT`] when `remainingMs`
   * elapses first. A partial tail at EOF is dropped (Rust parity: only
   * `\n`-terminated lines are protocol candidates).
   */
  async next(remainingMs: number): Promise<BoundedLine | null | typeof TIMED_OUT> {
    const deadline = Date.now() + remainingMs;
    for (;;) {
      const line = this.queued.shift();
      if (line !== undefined) return line;
      if (this.done) return null;
      const left = deadline - Date.now();
      if (left <= 0) return TIMED_OUT;
      if (!(await this.arrival(left))) return TIMED_OUT;
    }
  }

  /** Stop consuming: detach and pause so post-final output is not buffered. */
  stop(): void {
    this.done = true;
    if (this.stream === null) return;
    this.stream.removeAllListeners("data");
    this.stream.pause();
  }

  private arrival(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.wake = null;
        resolve(false);
      }, ms);
      this.wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wake = null;
        resolve(true);
      };
    });
  }

  private signal(): void {
    this.wake?.();
  }

  private feed(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) {
        this.push(chunk.subarray(start));
        return;
      }
      this.push(chunk.subarray(start, end));
      this.complete();
      start = end + 1;
    }
  }

  private push(segment: Buffer): void {
    if (this.cut || segment.length === 0) return;
    const room = this.maxLineBytes - this.bytes;
    if (segment.length <= room) {
      this.parts.push(segment);
      this.bytes += segment.length;
      return;
    }
    this.parts.push(segment.subarray(0, Math.max(room, 0)));
    this.bytes = this.maxLineBytes;
    this.cut = true;
  }

  private complete(): void {
    this.queued.push({ text: safeUtf8(Buffer.concat(this.parts)), truncated: this.cut });
    this.parts.length = 0;
    this.bytes = 0;
    this.cut = false;
  }
}

/**
 * Decode UTF-8 bytes, dropping a trailing **incomplete** sequence (the budget
 * cut may land inside a multi-byte character: `"hé"[:3]` must not become
 * `"h\uFFFD"`).
 */
export function safeUtf8(buffer: Buffer): string {
  for (let back = 0; back < MAX_UTF8_SEQUENCE && back < buffer.length; back += 1) {
    const byte = buffer[buffer.length - 1 - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking back
    if ((byte & 0x80) === 0) return buffer.toString("utf8"); // ASCII tail: complete
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    if (back + 1 === need) return buffer.toString("utf8"); // complete code point
    return buffer.subarray(0, buffer.length - 1 - back).toString("utf8"); // cut inside it
  }
  return buffer.toString("utf8");
}

/** UTF-8 safe prefix of `text` at most `maxBytes` bytes long. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : safeUtf8(bytes.subarray(0, maxBytes));
}

/** Serialized size of a value in bytes, or `null` when it is not JSON-able. */
export function jsonByteLength(value: unknown): number | null {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  return encoded === undefined ? null : Buffer.byteLength(encoded, "utf8");
}

/** Append up to `maxBytes` of `chunk` to `current` (UTF-8 safe, Rust parity). */
export function appendBounded(current: string, chunk: string, maxBytes: number): BoundedLine {
  if (chunk === "") return { text: current, truncated: false };
  const room = maxBytes - Buffer.byteLength(current, "utf8");
  const size = Buffer.byteLength(chunk, "utf8");
  if (size <= room) return { text: current + chunk, truncated: false };
  return { text: current + utf8Prefix(chunk, Math.max(room, 0)), truncated: true };
}

/**
 * Truncate a sub-call result to `budget` serialized bytes: strings keep a
 * UTF-8 safe prefix; non-strings collapse to a placeholder (there is no
 * lossless way to cut an object/array). Rust `truncate_value`.
 */
export function truncateValue(value: unknown, budget: number): unknown {
  if (typeof value === "string") return utf8Prefix(value, budget);
  const size = jsonByteLength(value);
  if (size !== null && size <= budget) return value;
  return "[run_code] sub-call output exceeded the budget; value dropped";
}

/** The last `maxChars` characters of `text` (failure-message log tail). */
export function tail(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join("");
}
