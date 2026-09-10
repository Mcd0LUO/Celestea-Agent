/**
 * SessionInbox — the per-session mid-turn injection queue (W513).
 *
 * One inbox per session runtime instance. It is the ONE place a message can be
 * delivered into a turn that is ALREADY RUNNING:
 *
 *   - `POST /api/turn` on a busy session pushes here instead of 409-ing
 *     (the host handler calls `Runtime.inject`);
 *   - a worker receipt addressed to this session lands in the session mailbox
 *     and is pumped through the same drain at the next step boundary.
 *
 * The turn driver drains the queue at two points: before the turn's input (turn
 * start) and before every model call (step boundary). Draining appends ordinary
 * `user_message` rows to the session log, so the injected text is real,
 * model-visible history and the turn is neither interrupted nor restarted.
 */

/** One message waiting to be appended to the session log. */
export interface InjectedMessage {
  text: string;
  /** Attribution label (`""` = the user, otherwise `[from <label>] text`). */
  from: string;
  /** Arrival time (diagnostics / tests). */
  at: number;
}

/** FIFO queue of pending injections (never throws, never blocks). */
export interface SessionInbox {
  /** Queue one message; returns the queued entry. */
  push(text: string, from?: string): InjectedMessage;
  /** Take everything queued so far, in arrival order. */
  drain(): InjectedMessage[];
  /** Queued-but-not-yet-injected messages. */
  pending(): number;
}

/** Build one inbox; `now` is injectable so tests can pin arrival times. */
export function createSessionInbox(now: () => number = Date.now): SessionInbox {
  const queue: InjectedMessage[] = [];
  return {
    push(text: string, from = ""): InjectedMessage {
      const message: InjectedMessage = { text, from, at: now() };
      queue.push(message);
      return message;
    },
    drain(): InjectedMessage[] {
      return queue.splice(0, queue.length);
    },
    pending(): number {
      return queue.length;
    },
  };
}
