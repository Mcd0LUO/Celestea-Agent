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
  /** Current state of one host conversation (null = no live generation). */
  lookup: (session: string | null) => { mailbox: SessionMailbox | null; busy: boolean } | null;
  /** Claim the slot and run one ordinary turn over the drained receipts. */
  wake: (session: string | null, input: string) => boolean;
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
      wake: (input) => this.opts.wake(session, input),
      log: (line) => autowakeLog(session, line),
    });
    this.loops.set(key, loop);
    loop.start();
  }

  /** Unpark every loop (process shutdown; idempotent). */
  async stop(): Promise<void> {
    const loops = [...this.loops.values()];
    this.loops.clear();
    await Promise.all(loops.map((loop) => loop.stop()));
  }
}
