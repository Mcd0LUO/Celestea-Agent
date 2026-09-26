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
import { TextDecoder } from "node:util";

import { TIMED_OUT } from "../sandbox/async.js";

/** One framed stdout line plus whether its byte budget cut it. */
export interface BoundedLine {
  text: string;
  truncated: boolean;
  /**
   * W9112: the bytes were NOT valid UTF-8 (see [isMalformedUtf8]). The protocol
   * is UTF-8 on the wire, so a line that fails to decode is not a protocol line:
   * the broker fails the run instead of consuming U+FFFD as a value.
   */
  malformed: boolean;
  /**
   * W9112: the first raw bytes of a malformed line, hex — what the interpreter
   * ACTUALLY wrote, for the failure message. Empty for a well-formed line.
   */
  malformedHex: string;
}

const NEWLINE = 0x0a;
/** Longest UTF-8 sequence (a 4-byte code point) — the cut look-back window. */
const MAX_UTF8_SEQUENCE = 4;
/** How many raw bytes of a malformed line the failure message shows (W9112). */
const MALFORMED_PREVIEW_BYTES = 32;

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
   * elapses first. A partial tail at EOF is dropped (parity: only
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
    const bytes = Buffer.concat(this.parts);
    // W9205: tell the detector whether WE cut this line. `this.cut` is true only
    // when the byte budget truncated it, and that is the one case where an
    // incomplete trailing sequence is an artifact rather than corruption.
    const malformed = isMalformedUtf8(bytes, this.cut);
    this.queued.push({
      text: safeUtf8(bytes),
      truncated: this.cut,
      malformed,
      malformedHex: malformed ? bytes.subarray(0, MALFORMED_PREVIEW_BYTES).toString("hex") : "",
    });
    this.parts.length = 0;
    this.bytes = 0;
    this.cut = false;
  }
}

/**
 * Decode UTF-8 bytes, dropping a trailing **incomplete** sequence (the budget
 * cut may land inside a multi-byte character: `"hé"[:3]` must not become
 * `"h\uFFFD"`).
 *
 * W9205: this is a DECODER, so it is deliberately forgiving — it trims one
 * incomplete tail and lets `Buffer.toString("utf8")` produce U+FFFD for
 * anything still invalid. That tolerance is exactly why the caller must run
 * [isMalformedUtf8] FIRST and fail the run rather than pass this result up as a
 * value; decoding alone cannot tell "the budget cut me" from "the child wrote a
 * different encoding".
 */
export function safeUtf8(buffer: Buffer): string {
  return buffer.subarray(0, completePrefixLength(buffer)).toString("utf8");
}

/**
 * Byte length of the longest prefix ending on a code-point boundary — the rule
 * [safeUtf8] uses to drop a budget-cut tail.
 *
 * W9205: this is a DECODER concern only. It used to be shared with
 * [isMalformedUtf8], and that sharing was the bug: a trimmer whose whole job is
 * to forgive a cut tail cannot also decide whether a tail is corrupt. The
 * validator now takes its tolerance as an explicit parameter instead.
 */
function completePrefixLength(buffer: Buffer): number {
  for (let back = 0; back < MAX_UTF8_SEQUENCE && back < buffer.length; back += 1) {
    const byte = buffer[buffer.length - 1 - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    if ((byte & 0x80) === 0) return buffer.length;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return back + 1 === need ? buffer.length : buffer.length - 1 - back;
  }
  return buffer.length;
}

/**
 * W9112/W9205: true when `buffer` is NOT valid UTF-8.
 *
 * Uses the platform's own strict decoder (`new TextDecoder("utf-8", { fatal: true })`)
 * rather than a hand-rolled scanner, so a genuinely invalid sequence (GBK bytes,
 * a lone continuation byte, an overlong form) is detected.
 *
 * W9205 — THE INCOMPLETE TAIL IS CONTROLLED BY THE CALLER, NOT ASSUMED.
 *
 * The W9112 shape ran the bytes through [completePrefixLength] first, i.e. it
 * validated the same trimmed body [safeUtf8] DECODES. That trimmer exists to
 * drop the tail the BYTE BUDGET cut — so reusing it here meant a stream that
 * really ended mid-character (GBK `e4 b8`, a lone lead byte) was reported as
 * VALID and then silently decoded to U+FFFD / "" by [safeUtf8]. The detector
 * inherited a repair's tolerance and stopped detecting.
 *
 * The tolerance is therefore an explicit parameter:
 *   - `false` (default) — validate the WHOLE buffer. A line the child actually
 *     terminated with `\n` must be complete UTF-8, so an incomplete tail IS
 *     corruption and the run fails with `code=protocol`. This is the case the
 *     W9205 report measured as silently corrupting.
 *   - `true` — the caller KNOWS it cut this line at the byte budget
 *     ([LineReader.complete] passes its own `cut` flag), so the incomplete tail
 *     is the cut's artifact, not corruption, and only the complete prefix is
 *     validated. An over-long LOG line must not fail the run merely because the
 *     budget landed inside a character.
 *
 * This is a DETECTOR, never a repair: the caller must FAIL the run, not use the
 * replaced text as a value.
 */
export function isMalformedUtf8(buffer: Buffer, tolerateIncompleteTail = false): boolean {
  const body = tolerateIncompleteTail ? buffer.subarray(0, completePrefixLength(buffer)) : buffer;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return false;
  } catch {
    return true;
  }
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

/** Append up to `maxBytes` of `chunk` to `current` (UTF-8 safe, parity). */
export function appendBounded(current: string, chunk: string, maxBytes: number): BoundedLine {
  if (chunk === "") return { text: current, truncated: false, malformed: false, malformedHex: "" };
  const room = maxBytes - Buffer.byteLength(current, "utf8");
  const size = Buffer.byteLength(chunk, "utf8");
  if (size <= room) return { text: current + chunk, truncated: false, malformed: false, malformedHex: "" };
  return { text: current + utf8Prefix(chunk, Math.max(room, 0)), truncated: true, malformed: false, malformedHex: "" };
}

/**
 * Truncate a sub-call result to `budget` serialized bytes: strings keep a
 * UTF-8 safe prefix; non-strings collapse to a placeholder (there is no
 * lossless way to cut an object/array). Legacy `truncate_value`.
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
