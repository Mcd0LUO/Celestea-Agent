/**
 * Generation (Gen) — the hot-swappable unit behind `/api/config`.
 *
 * A generation is `{ runtime, profile, sanitized config, epoch }`, and every
 * field derives from the SAME profile, so a reader can never observe a mixed
 * state (model from one compose, session from another). The swap protocol is a
 * single synchronous pointer flip followed by old-generation teardown:
 *
 *   1. flip      `this.gen = next` — atomic in the reader's eyes: a reader holds
 *                either the previous object or the next one, never a blend;
 *   2. migrate   pending host receipts are moved from the old generation's
 *                mailbox onto the new one, so a receipt that arrived during the
 *                swap is not lost with the generation it was addressed to (W240);
 *   3. teardown  the previous generation is shut down and released AFTER the
 *                flip — its drivers stop, its mailbox is purged, its registry
 *                cleared, its handles dropped (W248).
 *
 * `buildAndSwap` composes the next generation through an injected factory, so
 * this module never imports `compose` (no cycle) and a test can swap in a fake.
 */

import { ComposeError } from "./errors.js";
import type { Profile } from "./profile.js";
import type { Runtime } from "./runtime.js";
import { sanitizeProfile, type SanitizedConfig } from "./sanitize.js";
import { HOST_SESSION_ID } from "./tokens.js";

/** One generation: the runtime, the profile it was built from, its safe config. */
export interface Gen {
  readonly runtime: Runtime;
  readonly profile: Profile;
  readonly config: SanitizedConfig;
  readonly epoch: number;
}

export interface GenSwapResult {
  epoch: number;
  prevEpoch: number | null;
  /** Host receipts migrated from the previous generation's mailbox. */
  migrated: number;
}

export interface GenerationHubOptions {
  /** Queue key the host receipts are addressed to (default `cli-main`). */
  hostSessionId?: string;
  /** Builds the next generation; `compose(profile)` at the composition root. */
  build?: (profile: Profile) => Runtime | Promise<Runtime>;
  /** Observers notified after a swap, in registration order. */
  onSwap?: (next: Gen, prev: Gen | null) => void;
}

/** A generation from a runtime + the profile it was composed from. */
export function createGen(runtime: Runtime, profile: Profile, epoch = 0): Gen {
  return { runtime, profile, config: sanitizeProfile(profile), epoch };
}

export class GenerationHub {
  private gen: Gen | null = null;
  private epochCounter = 0;
  private swaps = 0;
  private readonly listeners: Array<(next: Gen, prev: Gen | null) => void> = [];
  private readonly opts: GenerationHubOptions;

  constructor(opts: GenerationHubOptions = {}) {
    this.opts = opts;
    if (opts.onSwap !== undefined) this.listeners.push(opts.onSwap);
  }

  /** The current generation (throws before the first install). */
  current(): Gen {
    const gen = this.gen;
    if (gen === null) throw new ComposeError("no generation installed");
    return gen;
  }

  /** The current generation, or null when none is installed yet. */
  peek(): Gen | null {
    return this.gen;
  }

  /** Current epoch (0 before the first install). */
  get epoch(): number {
    return this.gen?.epoch ?? 0;
  }

  /** How many swaps happened (diagnostics / tests). */
  get swapCount(): number {
    return this.swaps;
  }

  /** Install the first generation (also a swap when one already exists). */
  install(runtime: Runtime, profile: Profile): Gen {
    return this.swapSync(runtime, profile).gen;
  }

  /** Flip + migrate, synchronously; the previous generation is NOT torn down. */
  swapSync(runtime: Runtime, profile: Profile): { gen: Gen; result: GenSwapResult } {
    const prev = this.gen;
    const next = createGen(runtime, profile, ++this.epochCounter);
    this.gen = next;
    const migrated = prev === null ? 0 : migrateReceipts(prev.runtime, runtime, this.hostSessionId());
    this.swaps += 1;
    for (const listener of this.listeners) listener(next, prev);
    return { gen: next, result: { epoch: next.epoch, prevEpoch: prev?.epoch ?? null, migrated } };
  }

  /** Flip, migrate, then shut down and release the previous generation. */
  async swap(runtime: Runtime, profile: Profile): Promise<GenSwapResult> {
    const prev = this.gen;
    const { result } = this.swapSync(runtime, profile);
    if (prev !== null) await teardown(prev.runtime);
    return result;
  }

  /** Compose the next generation through `build`, then swap it in. */
  async buildAndSwap(profile: Profile): Promise<GenSwapResult> {
    const build = this.opts.build;
    if (build === undefined) throw new ComposeError("GenerationHub has no build factory");
    const runtime = await build(profile);
    return this.swap(runtime, profile);
  }

  /** Subscribe to swaps; the returned function unsubscribes. */
  onSwap(listener: (next: Gen, prev: Gen | null) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Shut down and release the current generation (idempotent). */
  async shutdown(): Promise<void> {
    const gen = this.gen;
    this.gen = null;
    if (gen !== null) await teardown(gen.runtime);
  }

  private hostSessionId(): string {
    return this.opts.hostSessionId ?? HOST_SESSION_ID;
  }
}

/**
 * Move pending host receipts from one generation's mailbox onto the next.
 *
 * `== null` on purpose (W769): a generation composed without worker wiring has no
 * `workers` at all, and the W769 caller runs inside a session rebuild where a
 * missing wiring must be a no-op, never a crash.
 */
export function migrateReceipts(from: Runtime, to: Runtime, hostSessionId: string): number {
  const source = from.workers;
  const target = to.workers;
  if (source == null || target == null) return 0;
  const pending = source.mailbox.poll(hostSessionId);
  for (const msg of pending) target.mailbox.send(hostSessionId, msg.content, msg.from_label);
  return pending.length;
}

async function teardown(runtime: Runtime): Promise<void> {
  await runtime.shutdown();
  runtime.release();
}
