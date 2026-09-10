/**
 * SSE stream -> seam events (P2a).
 *
 * Mirrors `crates/llm/src/client.rs::{raw_chunk_stream, stream_events}`:
 *   * the body is read chunk by chunk with the SSE idle guard applied to the
 *     gap between any two chunks (including the wait for the first one);
 *   * frames are decoded incrementally, `[DONE]` terminates, keepalive and
 *     non-JSON frames are skipped;
 *   * reasoning deltas stream as thinking events, content as text deltas, tool
 *     calls accumulate per index, usage is surfaced just before the terminal
 *     event;
 *   * the terminal event is exactly one of done / failed / interrupted — an
 *     idle stall yields failed{kind:"timeout"}, a mid-stream decode error
 *     failed{kind:"stream"}, and a stream that ends without [DONE] yields
 *     interrupted. Never a fake done (R1).
 */

import type http from "node:http";
import { StringDecoder } from "node:string_decoder";

import { streamIdleTimeoutMessage } from "./errors.js";
import { SseDecoder, type SseFrame } from "./sse/frames.js";
import {
  parseArguments,
  parseRawChunk,
  thinkingEvent,
  type RawChunk,
} from "./sse/chunks.js";
import type { Content, Message, StreamEvent } from "./seam.js";
import type { Usage } from "./usage.js";

/** Internal signal: the idle guard tripped and terminated the body read. */
export class StreamIdleAbort extends Error {}

/** Per-index accumulator for a streamed tool call. */
interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Accumulates one turn's deltas and assembles the terminal assistant message. */
export class TurnAccumulator {
  #text = "";
  #usage: Usage | null = null;
  readonly #calls = new Map<number, ToolCallAcc>();

  /** Fold one decoded chunk in; returns the live events it produced. */
  push(chunk: RawChunk): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (chunk.reasoning !== undefined) {
      const event = thinkingEvent(chunk.reasoning);
      if (event !== null) events.push(event);
    }
    for (const choice of chunk.choices) {
      if (choice.text !== undefined && choice.text !== "") {
        this.#text += choice.text;
        events.push({ type: "text", delta: choice.text });
      }
      for (const fragment of choice.toolCalls) this.#addFragment(fragment);
    }
    if (chunk.usage !== undefined) this.#usage = chunk.usage;
    return events;
  }

  #addFragment(fragment: { index: number; id?: string; name?: string; arguments?: string }): void {
    const entry = this.#calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
    if (fragment.id !== undefined) entry.id = fragment.id;
    if (fragment.name !== undefined) entry.name += fragment.name;
    if (fragment.arguments !== undefined) entry.arguments += fragment.arguments;
    this.#calls.set(fragment.index, entry);
  }

  /** The last seen provider usage (usage-only final frame or last chunk). */
  get usage(): Usage | null {
    return this.#usage;
  }

  /** The assembled assistant turn (text first, then tool calls by index). */
  doneMessage(): Message {
    const content: Content[] = [];
    if (this.#text !== "") content.push({ type: "text", content: this.#text });
    for (const index of [...this.#calls.keys()].sort((a, b) => a - b)) {
      const entry = this.#calls.get(index);
      if (entry === undefined) continue;
      content.push({
        type: "tool_call",
        content: { id: entry.id, name: entry.name, args: parseArguments(entry.arguments) },
      });
    }
    return { role: "assistant", content, tool_call_id: null };
  }
}

/** Fold a batch of frames in; `done` reports the [DONE] sentinel. */
function processFrames(
  frames: readonly SseFrame[],
  turn: TurnAccumulator,
): { events: StreamEvent[]; done: boolean } {
  const events: StreamEvent[] = [];
  for (const frame of frames) {
    if (frame.data === "[DONE]") return { events, done: true };
    if (frame.event === "keepalive") continue;
    const chunk = parseRawChunk(frame.data);
    if (chunk === undefined) continue;
    events.push(...turn.push(chunk));
  }
  return { events, done: false };
}

/**
 * Byte chunks of the response body with the SSE idle guard applied to the gap
 * between any two chunks. Throws StreamIdleAbort when the upstream stalls and
 * the transport error itself when the body read fails mid-stream.
 */
export async function* readBodyChunks(
  response: http.IncomingMessage,
  idleMs: number | null,
): AsyncGenerator<Buffer> {
  const queue: Buffer[] = [];
  let ended = false;
  let failure: Error | null = null;
  let notify: (() => void) | null = null;

  const wake = (): void => {
    const fn = notify;
    notify = null;
    if (fn !== null) fn();
  };
  const onData = (chunk: Buffer): void => {
    queue.push(chunk);
    wake();
  };
  const onEnd = (): void => {
    ended = true;
    wake();
  };
  const onError = (err: Error): void => {
    failure = err;
    wake();
  };
  const onClose = (): void => {
    ended = true;
    wake();
  };

  response.on("data", onData);
  response.on("end", onEnd);
  response.on("error", onError);
  response.on("close", onClose);
  response.resume();

  try {
    for (;;) {
      if (queue.length > 0) {
        const chunk = queue.shift();
        if (chunk !== undefined) yield chunk;
        continue;
      }
      if (failure !== null) throw failure;
      if (ended) return;
      await waitForData(idleMs, (resume) => (notify = resume));
    }
  } finally {
    response.off("data", onData);
    response.off("end", onEnd);
    response.off("error", onError);
    response.off("close", onClose);
  }
}

/** Wait for the next chunk; rejects with StreamIdleAbort on an idle gap. */
function waitForData(
  idleMs: number | null,
  register: (resume: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    register(() => {
      if (timer !== null) clearTimeout(timer);
      resolve();
    });
    if (idleMs !== null) {
      timer = setTimeout(() => {
        register(() => {});
        reject(new StreamIdleAbort(streamIdleTimeoutMessage(idleMs)));
      }, idleMs);
    }
  });
}

/**
 * Decode a 2xx SSE response into seam events. The generator always ends with
 * exactly one terminal event (done | failed | interrupted) or an empty stream
 * only when the caller stops iterating early.
 */
export async function* streamEvents(
  response: http.IncomingMessage,
  idleMs: number | null,
): AsyncGenerator<StreamEvent> {
  const decoder = new SseDecoder();
  const textDecoder = new StringDecoder("utf8");
  const turn = new TurnAccumulator();
  let sawDone = false;
  let failure: StreamEvent | null = null;

  try {
    for await (const bytes of readBodyChunks(response, idleMs)) {
      const result = processFrames(decoder.push(textDecoder.write(bytes)), turn);
      yield* result.events;
      if (result.done) {
        sawDone = true;
        break;
      }
    }
  } catch (err) {
    failure = streamFailure(err);
  } finally {
    response.destroy();
  }

  // Usage rides just before the terminal event (Rust order), so consumers that
  // treat the terminal event as the end still observe it.
  if (turn.usage !== null) yield { type: "usage", usage: turn.usage };
  if (failure !== null) {
    yield failure;
    return;
  }
  if (!sawDone) {
    // The upstream ended before the [DONE] sentinel: torn stream.
    yield { type: "interrupted" };
    return;
  }
  yield { type: "done", message: turn.doneMessage() };
}

/** Map a body-read failure onto its terminal event (R1: never a fake done). */
function streamFailure(err: unknown): StreamEvent {
  if (err instanceof StreamIdleAbort) {
    // W266: a stalled stream is a terminal timeout with its own kind.
    return { type: "failed", kind: "timeout", message: err.message };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { type: "failed", kind: "stream", message: `sse decode error: ${detail}` };
}
