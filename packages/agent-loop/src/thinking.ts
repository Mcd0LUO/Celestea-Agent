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
 *
 * W1510 note: whether to release is the CALLER's decision, because a repetition
 * conviction on the reasoning channel means this buffer holds exactly the
 * degenerate burst and must not be written.
 *
 * W1510 (ported semantics): the buffer is a bounded FIFO, not one growing
 * string. The guard can only convict AFTER the degeneration began, so on the
 * fallback path (retry budget spent) the healthy prefix must still be in hand
 * when the conviction arrives — that is what makes a precise cut possible
 * instead of one that lops the answer off at the provable point. With
 * `holdbackChars: 0` nothing is held and the behaviour is exactly the old
 * aggregate-then-flush, byte for byte.
 */

import type { SessionLog } from "@celestea/core";

export class ThinkingBuffer {
  /** Deltas not yet released, in arrival order; `head` is the first un-released. */
  private readonly queue: string[] = [];
  private head = 0;
  /** Characters currently held back (the sum of `queue[head..]`). */
  private held = 0;

  /**
   * @param session - where a released burst is persisted.
   * @param holdbackChars - characters kept back from release so a later
   *   conviction can cut at the true onset. `0` = release on every flush.
   */
  constructor(
    private readonly session: SessionLog,
    private readonly holdbackChars = 0,
  ) {}

  /** Concatenate one delta into the current burst. */
  push(delta: string): void {
    this.queue.push(delta);
    this.held += delta.length;
  }

  /**
   * Persist everything that has aged past the holdback window; a no-op when
   * nothing is releasable. Called at every visible boundary, exactly where
   * `flush()` used to be.
   */
  flush(): void {
    const releasable = this.releasable();
    if (releasable === null) return;
    this.appendText(releasable);
  }

  /**
   * Release what is still held, keeping only its first `keepChars` characters —
   * i.e. drop the degeneration the guard convicted and keep the healthy prefix
   * before it. The cut may land in the middle of a delta, which is intended: the
   * onset is a character offset, not a delta boundary.
   */
  releaseUpTo(keepChars: number): void {
    const heldText = this.queue.slice(this.head).join("");
    const keep = Math.max(0, Math.min(keepChars, heldText.length));
    this.dropHeld();
    this.appendText(heldText.slice(0, keep));
  }

  /**
   * Throw away everything still held, without persisting it. The degenerate
   * burst is the only thing this can drop in practice (see the loop's discard
   * policy), and dropping it is the whole point of the guard.
   */
  discard(): void {
    this.dropHeld();
  }

  /** True when deltas are waiting to be released (diagnostics / tests). */
  get pending(): boolean {
    return this.releasable() !== null;
  }

  /** Characters currently held back (diagnostics / tests). */
  get heldChars(): number {
    return this.held;
  }

  /** Everything still held, concatenated — what a truncation has to cut. */
  heldText(): string {
    return this.queue.slice(this.head).join("");
  }

  /** The concatenation `flush()` would persist, or null when there is none. */
  private releasable(): string | null {
    if (this.head >= this.queue.length) return null;
    const release = this.held - this.holdbackChars;
    if (release <= 0) return null;
    let text = "";
    let taken = 0;
    while (this.head < this.queue.length && taken < release) {
      const delta = this.queue[this.head] ?? "";
      const take = Math.min(delta.length, release - taken);
      text += delta.slice(0, take);
      taken += take;
      if (take < delta.length) {
        // Split the delta: the remainder stays held.
        this.queue[this.head] = delta.slice(take);
        break;
      }
      this.head += 1;
    }
    this.held -= taken;
    this.compact();
    return text;
  }

  /** Forget everything held (used by both release paths). */
  private dropHeld(): void {
    this.queue.length = 0;
    this.head = 0;
    this.held = 0;
  }

  /** Reclaim the released prefix once it dominates the array. */
  private compact(): void {
    if (this.head > 64 && this.head * 2 >= this.queue.length) {
      this.queue.splice(0, this.head);
      this.head = 0;
    }
  }

  private appendText(text: string): void {
    if (text === "") return;
    this.session.append({ type: "thinking_delta", text });
  }
}
