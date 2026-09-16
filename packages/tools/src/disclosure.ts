/**
 * W806 (P0) — dynamic tool disclosure: the cache-safe second hidden layer.
 *
 * `exposedRegistry` already owns the MODE fold (a static keep list). This module
 * adds the layer the design doc (`docs/feature-dynamic-tool-disclosure.md` §7.1)
 * calls for on top of it: a policy that withholds part of the mode's disclosable
 * universe and reveals it ONE TURN AT A TIME.
 *
 * The whole point is the upstream cache. The provider is billed on a strict
 * token BYTE PREFIX (`system -> tools -> messages`), so a change in the middle
 * of the tools array invalidates every cached token after it — including the
 * whole conversation history. These three invariants are therefore policy, not
 * taste (design §3.5):
 *
 *   1. **monotonic** — a name disclosed in this session is never taken back;
 *   2. **tail-append** — a newly disclosed name is appended AFTER every name
 *      already on the wire, never inserted into the middle;
 *   3. **turn boundary** — only `beginTurn()` changes the set. A refused call
 *      during a turn is only a PROPOSAL; the next turn is the first one that
 *      sees it (the design's "被拒后披露" trigger, Q1).
 *
 * Nothing here is authorization: the policy only decides what the model is
 * OFFERED. A withheld tool still runs the same guard chain when reached from a
 * `run_code` program, and a direct call is refused before execution.
 */

import { DISCLOSURE_GUIDANCE, EXECUTION_GUIDANCE, type ExposureOptions } from "./exposure.js";


/** One immutable view of the policy (diagnostics / assertions). */
export interface DisclosureSnapshot {
  /** Offered names, in stable disclosure order (baseline ++ first-disclosure). */
  readonly disclosed: readonly string[];
  /** Refused names, in universe order (blocked fold ∪ not-yet-disclosed). */
  readonly hidden: readonly string[];
}

export interface DisclosurePolicyOptions {
  /** Every registered tool name, in the baseline wire order. */
  universe: readonly string[];
  /**
   * Names offered from the start. Default: the whole non-blocked universe,
   * which is exactly today's mode baseline (so the default is a no-op).
   */
  initial?: readonly string[];
  /** Names that must NEVER be disclosed — the static mode fold it may not undo. */
  blocked?: readonly string[];
}

/**
 * The disclosure state of ONE session generation.
 *
 * Mutable by design (the live face has to move at a turn boundary), but every
 * reader gets a fresh array from `disclosed()`/`hidden()`, so a reader can
 * never observe a half-applied change: `beginTurn()` builds the promoted list
 * before it publishes anything.
 */
export class DisclosurePolicy {
  private readonly universe: readonly string[];
  private readonly universeSet: ReadonlySet<string>;
  private readonly blocked: ReadonlySet<string>;
  /** The fixed initial face, in its given order (never reordered afterwards). */
  private readonly baseline: readonly string[];
  private readonly baselineSet: ReadonlySet<string>;
  /** Names appended by a turn boundary, in first-disclosure order. */
  private readonly added: string[] = [];
  private readonly addedSet = new Set<string>();
  /** Refused-but-disclosable names seen since the last turn boundary. */
  private readonly pending: string[] = [];
  private readonly pendingSet = new Set<string>();

  constructor(options: DisclosurePolicyOptions) {
    this.universe = [...options.universe];
    this.universeSet = new Set(this.universe);
    this.blocked = new Set(options.blocked ?? []);
    const wanted = options.initial ?? this.universe;
    this.baseline = wanted.filter((name) => this.universeSet.has(name) && !this.blocked.has(name));
    this.baselineSet = new Set(this.baseline);
  }

  /**
   * The names this face offers, in stable disclosure order: the initial
   * baseline first (its own order), then every name a turn boundary appended,
   * in first-disclosure order. Append-only by construction.
   */
  disclosed(): string[] {
    return [...this.baseline, ...this.added];
  }

  /**
   * The names this face refuses: the mode fold ∪ everything not yet disclosed,
   * in universe order. Reading it is a pure function of the current state.
   */
  hidden(): string[] {
    const offered = new Set(this.disclosed());
    return this.universe.filter((name) => this.blocked.has(name) || !offered.has(name));
  }

  /** The names a `{{tools}}` rendering may announce (the static universe). */
  universeNames(): string[] {
    return [...this.universe];
  }

  /** Is `name` part of the static mode fold (never disclosable)? */
  isBlocked(name: string): boolean {
    return this.blocked.has(name);
  }

  /** Is anything withheld that could still be disclosed? */
  get active(): boolean {
    return this.hidden().some((name) => !this.blocked.has(name));
  }

  /**
   * Record a DIRECT call the face refused because `name` was not disclosed.
   * This is only a proposal: it changes nothing until [beginTurn]. Returns true
   * when the name was accepted as a proposal (known, disclosable, not already
   * offered or pending).
   */
  propose(name: string): boolean {
    if (!this.universeSet.has(name)) return false;
    if (this.blocked.has(name)) return false;
    if (this.baselineSet.has(name) || this.addedSet.has(name)) return false;
    if (this.pendingSet.has(name)) return false;
    this.pendingSet.add(name);
    this.pending.push(name);
    return true;
  }

  /**
   * The turn boundary: promote every proposal recorded since the previous call.
   * Monotonic (nothing is ever removed) and tail-appending (promotion order is
   * first-proposal order). Returns the names DISCLOSED by this call — empty
   * means the wire array is unchanged and no cache prefix is invalidated.
   */
  beginTurn(): string[] {
    const promoted: string[] = [];
    for (const name of this.pending) {
      if (this.addedSet.has(name)) continue;
      this.addedSet.add(name);
      this.added.push(name);
      promoted.push(name);
    }
    this.pending.length = 0;
    this.pendingSet.clear();
    return promoted;
  }

  /** One immutable view of this policy. */
  snapshot(): DisclosureSnapshot {
    return { disclosed: this.disclosed(), hidden: this.hidden() };
  }
}

/** The per-name guidance pair a dynamic face needs (mode fold vs withheld). */
export interface DisclosureGuidance {
  /** Prose for a name folded by the MODE (default [EXECUTION_GUIDANCE]). */
  folded?: string;
  /** Prose for a name merely not yet disclosed (default [DISCLOSURE_GUIDANCE]). */
  withheld?: string;
}

/**
 * The [ExposureOptions] of a dynamic face: `hidden`/`order` read the policy live,
 * a refused direct call becomes a proposal, and each refusal gets the prose that
 * fits WHY the name is hidden (the mode fold vs merely not-yet-disclosed).
 */
export function disclosureExposure(policy: DisclosurePolicy, guidance: DisclosureGuidance = {}): ExposureOptions {
  const folded = guidance.folded ?? EXECUTION_GUIDANCE;
  const withheld = guidance.withheld ?? DISCLOSURE_GUIDANCE;
  return {
    hidden: () => policy.hidden(),
    order: () => policy.disclosed(),
    guidanceFor: (name) => (policy.isBlocked(name) ? folded : withheld),
    onHidden: (name) => void policy.propose(name),
  };
}
