/**
 * Incremental SSE frame decoder (P2a).
 *
 * Mirrors the `eventsource-stream` layer used by
 * `crates/llm/src/client.rs::raw_chunk_stream`: frames are newline-terminated
 * and dispatched by a blank line, comment lines (`: keepalive`) and unknown
 * fields are ignored, and an unterminated trailing frame at EOF is dropped.
 *
 * The decoder is incremental on purpose: bytes may arrive split anywhere —
 * inside a frame, between CR and LF, or inside a multi-byte UTF-8 character
 * (the byte-level driver feeds it decoded text via a StringDecoder).
 */

/**
 * Hard cap on the decoded, not-yet-framed buffer (W835 R3 batch E / P2-5).
 *
 * A stream that never emits a newline would otherwise grow the buffer without
 * bound (the idle guard only fires when NO bytes arrive). 4 MiB is ~8x the
 * largest plausible single frame: providers chunk output deltas, and even a
 * full 128k-token answer delivered as one frame stays below ~0.5 MiB.
 * Exceeding it is a terminal failed{kindOf:"stream"} on the stream path.
 */
export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

/** The decoder's newline-less buffer exceeded [MAX_SSE_BUFFER_BYTES]. */
export class SseBufferOverflowError extends Error {
  constructor(readonly limit: number) {
    super("SSE decoder buffer exceeded " + limit + " bytes without a frame boundary");
    this.name = "SseBufferOverflowError";
  }
}

/** One fully decoded SSE frame (blank-line terminated). */
export interface SseFrame {
  /** Event name; "message" when the frame carried no `event:` field. */
  event: string;
  /** Joined `data:` lines (never "" — empty frames are not dispatched). */
  data: string;
}

export class SseDecoder {
  #buffer = "";
  #event = "";
  #data: string[] = [];
  #bytes = 0;

  /** Feed decoded text; returns the frames that completed on this input. */
  push(text: string): SseFrame[] {
    this.#buffer += text;
    this.#bytes += Buffer.byteLength(text, "utf8");
    const frames = this.#drain(false);
    // Check AFTER draining: a big batch of COMPLETE frames is fine; only a
    // buffer that cannot be framed within the cap is a runaway (P2-5).
    if (this.#bytes > MAX_SSE_BUFFER_BYTES) throw new SseBufferOverflowError(MAX_SSE_BUFFER_BYTES);
    return frames;
  }

  /** End of input: flush complete lines, drop the torn remainder. */
  flush(): SseFrame[] {
    const frames = this.#drain(true);
    this.#buffer = "";
    this.#bytes = 0;
    return frames;
  }

  #drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const line = this.#nextLine(final);
      if (line === null) break;
      if (line === "") {
        const frame = this.#dispatch();
        if (frame !== null) frames.push(frame);
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keepalive line
      this.#consumeField(line);
    }
    return frames;
  }

  /** Next complete line, or null when more bytes are needed. */
  #nextLine(final: boolean): string | null {
    const buf = this.#buffer;
    const lf = buf.indexOf("\n");
    const cr = buf.indexOf("\r");
    let at: number;
    let len = 1;
    if (lf !== -1 && (cr === -1 || lf < cr)) {
      at = lf;
    } else if (cr !== -1) {
      // A trailing CR may be the first half of CRLF: wait for more bytes.
      if (cr === buf.length - 1 && !final) return null;
      at = cr;
      if (buf.charAt(cr + 1) === "\n") len = 2;
    } else {
      return null;
    }
    const line = buf.slice(0, at);
    const consumed = buf.slice(0, at + len);
    this.#buffer = buf.slice(at + len);
    this.#bytes -= Buffer.byteLength(consumed, "utf8");
    return line;
  }

  #consumeField(line: string): void {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.#event = value;
    else if (field === "data") this.#data.push(value);
    // id / retry / unknown fields: not part of this contract, ignored.
  }

  #dispatch(): SseFrame | null {
    const event = this.#event;
    const data = this.#data;
    this.#event = "";
    this.#data = [];
    // Per the SSE spec an empty data buffer dispatches nothing.
    if (data.length === 0) return null;
    return { event: event === "" ? "message" : event, data: data.join("\n") };
  }
}
