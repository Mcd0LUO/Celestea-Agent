/**
 * W252: thinking-delta aggregation.
 *
 * The session log is the replay source of truth, but reasoning streams arrive
 * token by token: one jsonl row per delta would explode the log. Consecutive
 * `thinking` deltas are therefore concatenated into a buffer and flushed only
 * at visible boundaries (text / done / failed / stream end / cancellation), so
 * one contiguous reasoning burst becomes exactly ONE persisted
 * `thinking_delta` row. The live `thinking` event is still emitted per delta —
 * only persistence aggregates.
 */

import type { SessionLog } from "@celestea/core";

export class ThinkingBuffer {
  private buffered = "";

  constructor(private readonly session: SessionLog) {}

  /** Concatenate one delta into the current burst. */
  push(delta: string): void {
    this.buffered += delta;
  }

  /** Persist the current burst as one row; a no-op for an empty buffer. */
  flush(): void {
    if (this.buffered === "") return;
    const text = this.buffered;
    this.buffered = "";
    this.session.append({ type: "thinking_delta", text });
  }

  /** True when deltas are waiting to be persisted (diagnostics / tests). */
  get pending(): boolean {
    return this.buffered !== "";
  }
}
