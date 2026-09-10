/**
 * Cooperative cancellation — the AbortSignal counterpart of the Rust loop's
 * `watch::Receiver<bool>` checkpoints (`cancel_set` / `wait_cancel`).
 *
 * Rust awaits every interruptible step inside a `tokio::select!` against a
 * cancellation future; the TS port races the same checkpoints against an
 * [AbortSignal]. The differences are deliberate and documented in README.md:
 *   - the signal is owned by the CALLER (host HTTP route / CLI), not built by
 *     the loop, so one controller can abort a whole turn and be reused by the
 *     next one;
 *   - `raceAbort` never rejects: a rejected `work` is reported as
 *     `{ outcome: "failed" }`, so the loop can keep the five-state contract
 *     instead of leaking a seam exception;
 *   - abandoning in-flight work must not raise an unhandled rejection, so the
 *     loser of every race gets a no-op catch attached.
 */

/** W267: canonical error text of a synthesized ToolResult for a call that
 * never ran because the turn was cancelled mid-dispatch. Shared by the session
 * append and the emitted event so both sides carry the exact same string. */
export const CANCELLED_BEFORE_EXECUTION = "cancelled before execution";

/** Why an in-flight promise stopped being awaited. */
export type RaceResult<T> =
  | { outcome: "ok"; value: T }
  | { outcome: "aborted" }
  | { outcome: "failed"; error: unknown };

function ignore(): void {
  // Deliberate no-op: the loser of a race only needs its rejection consumed.
}

function settled<T>(work: Promise<T>): Promise<RaceResult<T>> {
  return work.then(
    (value): RaceResult<T> => ({ outcome: "ok", value }),
    (error: unknown): RaceResult<T> => ({ outcome: "failed", error }),
  );
}

/** True when cancellation was already signalled (a synchronous checkpoint). */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Await `work`, but give up as soon as `signal` aborts. Re-checks the current
 * value first, so it is safe to call at every checkpoint of a turn.
 */
export function raceAbort<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<RaceResult<T>> {
  if (signal === undefined) return settled(work);
  if (signal.aborted) {
    void work.catch(ignore);
    return Promise.resolve({ outcome: "aborted" });
  }
  return new Promise<RaceResult<T>>((resolve) => {
    const onAbort = (): void => {
      void work.catch(ignore);
      resolve({ outcome: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ outcome: "ok", value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ outcome: "failed", error });
      },
    );
  });
}

/**
 * Best-effort close of an async iterator abandoned on cancellation: releases
 * the provider stream (and its socket) instead of leaving it suspended. A
 * close failure is irrelevant to the turn, which is already terminal.
 */
export function closeIterator<T>(iter: AsyncIterator<T>): void {
  const close = iter.return;
  if (close === undefined) return;
  void Promise.resolve(close.call(iter)).catch(ignore);
}

/** The message of a thrown value, for seam errors that arrive as `unknown`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
