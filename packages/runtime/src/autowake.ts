/**
 * Host auto-wake (W769) — the TS counterpart of the Rust `autowake_loop`
 * (`crates/../src/main.rs:1044-1187`, semantics in
 * `docs/DEVELOPMENT.md` §2.6).
 *
 * The problem it solves: a worker's completion receipt is delivered into its
 * HOST session's mailbox, and the host only drains that mailbox at a turn
 * boundary — so without a loop the receipt lies in the queue until the user
 * happens to type something. Auto-wake is "delivery wakes the agent".
 *
 * The shape here is the Rust one, adapted to this repo's per-session
 * generations:
 *   - the loop PARKS on the mailbox notification ([SessionMailbox.onQueued]) and
 *     rebinds to whatever generation is in force on every pass, so a rebuilt
 *     instance (a config/grant epoch bump) is picked up without a stale
 *     subscription — `mailbox()` is a hook, never a captured object;
 *   - a BUSY host leaves the message QUEUED (it is not drained) and retries on
 *     the Rust cadence (250ms): nothing is lost and nothing is consumed twice;
 *   - on wake it drains the WHOLE queue FIFO into one input
 *     (`[from <label>] <content>`, blank-line separated) and asks the host to run
 *     ONE ordinary turn — the host's own turn path, so SSE/status/audit are the
 *     manual ones (Rust: "SSE 与手动 turn 完全一致");
 *   - hard errors are logged with a small backoff (500ms); the loop never
 *     throws, never panics and never spins hot;
 *   - `stop()` unparks immediately and is what a shutdown hook calls.
 *
 * The loop knows nothing about sessions, HTTP or workers: the host supplies the
 * three facts it needs (mailbox, busy, wake).
 */

import type { MailboxMessage, MailboxSendOptions, SessionMailbox } from "@celestea/workers";

/** Env knob: `0/off/false/no` (case-insensitive) disables auto-wake. */
export const ENV_AUTOWAKE = "CELESTEA_AUTOWAKE";
/** Busy-host retry cadence (the message stays queued). */
export const AUTOWAKE_BUSY_RETRY_MS = 250;
/** Backoff after a hard error / an unresolvable mailbox. */
export const AUTOWAKE_ERROR_BACKOFF_MS = 500;
/**
 * Safety net for a notification that cannot arrive: a mailbox that appeared
 * while the loop was parked (an instance REBUILD hands the session a brand-new
 * mailbox, and the loop only subscribes to it on its next pass), or a queue that
 * was refilled by something that is not this mailbox. The notification path is
 * the mechanism (it wakes in the same tick); this floor only bounds how long a
 * generation swap can delay a receipt — it is the TS stand-in for the Rust
 * loop's `gen_epoch` watch, at the same cadence as the busy-retry.
 */
export const AUTOWAKE_POLL_MS = 250;

/** `CELESTEA_AUTOWAKE`: default ON; the four literals turn it off. */
export function autowakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_AUTOWAKE] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

/**
 * The turn input of one wake: every drained message in FIFO order, labelled with
 * its sender (Rust joins with a blank line).
 */
export function autowakeInput(messages: readonly MailboxMessage[]): string {
  return messages.map((m) => (m.from_label === "" ? m.content : `[from ${m.from_label}] ${m.content}`)).join("\n\n");
}

/** The mailbox surface the loop needs (structural: `SessionMailbox` satisfies it). */
export interface AutowakeMailbox {
  onQueued(listener: (to: string, message: MailboxMessage) => void): () => void;
  poll(to: string): MailboxMessage[];
  pending(to: string): number;
  send(to: string, content: string, fromLabel: string, opts?: MailboxSendOptions): MailboxMessage;
}

/** What the host must tell the loop (all three are read fresh on every pass). */
export interface AutowakeHooks {
  /** Queue key of the host conversation in this generation (`cli-main` / the session id). */
  queueKey: string;
  /** The mailbox IN FORCE right now; null = no live generation to bind. */
  mailbox: () => AutowakeMailbox | null;
  /** Is the host currently running a turn? */
  isBusy: () => boolean;
  /**
   * Claim the slot and run ONE ordinary turn with `input`. Return `false` when
   * the slot was taken in the window (the loop re-queues and retries); throwing
   * is a hard error and is logged.
   */
  wake: (input: string) => boolean;
  /** Diagnostics sink (default: silent). */
  log?: (line: string) => void;
}

/** Injectable timers so the loop is testable without sleeping. */
export interface AutowakeTiming {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMING: AutowakeTiming = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // The repo's timer rule: a PARKED loop must never keep the process alive
    // (same as the watchdog's sweep and the idle reclaimer).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AutowakeOptions {
  busyRetryMs?: number;
  errorBackoffMs?: number;
  pollMs?: number;
  timing?: AutowakeTiming;
}

/** One auto-wake loop, bound to ONE host conversation. */
export class AutowakeLoop {
  private readonly hooks: AutowakeHooks;
  private readonly busyRetryMs: number;
  private readonly errorBackoffMs: number;
  private readonly pollMs: number;
  private readonly timing: AutowakeTiming;
  private stopped = false;
  private notified = false;
  private unpark: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private bound: AutowakeMailbox | null = null;
  private running: Promise<void> | null = null;
  /** Consecutive passes that could not hand the queue to a host (log throttle). */
  private stalled = 0;

  constructor(hooks: AutowakeHooks, options: AutowakeOptions = {}) {
    this.hooks = hooks;
    this.busyRetryMs = options.busyRetryMs ?? AUTOWAKE_BUSY_RETRY_MS;
    this.errorBackoffMs = options.errorBackoffMs ?? AUTOWAKE_ERROR_BACKOFF_MS;
    this.pollMs = options.pollMs ?? AUTOWAKE_POLL_MS;
    this.timing = options.timing ?? REAL_TIMING;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Start the loop (idempotent). */
  start(): void {
    if (this.running !== null) return;
    this.running = this.loop();
  }

  /**
   * Stop for good: unbind, unpark and wait for the pass in flight to return.
   * Safe to call twice; never rejects.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bound = null;
    this.unpark?.();
    const running = this.running;
    this.running = null;
    if (running !== null) await running.catch(() => undefined);
  }

  /** Test/diagnostic handle: the pass currently in flight (null when idle). */
  get pass(): Promise<void> | null {
    return this.running;
  }

  // --- the loop ----------------------------------------------------------

  private async loop(): Promise<void> {
    // Let the mounting host finish publishing the instance this loop belongs to
    // (the studio mounts it from inside the generation's own build callback, so
    // one microtask later the entry exists and the first bind succeeds).
    await Promise.resolve();
    while (!this.stopped) {
      const mailbox = this.bind();
      if (mailbox === null) {
        this.report("no live generation to bind; retrying");
        await this.pause(this.errorBackoffMs);
        continue;
      }
      if (mailbox.pending(this.hooks.queueKey) === 0 && !this.notified) {
        await this.waitForWork();
        continue;
      }
      this.notified = false;
      if (this.hooks.isBusy()) {
        // Leave the message QUEUED (do not drain) and retry on the Rust cadence.
        await this.pause(this.busyRetryMs);
        continue;
      }
      const drained = mailbox.poll(this.hooks.queueKey);
      if (drained.length === 0) continue;
      let started = false;
      try {
        started = this.hooks.wake(autowakeInput(drained));
      } catch (error) {
        this.stalled += 1;
        this.report(`turn error: ${error instanceof Error ? error.message : String(error)}`);
        await this.pause(this.errorBackoffMs);
        continue; // hard error: the turn consumed the messages (Rust behaviour)
      }
      if (started) {
        this.stalled = 0;
        continue;
      }
      // Lost the race for the turn slot: hand the SAME messages to whatever
      // generation is in force NOW (never the one they were popped from) and
      // retry — nothing is lost, nothing is consumed twice.
      this.stalled += 1;
      this.requeue(drained);
      this.report(`host busy; ${drained.length} message(s) re-queued (attempt ${this.stalled})`);
      await this.pause(this.busyRetryMs);
    }
  }

  /** Resolve the current mailbox and (re)subscribe when the generation moved. */
  private bind(): AutowakeMailbox | null {
    let mailbox: AutowakeMailbox | null = null;
    try {
      mailbox = this.hooks.mailbox();
    } catch (error) {
      this.report(`mailbox lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      mailbox = null;
    }
    if (mailbox !== this.bound) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.bound = mailbox;
      if (mailbox !== null) {
        this.unsubscribe = mailbox.onQueued((to) => {
          if (to === this.hooks.queueKey) this.notify();
        });
      }
    }
    return mailbox;
  }

  private requeue(messages: readonly MailboxMessage[]): void {
    let mailbox: AutowakeMailbox | null = null;
    try {
      mailbox = this.hooks.mailbox();
    } catch {
      mailbox = null;
    }
    if (mailbox === null) {
      this.report("cannot re-queue: no live generation (messages stay consumed)");
      return;
    }
    for (const message of messages) {
      mailbox.send(this.hooks.queueKey, message.content, message.from_label, {
        kind: message.kind,
        source: message.source,
      });
    }
  }

  private notify(): void {
    this.notified = true;
    this.unpark?.();
  }

  /** Park until the next notification or the safety-net timeout. */
  private waitForWork(): Promise<void> {
    if (this.notified) {
      this.notified = false;
      return Promise.resolve();
    }
    return this.park(this.pollMs);
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.park(ms);
  }

  private park(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.timing.setTimeout(() => {
        this.unpark = null;
        resolve();
      }, ms);
      this.unpark = () => {
        this.timing.clearTimeout(timer);
        this.unpark = null;
        resolve();
      };
    });
  }

  /** Log with the Rust loop's thrift: first attempt, then every 20th. */
  private report(line: string): void {
    if (this.stalled > 1 && this.stalled % 20 !== 0) return;
    this.hooks.log?.(line);
  }
}

/** Factory form (ARCHITECTURE.md §6.1). */
export function createAutowakeLoop(hooks: AutowakeHooks, options: AutowakeOptions = {}): AutowakeLoop {
  return new AutowakeLoop(hooks, options);
}

/** Type guard-ish helper: the `SessionMailbox` of a runtime, when it has one. */
export function autowakeMailboxOf(mailbox: SessionMailbox | null | undefined): AutowakeMailbox | null {
  return mailbox ?? null;
}
