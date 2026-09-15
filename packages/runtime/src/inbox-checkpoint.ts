/**
 * The inbox's persistence sink over one session's `checkpoint.json` (E §1.3 P1 ①).
 *
 * WHY the checkpoint and not a file of its own: §1.2.1 fixes the classification —
 * "everything derivable from `cli-main.jsonl` is NOT persisted twice" — and the
 * two queue lanes plus the accepted-id ledger are exactly the facts the log
 * cannot express. Putting them in the sidecar also means ONE atomic write path
 * (tmp-<pid> + rename, mode 0600) for every non-log fact of the session.
 *
 * The sink is intentionally tiny and total: `load()` returns null for a missing,
 * corrupt or foreign sidecar (a queue that cannot be read is simply empty — the
 * same fail-safe discipline the recovery decision table uses), and `save()`
 * never throws (the store reports its own failures on stderr).
 */

import type { CheckpointLaneMessage, CheckpointStore } from "@celestea/session";
import type { InboxSink, InboxSnapshot, InjectedMessage } from "./inbox.js";

/** Bind an inbox to the session sidecar's two lanes + delivered-id ledger. */
export function checkpointInboxSink(store: CheckpointStore): InboxSink {
  return {
    load(): InboxSnapshot | null {
      const persisted = store.persistedQueues();
      if (persisted === null) return null;
      return {
        // Writing is structurally compatible (a message IS a lane message); the
        // read direction narrows `lane`/`kind`/`source`, which only the inbox can
        // guarantee — hence exactly one cast, at the boundary (K1: no sibling
        // import just to share the type).
        next_turn: persisted.lanes.next_turn as unknown as InjectedMessage[],
        next_step: persisted.lanes.next_step as unknown as InjectedMessage[],
        delivered_ids: persisted.delivered_ids,
      };
    },
    save(snapshot: InboxSnapshot): void {
      const write = (messages: readonly InjectedMessage[]): CheckpointLaneMessage[] => [...messages];
      store.lanesChanged(write(snapshot.next_turn), write(snapshot.next_step), snapshot.delivered_ids);
    },
  };
}
