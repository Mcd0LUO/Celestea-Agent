/**
 * W794 — releasing the engine generation of a session whose DIRECTORY is going
 * away (deleted into `<ws>/.celestea-trash/`, or archived).
 *
 * Extracted from `real-runtime-adapter.ts` for the same reason
 * `session-lifecycle.ts` was (W787): the adapter is the HTTP seam and sits on the
 * §4.1 file budget, while "cut the response in flight, then hand the generation
 * back" is about a session's lifetime, not about the seam.
 *
 * 裁决 background: the active marker is a state label, not a protection, so a
 * session can be removed while it is streaming an answer. Deleting it must (a)
 * SUCCEED and (b) leave nothing of it running — no model response mid-flight, no
 * instance quietly writing into a directory that moved, no auto-wake loop probing
 * for a generation that can never come back.
 */

import type { SessionRuntime, SessionRuntimeRegistry } from "@celestea/runtime";
import { limitFromEnv } from "./session-compose.js";

/**
 * Default budget of the settle wait below. Generous enough for a cooperative
 * abort of a real step; short enough that a wedged turn cannot hold a delete
 * request open. `CELESTEA_RELEASE_SETTLE_MS` overrides it.
 */
export const RELEASE_SETTLE_MS = 1_500;
/** Poll granularity of that wait. */
const SETTLE_POLL_MS = 5;

/** The effective release-settle budget of one process. */
export function releaseSettleMs(env: NodeJS.ProcessEnv): number {
  return limitFromEnv(env, "CELESTEA_RELEASE_SETTLE_MS", RELEASE_SETTLE_MS);
}

export interface SessionReleaseDeps {
  registry: SessionRuntimeRegistry;
  /** The adapter's cooperative abort — the SAME one `POST /api/cancel` sends. */
  cancel: (session: string) => boolean;
  /** W769: unpark the session's auto-wake loop for good. */
  forget: (session: string) => Promise<void>;
  /** How long to wait for the aborted turn to settle. */
  settleMs: number;
}

/**
 * Cut the session's in-flight model response and drop ITS generation.
 *
 * Three steps, in this order and for these reasons:
 *   1. `cancel(session)` — the cooperative abort, because it is the only path
 *      that unwinds a step cleanly (the loop writes its own `turn_end:
 *      cancelled`); a removal may not leave a response streaming into a
 *      directory that is leaving;
 *   2. wait (bounded by `settleMs`) for that turn to settle, so the log write
 *      lands and no writer survives when the directory moves;
 *   3. `registry.release` — detach + dispose THIS instance through the very
 *      disposer an evict/rebuild uses. The session's next activate/turn composes
 *      a fresh generation on demand; no other session and no process-wide
 *      generation is touched.
 *
 * `false` = this session had no live instance (an unknown id, or one that was
 * never used) — nothing to cut, which is what makes the call safe for every id
 * of a batch. `null` (the detached default generation) is never released.
 */
export async function releaseSessionOf(deps: SessionReleaseDeps, session: string | null): Promise<boolean> {
  if (session === null) return false;
  const entry = deps.registry.peek(session);
  if (entry === null) return false;
  if (entry.inFlight) {
    deps.cancel(session);
    await awaitSettled(entry, deps.settleMs);
  }
  await deps.forget(session);
  return deps.registry.release(session);
}

/**
 * Wait — with a REAL clock, whatever `opts.now` says — for an aborted turn to
 * reach its terminal state. Polling rather than a callback keeps the wait
 * independent of which teardown path ends the turn (settled turn, failed turn,
 * the `drive()` tail), which is exactly the set we cannot enumerate from here. A
 * timeout is not an error: the instance is force-released either way, it only
 * means the log write may have lost the race.
 */
async function awaitSettled(entry: SessionRuntime, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (entry.inFlight && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, SETTLE_POLL_MS));
  return !entry.inFlight;
}
