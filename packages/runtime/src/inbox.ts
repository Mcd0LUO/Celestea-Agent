/**
 * SessionInbox — the per-session delivery queue with TWO LANES (W513 + W515 §1).
 *
 * One inbox per session runtime instance. It is the ONE place a message can be
 * delivered into a session, and the lane it lands in decides WHEN it is seen:
 *
 *   - `next-turn` — drained by the turn driver at the TURN START, before the
 *     turn's own input (a follow-up sent while the session is idle; a receipt
 *     that arrived while nothing was running). Reported as `placement: "queued"`.
 *   - `next-step` — drained by the loop at EVERY STEP BOUNDARY, right before the
 *     next model call (a user interjection sent while the turn is running; a
 *     receipt that arrives mid-turn). Reported as `placement: "steering"`.
 *
 * Invariants:
 *   - a message with an `id` already accepted is DROPPED as a duplicate (a
 *     receipt delivered twice is injected once);
 *   - while `next-step` is non-empty the turn must not reach its terminal state
 *     (enforced by the loop, see `@celestea/agent-loop`);
 *   - both transport paths (a host API call and a session-mailbox receipt) end
 *     in the same lanes, so the injection mechanism is literally the same one.
 *
 * The two hooks (`onQueued`, `onDelivered`) let the host publish the placement
 * over SSE without the inbox knowing anything about a transport.
 *
 * E §1.3 P1 ①: the lanes and the dedup ledger are PERSISTABLE. `bindPersistence`
 * attaches a sink (the session's `checkpoint.json`, see `inbox-checkpoint.ts`);
 * binding RESTORES whatever the previous process left queued and then writes on
 * every change, so "accepted but not yet injected" survives a crash — the
 * G1-4 failure mode, where a user's message vanished silently.
 *
 * Restoration is DELIBERATELY silent (no `onQueued` hook): a message queued by a
 * process that died was already announced by that process, and re-announcing it
 * would show the client a placement that did not change.
 */

import type { DeliverySource, InjectionKind, InjectionLane, InjectionPlacement } from "@celestea/core";

/** One message waiting to be appended to the session log. */
export interface InjectedMessage {
  text: string;
  /** Attribution label (`""` = the user, otherwise `[from <label>] text`). */
  from: string;
  /** Arrival time (diagnostics / tests). */
  at: number;
  /** Lane the message waits in. */
  lane: InjectionLane;
  kind: InjectionKind;
  /** Idempotency key (`""` = never deduplicated). */
  id: string;
  /** Envelope, so a settlement notice is not mistaken for a deliberate relay. */
  source: DeliverySource;
  /** True when this push was dropped because the id was already accepted. */
  duplicate: boolean;
}

export interface InboxHooks {
  /** A message was accepted into a lane (placement `queued` / `steering`). */
  onQueued?: (message: InjectedMessage, placement: InjectionPlacement) => void;
  /** A message left a lane and is now part of the model-visible log. */
  onDelivered?: (message: InjectedMessage) => void;
}

export interface SessionInbox {
  /** Move one message into `lane`; a duplicate id is dropped (`duplicate: true`). */
  push(text: string, lane: InjectionLane, opts?: InboxPushOptions): InjectedMessage;
  /** Take everything waiting in one lane, in arrival order. */
  drain(lane: InjectionLane): InjectedMessage[];
  /** Messages waiting (one lane, or both). */
  pending(lane?: InjectionLane): number;
  /** E §1.3 P1 ①: restore from, and persist every change to, `sink`. */
  bindPersistence(sink: InboxSink): void;
  /** The persistable state: both lanes plus the bounded delivered-id ledger. */
  snapshot(): InboxSnapshot;
}

/** Both lanes plus the accepted-id memory, exactly as they persist. */
export interface InboxSnapshot {
  next_turn: InjectedMessage[];
  next_step: InjectedMessage[];
  delivered_ids: string[];
}

/** Where a snapshot goes (the session's checkpoint sidecar in production). */
export interface InboxSink {
  /** The snapshot of the PREVIOUS process, or null when there is none usable. */
  load(): InboxSnapshot | null;
  save(snapshot: InboxSnapshot): void;
}

export interface InboxPushOptions {
  from?: string;
  id?: string;
  kind?: InjectionKind;
  source?: DeliverySource;
}

/** How many ids are remembered for duplicate detection (bounded memory). */
export const DELIVERED_ID_MEMORY = 512;

/** Placement a lane implies, before the drain: queued vs steering. */
export function placementOfLane(lane: InjectionLane): InjectionPlacement {
  return lane === "next-step" ? "steering" : "queued";
}

/** Build one inbox; `now` and the placement hooks are injectable. */
export function createSessionInbox(now: () => number = Date.now, hooks: InboxHooks = {}): SessionInbox {
  const lanes: Record<InjectionLane, InjectedMessage[]> = { "next-turn": [], "next-step": [] };
  const seen: string[] = [];
  const seenSet = new Set<string>();
  let sink: InboxSink | null = null;

  /** Bounded FIFO memory of accepted ids (oldest evicted first). */
  const remember = (id: string): boolean => {
    if (id === "" || !seenSet.has(id)) {
      if (id !== "") {
        seenSet.add(id);
        seen.push(id);
        if (seen.length > DELIVERED_ID_MEMORY) {
          const oldest = seen.shift();
          if (oldest !== undefined) seenSet.delete(oldest);
        }
      }
      return false;
    }
    return true;
  };

  const snapshot = (): InboxSnapshot => ({
    next_turn: lanes["next-turn"].map((m) => ({ ...m })),
    next_step: lanes["next-step"].map((m) => ({ ...m })),
    delivered_ids: [...seen],
  });

  const save = (): void => {
    try {
      sink?.save(snapshot());
    } catch (e) {
      // Persistence is observation: a sidecar that cannot be written must never
      // lose the message that is still safely in memory (the checkpoint's rule).
      process.stderr.write(`[celestea-runtime] inbox not persisted: ${String(e)}\n`);
    }
  };

  const restore = (state: InboxSnapshot): void => {
    for (const message of state.next_turn) lanes["next-turn"].push(message);
    for (const message of state.next_step) lanes["next-step"].push(message);
    // A restored message was ALREADY accepted once: re-remembering its id keeps
    // the duplicate rule valid across the restart (and across processes).
    for (const message of [...lanes["next-turn"], ...lanes["next-step"]]) remember(message.id);
    for (const id of state.delivered_ids) remember(id);
  };

  return {
    bindPersistence(next: InboxSink): void {
      sink = next;
      // Fail-safe on BOTH sides: an unreadable queue is an EMPTY queue (the same
      // discipline the recovery decision table uses) — a broken sidecar must
      // never stop a session from composing.
      try {
        const state = next.load();
        if (state !== null) restore(state);
      } catch (e) {
        process.stderr.write(`[celestea-runtime] inbox not restored: ${String(e)}\n`);
      }
    },
    snapshot,
    push(text: string, lane: InjectionLane, opts: InboxPushOptions = {}): InjectedMessage {
      const id = opts.id ?? "";
      const message: InjectedMessage = {
        text,
        from: opts.from ?? "",
        at: now(),
        lane,
        kind: opts.kind ?? "user",
        id,
        source: opts.source ?? { kind: "user", form: "message" },
        duplicate: remember(id),
      };
      if (!message.duplicate) {
        lanes[lane].push(message);
        save();
        hooks.onQueued?.(message, placementOfLane(lane));
      }
      return message;
    },
    drain(lane: InjectionLane): InjectedMessage[] {
      const taken = lanes[lane].splice(0, lanes[lane].length);
      if (taken.length > 0) save();
      for (const message of taken) hooks.onDelivered?.(message);
      return taken;
    },
    pending(lane?: InjectionLane): number {
      if (lane !== undefined) return lanes[lane].length;
      return lanes["next-turn"].length + lanes["next-step"].length;
    },
  };
}
