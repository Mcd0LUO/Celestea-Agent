/**
 * W815-N2: a minimal promise-chain mutex for the Studio's HOT-APPLY writes.
 *
 * Both `POST /api/prompts` (registry persist -> engine configure -> rollback)
 * and `POST /api/config` (host overrides -> engine configure) read a snapshot,
 * mutate shared state and `await` the engine; without a lock two concurrent
 * writers interleave their snapshot/rollback windows and the earlier failure can
 * erase the later success. Every task runs strictly after the previous one
 * settled (resolved OR rejected), so a caller still observes its own outcome
 * while the chain stays alive.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `task` after every previously enqueued task has settled. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // A rejected task must not poison the chain: swallow it on the tail only —
    // the caller gets the real rejection through `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
