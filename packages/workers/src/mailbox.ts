/**
 * SessionMailbox — the wake-up channel between sessions (Rust
 * `celestea_session::SessionMailbox`, W232 semantics).
 *
 * Semantics that matter and are all observable:
 *   - `send` delivers to a parked `recv` waiter FIRST (that is the wake-up);
 *     with no waiter the message is queued FIFO;
 *   - `poll` drains a session's queue in FIFO order (the host drains its own
 *     queue at turn start);
 *   - `recv` parks until the next message, and resolves `null` when the
 *     mailbox is released or the caller's signal aborts — a parked consumer can
 *     never hang a shutdown;
 *   - `purge` / `purgeAll` drop undelivered messages (generation swap /
 *     shutdown), and `release` parks nothing further.
 *
 * W769: `onQueued` observes the wake-up channel itself — it fires ONLY when a
 * message is actually QUEUED (no parked `recv` waiter consumed it). That is the
 * distinction the host auto-wake needs: a message delivered straight to a parked
 * worker driver is already being handled and must not wake anybody else, while a
 * message that landed in a queue is precisely "somebody should look at this".
 */

import type { MailboxMessage, MailboxSendOptions, MailboxWaiter } from "./types.js";

export class SessionMailbox {
  private readonly queues = new Map<string, MailboxMessage[]>();
  private readonly waiters = new Map<string, MailboxWaiter[]>();
  private readonly queuedListeners: Array<(to: string, message: MailboxMessage) => void> = [];
  private nextId = 1;
  private released = false;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /** Queue (or hand straight to a parked consumer) one message. */
  send(to: string, content: string, fromLabel: string, opts: MailboxSendOptions = {}): MailboxMessage {
    const msg: MailboxMessage = {
      id: this.nextId++,
      to,
      content,
      from_label: fromLabel,
      at: this.now(),
      kind: opts.kind ?? "relay",
      source: opts.source ?? { kind: "worker-relay", form: "message", senderSessionId: fromLabel },
    };
    if (this.released) return msg;
    const waiter = this.waiters.get(to)?.shift();
    if (waiter !== undefined) {
      waiter(msg);
      return msg;
    }
    const queue = this.queues.get(to);
    if (queue === undefined) this.queues.set(to, [msg]);
    else queue.push(msg);
    this.notifyQueued(to, msg);
    return msg;
  }

  /**
   * W769: observe messages that were really QUEUED for `to` (a `send` handed
   * straight to a parked `recv` waiter does NOT notify — that consumer is awake
   * already). Returns the unsubscribe function; listeners are called
   * synchronously from `send` and a throwing listener can never break delivery.
   */
  onQueued(listener: (to: string, message: MailboxMessage) => void): () => void {
    this.queuedListeners.push(listener);
    return () => {
      const i = this.queuedListeners.indexOf(listener);
      if (i >= 0) this.queuedListeners.splice(i, 1);
    };
  }

  private notifyQueued(to: string, message: MailboxMessage): void {
    for (const listener of [...this.queuedListeners]) {
      try {
        listener(to, message);
      } catch {
        // An observer must never be able to lose a message.
      }
    }
  }

  /** Drain one session's queue in FIFO order. */
  poll(to: string): MailboxMessage[] {
    const queue = this.queues.get(to) ?? [];
    this.queues.set(to, []);
    return queue;
  }

  /** Queued (not yet delivered) messages for one session. */
  pending(to: string): number {
    return this.queues.get(to)?.length ?? 0;
  }

  /** Queued messages across every session. */
  pendingTotal(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /** Park until the next message for `to` (null when released/aborted). */
  recv(to: string, signal?: AbortSignal): Promise<MailboxMessage | null> {
    if (this.released) return Promise.resolve(null);
    if (signal?.aborted === true) return Promise.resolve(null);
    const queued = this.queues.get(to)?.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal === undefined) return this.park(to);
    return new Promise<MailboxMessage | null>((resolve) => {
      const onAbort = (): void => {
        this.dropWaiter(to, waiter);
        resolve(null);
      };
      const waiter: MailboxWaiter = (msg) => {
        signal.removeEventListener("abort", onAbort);
        resolve(msg);
      };
      this.pushWaiter(to, waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Drop undelivered messages for one session. */
  purge(to: string): number {
    const n = this.pending(to);
    this.queues.delete(to);
    return n;
  }

  /** Drop every undelivered message (generation swap / shutdown). */
  purgeAll(): number {
    const n = this.pendingTotal();
    this.queues.clear();
    return n;
  }

  /** Wake every parked consumer with null and refuse further delivery. */
  release(): void {
    this.released = true;
    for (const [to, waiters] of this.waiters) {
      this.waiters.set(to, []);
      for (const w of waiters) w(null);
    }
  }

  private park(to: string): Promise<MailboxMessage | null> {
    return new Promise<MailboxMessage | null>((resolve) => {
      this.pushWaiter(to, resolve);
    });
  }

  private pushWaiter(to: string, waiter: MailboxWaiter): void {
    const list = this.waiters.get(to);
    if (list === undefined) this.waiters.set(to, [waiter]);
    else list.push(waiter);
  }

  private dropWaiter(to: string, waiter: MailboxWaiter): void {
    const list = this.waiters.get(to);
    if (list === undefined) return;
    const i = list.indexOf(waiter);
    if (i >= 0) list.splice(i, 1);
  }
}
