/**
 * W769 — the studio host's auto-wake wiring.
 *
 * The loop itself is `@celestea/runtime`'s `AutowakeLoop` (mailbox → busy check →
 * wake). This module owns the studio-specific part: WHICH conversations have a
 * loop (one per host session, keyed by session id / `cli-main` for the detached
 * generation) and how the loop reads the state of the generation in force.
 *
 * It lives outside the adapter on purpose: `real-runtime-adapter.ts` sits at the
 * eslint size budget, and "which sessions can be woken" is a policy of its own —
 * a worker's receipt is addressed to the session that spawned it, so the set of
 * queues that can carry one is exactly the set of live host sessions.
 */

import { AutowakeLoop, HOST_SESSION_ID, keyOfSession } from "@celestea/runtime";
import type { SessionMailbox } from "@celestea/workers";

/** What the adapter must tell the wiring. */
export interface HostAutowakeOptions {
  /** `CELESTEA_AUTOWAKE` (read once by the adapter at construction). */
  enabled: boolean;
  /**
   * Current state of one host conversation (null = no live generation).
   * W855 (C8): `userPending` is the size of the USER's `next-turn` lane; the
   * loop only observes it (the turn-start drain is the lane's consumer).
   */
  lookup: (session: string | null) => { mailbox: SessionMailbox | null; busy: boolean; userPending: number } | null;
  /** Claim the slot and run one ordinary turn over the drained receipts. */
  wake: (session: string | null, input: string | null) => boolean;
}

/**
 * W855 (C8): the generation state the loop reads on every pass, seen
 * structurally (the registry entry satisfies it). Keeping this here — instead of
 * inline in `real-runtime-adapter.ts` — is what keeps that file under its
 * eslint `max-lines` budget.
 */
export interface AutowakeGeneration {
  inFlight: boolean;
  runtime: {
    workers?: { mailbox?: SessionMailbox | null } | null;
    pendingInjections(lane?: "next-turn"): number;
  };
}

/** Mailbox + busy + the USER's next-turn lane depth, from one entry (or null). */
export function autowakeStateOf(
  entry: AutowakeGeneration | null,
): { mailbox: SessionMailbox | null; busy: boolean; userPending: number } | null {
  return entry === null
    ? null
    : {
        mailbox: entry.runtime.workers?.mailbox ?? null,
        busy: entry.inFlight,
        userPending: entry.runtime.pendingInjections("next-turn"),
      };
}

/** The studio's log line for auto-wake decisions (stderr, like boot recovery). */
export function autowakeLog(session: string | null, line: string): void {
  process.stderr.write(`[celestea-studio-ts] autowake ${session ?? HOST_SESSION_ID}: ${line}\n`);
}

export class HostAutowake {
  private readonly loops = new Map<string, AutowakeLoop>();
  private readonly opts: HostAutowakeOptions;

  constructor(opts: HostAutowakeOptions) {
    this.opts = opts;
  }

  /** Is auto-wake on? (`CELESTEA_AUTOWAKE`, default on.) */
  get running(): boolean {
    return this.opts.enabled;
  }

  /** Live loops (diagnostics / tests). */
  get count(): number {
    return this.loops.size;
  }

  /**
   * Mount the (idempotent) loop of one host conversation. Called from the
   * generation's build callback: the hooks read the CURRENT entry on every pass,
   * so a rebuilt instance is picked up without re-mounting anything.
   */
  ensure(session: string | null): void {
    if (!this.opts.enabled) return;
    const key = keyOfSession(session);
    if (this.loops.has(key)) return;
    const loop = new AutowakeLoop({
      queueKey: session ?? HOST_SESSION_ID,
      mailbox: () => this.opts.lookup(session)?.mailbox ?? null,
      isBusy: () => this.opts.lookup(session)?.busy ?? false,
      userPending: () => this.opts.lookup(session)?.userPending ?? 0,
      wake: (input) => this.opts.wake(session, input),
      log: (line) => autowakeLog(session, line),
    });
    this.loops.set(key, loop);
    loop.start();
  }

  /**
   * W794: a DELETED session never comes back under that id, so its loop is
   * unparked for good — otherwise it keeps re-binding to a generation that can
   * never exist again and re-logs `no live generation to bind` forever (the
   * timer is real). A rebuild / idle eviction must NOT call this: the same id
   * recomposes, and its loop has to be waiting for it. Idempotent.
   */
  async forget(session: string | null): Promise<void> {
    const key = keyOfSession(session);
    const loop = this.loops.get(key);
    if (loop === undefined) return;
    this.loops.delete(key);
    await loop.stop();
  }

  /** Unpark every loop (process shutdown; idempotent). */
  async stop(): Promise<void> {
    const loops = [...this.loops.values()];
    this.loops.clear();
    await Promise.all(loops.map((loop) => loop.stop()));
  }
}
