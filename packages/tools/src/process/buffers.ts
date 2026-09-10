/**
 * Capped stream buffers for background processes (`crates/tools/src/process.rs`).
 *
 * A background process outlives the turn, so its output must not grow without
 * bound: each stream keeps the LAST N bytes (older bytes are dropped and the
 * truncation flag latched), `poll` returns a short tail, and the completion
 * record keeps an even shorter tail with newline runs folded so the mailbox
 * message stays compact.
 */

/** Bytes kept per stream in the registry ring buffer (last N bytes win). */
export const MAX_STREAM_BUFFER = 512 * 1024;
/** Bytes returned by `poll` as `stdout_tail` / `stderr_tail`. */
export const TAIL_BYTES = 4 * 1024;
/** Bytes kept per stream in a completion record. */
export const COMPLETION_TAIL_BYTES = 1024;

/** Append-only ring buffer over bytes: keeps the newest `cap` bytes. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflow = false;
  private readonly cap: number;

  constructor(cap: number = MAX_STREAM_BUFFER) {
    this.cap = cap;
  }

  append(data: Buffer): void {
    if (data.length >= this.cap) {
      this.chunks = [data.subarray(data.length - this.cap)];
      this.size = this.cap;
      this.overflow = true;
      return;
    }
    this.chunks.push(data);
    this.size += data.length;
    this.dropOldest();
  }

  private dropOldest(): void {
    while (this.size > this.cap) {
      const head = this.chunks[0];
      if (head === undefined) return;
      const excess = this.size - this.cap;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
      this.overflow = true;
    }
  }

  get truncated(): boolean {
    return this.overflow;
  }

  get length(): number {
    return this.size;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** The last `bytes` bytes, decoded as UTF-8 (partial sequences are lossy). */
  tail(bytes: number): string {
    const all = this.toBuffer();
    return all.subarray(Math.max(all.length - bytes, 0)).toString("utf8");
  }
}

/** Last [COMPLETION_TAIL_BYTES] of a stream with newline runs folded. */
export function completionTail(buffer: RingBuffer, bytes: number = COMPLETION_TAIL_BYTES): string {
  return foldNewlines(buffer.tail(bytes));
}

export function foldNewlines(text: string): string {
  let out = "";
  let previousWasNewline = false;
  for (const ch of text) {
    if (ch !== "\n") {
      out += ch;
      previousWasNewline = false;
      continue;
    }
    if (!previousWasNewline) out += ch;
    previousWasNewline = true;
  }
  return out;
}
