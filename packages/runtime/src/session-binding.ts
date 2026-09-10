/**
 * Session binding — how a generation is tied to ONE conversation.
 *
 * A binding is (session id + directory + a way to open the log). Keeping the
 * opener as a callback is what lets the runtime stay out of the persistence
 * business: `packages/session` owns JSONL replay/repair, the host passes
 * `() => PersistentSessionLog.open(dir, id)`, and the runtime only knows the
 * `SessionLog` seam.
 *
 * Rebinding re-opens the SAME directory/id (`binding.open()` again) and
 * re-provides the result under `SESSION_LOG_SERVICE`; a later `provide` of the
 * same token replaces the earlier one, so every consumer that resolves the
 * service lazily (the agent loop does, per turn) sees the new log while an
 * in-flight reader keeps the object it already holds.
 */

import { SESSION_LOG_SERVICE, type Context, type SessionLog } from "@celestea/core";
import { ComposeError } from "./errors.js";

export interface SessionBinding {
  /** Conversation id (`<workspace>/<session>` or the host id). */
  readonly sessionId: string;
  /** Session directory; the same value is reused by every rebind. */
  readonly dir: string | null;
  /** Open (or re-open) the log for this binding. Called at compose and on rebind. */
  open(): SessionLog;
}

export interface SessionBindingSpec {
  sessionId: string;
  dir?: string | null;
  open: () => SessionLog;
}

/** Ergonomic constructor for a binding (a plain object literal also works). */
export function createSessionBinding(spec: SessionBindingSpec): SessionBinding {
  return { sessionId: spec.sessionId, dir: spec.dir ?? null, open: spec.open };
}

/**
 * Open the binding and provide it into the context (last `provide` wins). The
 * opened log is returned so the caller can keep a direct handle.
 */
export function bindSession(ctx: Context, binding: SessionBinding): SessionLog {
  const log = binding.open();
  if (log === undefined || log === null) {
    throw new ComposeError(`session binding '${binding.sessionId}' produced no log`);
  }
  ctx.provide(SESSION_LOG_SERVICE, log);
  return log;
}
