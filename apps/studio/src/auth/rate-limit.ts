/**
 * W767 — login failure limiter (fixed 60 s window).
 *
 * Counted per USERNAME and per CLIENT IP separately, so neither "spray one
 * password over many accounts" nor "spray many passwords at one account" gets a
 * free run, while a legitimate user behind a shared IP is only slowed after the
 * same key fails repeatedly. Only FAILURES count; a success clears both keys of
 * that attempt. In-memory on purpose: Studio is a single process, the window is
 * one minute, and the counter must not survive a restart as a lockout.
 */

/** Window length in ms (the spec's 60 s). */
export const AUTH_WINDOW_MS = 60_000;
/** Failures allowed inside one window before 429. */
export const AUTH_MAX_FAILURES = 5;
/** Ceiling on tracked keys: a spray can never grow the map without bound. */
const MAX_KEYS = 4_096;

export interface FailureLimiter {
  /** true = the key already exhausted its window (the caller answers 429). */
  blocked(key: string): boolean;
  /** Record one failure for the key (opens/extends its window). */
  fail(key: string): void;
  /** Forget the key (a successful login). */
  clear(key: string): void;
}

export function createFailureLimiter(opts: {
  now: () => number;
  windowMs?: number;
  maxFailures?: number;
}): FailureLimiter {
  const windowMs = opts.windowMs ?? AUTH_WINDOW_MS;
  const maxFailures = opts.maxFailures ?? AUTH_MAX_FAILURES;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    blocked(key: string): boolean {
      const entry = hits.get(key);
      return entry !== undefined && entry.resetAt > opts.now() && entry.count >= maxFailures;
    },
    fail(key: string): void {
      const now = opts.now();
      prune(hits, now);
      if (hits.size >= MAX_KEYS) hits.clear();
      const entry = hits.get(key);
      if (entry === undefined || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    clear(key: string): void {
      hits.delete(key);
    },
  };
}

function prune(hits: Map<string, { count: number; resetAt: number }>, now: number): void {
  for (const [key, entry] of hits) {
    if (entry.resetAt <= now) hits.delete(key);
  }
}
