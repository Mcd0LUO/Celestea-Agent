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

  return {
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
        hooks.onQueued?.(message, placementOfLane(lane));
      }
      return message;
    },
    drain(lane: InjectionLane): InjectedMessage[] {
      const taken = lanes[lane].splice(0, lanes[lane].length);
      for (const message of taken) hooks.onDelivered?.(message);
      return taken;
    },
    pending(lane?: InjectionLane): number {
      if (lane !== undefined) return lanes[lane].length;
      return lanes["next-turn"].length + lanes["next-step"].length;
    },
  };
}
