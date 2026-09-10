/**
 * Small async helpers shared by the sandbox and the process registry: a
 * timeout race (without leaking timers) and a bounded poll.
 */

/** Sentinel returned by [withTimeout] when the deadline won the race. */
export const TIMED_OUT = Symbol("timed-out");

export type TimeoutResult<T> = T | typeof TIMED_OUT;

/** Race a promise against a deadline; the timer is always cleared. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
