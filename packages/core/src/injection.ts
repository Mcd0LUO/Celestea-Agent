/**
 * Mid-turn delivery seam (W513, aligned with W515 §1-§4).
 *
 * A running turn must be able to RECEIVE something without being interrupted and
 * without starting a new turn. Two LANES carry it, exactly like the DSH agent
 * inbox (`agent-loop/src/inbox.ts`), and where a message lands is reported back
 * to the caller as a `placement`:
 *
 *   - **next-turn** — drained at the TURN START, before the turn's own input.
 *     A user follow-up sent while the session is idle, or a receipt that arrived
 *     while nothing was running, lands here (`placement: "queued"`).
 *   - **next-step** — drained at every STEP BOUNDARY, right before the next model
 *     call (`placement: "steering"`). A user interjection sent while the turn is
 *     RUNNING, or a receipt that arrives mid-turn, lands here. The turn MUST NOT
 *     reach its terminal state while this lane is non-empty.
 *   - **context** — the message was already appended to the model-visible log
 *     (it is drained), which is what the SSE reports once a lane is consumed.
 *
 * A message also carries an ENVELOPE (`source`) so a subagent SETTLEMENT notice
 * ("worker W1 finished, report at …") is never confused with a proactive relay
 * message a subagent sent on purpose, plus an idempotency `id` so a receipt that
 * is delivered twice is injected once.
 */

/** Where an accepted message is going to land (the API/SSE `placement` field). */
export type InjectionPlacement = "queued" | "steering" | "context";

/** The lane a message waits in. */
export type InjectionLane = "next-turn" | "next-step";

/** What kind of envelope a message carries (receipt vs. human/relay text). */
export type InjectionKind = "user" | "receipt" | "relay";

/** Envelope of a delivered message (aligned with the DSH `source` object). */
export interface DeliverySource {
  /** `subagent-settled` = a mechanical completion notice; `worker-relay` = on purpose. */
  kind: "user" | "subagent-settled" | "worker-relay";
  /** `notice` = one-line settlement; `message` = ordinary conversation text. */
  form: "notice" | "message";
  /** One-line summary (receipts only). */
  summary?: string;
  /** Conversation the message came from (the mailbox `from_label`). */
  senderSessionId?: string;
}

/** One message waiting to be appended to the log. */
export interface PendingInjection {
  text: string;
  /** Attribution label; `""` renders the text verbatim. */
  from: string;
  /** Idempotency key (absent = never deduplicated). */
  id?: string;
  kind?: InjectionKind;
  source?: DeliverySource;
  /** Lane it waits in (informational for a drained message). */
  lane?: InjectionLane;
}

/** The seam a turn driver hands to the loop. */
export interface InjectionSource {
  /** Take everything pending for the STEP lane, in arrival order. */
  drain(): readonly PendingInjection[];
  /** How many STEP-lane messages are still waiting (close guard, W515 §1). */
  pending?(): number;
}

/** `[from <label>] text`, or the bare text for the user's own interjections. */
export function formatInjection(injection: PendingInjection): string {
  return injection.from === "" ? injection.text : `[from ${injection.from}] ${injection.text}`;
}
