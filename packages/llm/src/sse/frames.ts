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

  /** Feed decoded text; returns the frames that completed on this input. */
  push(text: string): SseFrame[] {
    this.#buffer += text;
    return this.#drain(false);
  }

  /** End of input: flush complete lines, drop the torn remainder. */
  flush(): SseFrame[] {
    const frames = this.#drain(true);
    this.#buffer = "";
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
    this.#buffer = buf.slice(at + len);
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
