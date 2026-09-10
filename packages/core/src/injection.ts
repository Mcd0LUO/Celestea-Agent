/**
 * Mid-turn injection seam (W513).
 *
 * A running turn must be able to RECEIVE something without being interrupted and
 * without starting a new turn: the user sends another message while the agent is
 * working, or a worker receipt arrives mid-turn. Both are appended to the
 * session log as `user_message` rows at a STEP BOUNDARY — right before the next
 * model call — so the model sees them in the same turn.
 *
 * The source lives with the turn driver (one per session runtime) and reaches
 * the loop through the loop bindings: the loop itself owns no queue and imports
 * no runtime type.
 */

/** One message waiting to be appended to the log at the next step boundary. */
export interface PendingInjection {
  text: string;
  /** Attribution label; `""` renders the text verbatim. */
  from: string;
}

/** The drain handle a turn driver hands to the loop. */
export interface InjectionSource {
  /** Take everything pending, in arrival order (never blocks). */
  drain(): readonly PendingInjection[];
}

/** `[from <label>] text`, or the bare text for the user's own interjections. */
export function formatInjection(injection: PendingInjection): string {
  return injection.from === "" ? injection.text : `[from ${injection.from}] ${injection.text}`;
}
