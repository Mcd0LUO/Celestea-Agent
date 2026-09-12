/**
 * (a) The per-tick context cost — the ONLY overhead W755 added to the statusline.
 *
 * `Runtime.statusline()` is polled by the host and pushed on every SSE tick
 * (`STATUS_TICK_MS` = 2s), and since W755 its `context_usage` falls back to the
 * loop's OWN assembly (`Runtime.statusView().assembled()` ->
 * `Runtime.contextSnapshot()` -> `DefaultAgentLoop.buildRequest`). So one tick
 * now costs a full history projection plus a trim decision, on the session's
 * whole log — that is what this file measures, at three scales, through the
 * public runtime entry points (no stubbing of the code under test).
 *
 * The A/B row pair makes the W755 share visible instead of asserting it:
 *   `statusline()`                     the real public tick (view + snapshot)
 *   `statusline() [no snapshot]`       the same payload with `assembled: null`
 * The difference is the price of the new overhead; `[over budget]` rows show the
 * same tick when the trim path is ENGAGED (see `cases-tokens.ts` for the pass
 * itself).
 */

import { statuslineOf, type StatusView } from "@celestea/runtime";
import { caseOf, timeValue, type BenchCase, type Timing } from "./timing.js";
import { scaleLabel, type Fixture } from "./fixtures.js";

/** Window of the over-budget rows (forces the trim path; `TIGHT_WINDOW`). */
const TIGHT_CASES = [1_000, 10_000] as const;

function snapshotRow(fixture: Fixture, timing: Timing): BenchCase {
  return caseOf("contextSnapshot()", scaleLabel(fixture), timing, "W755: the request the next step would build (system + derived history + tool schemas)", {
    events: fixture.events,
    messages: fixture.messages,
    estimate_tokens: fixture.estimate_tokens,
    amplification_turns: fixture.amplification_turns,
  });
}

function share(snapshot: number, tick: number): number {
  return tick === 0 ? 0 : Math.round((snapshot / tick) * 1_000) / 10;
}

/** One scale: the snapshot, the full tick, and the tick without the snapshot. */
function rowsForScale(fixture: Fixture): BenchCase[] {
  const snapshot = timeValue(() => fixture.runtime.contextSnapshot()?.messages.length ?? 0);
  const tick = timeValue(() => fixture.runtime.statusline().context_usage.used);
  const noSnapshotView: StatusView = { ...fixture.runtime.statusView(), assembled: () => null };
  const tickNoSnapshot = timeValue(() => statuslineOf(noSnapshotView).context_usage.used);
  const sharePct = share(snapshot.median_ms, tick.median_ms);
  return [
    snapshotRow(fixture, snapshot),
    caseOf("statusline()", scaleLabel(fixture), tick, "the real public tick: statusView() + statuslineOf() (includes the snapshot above)", {
      events: fixture.events,
      messages: fixture.messages,
      snapshot_share_pct: sharePct,
    }),
    caseOf("statusline() [no snapshot]", scaleLabel(fixture), tickNoSnapshot, "A/B baseline: the same payload with assembled:()=>null; tick - this = the W755 overhead", {
      events: fixture.events,
      w755_overhead_ms: Math.round((tick.median_ms - tickNoSnapshot.median_ms) * 1_000) / 1_000,
      snapshot_share_pct: sharePct,
    }),
  ];
}

/** The tick when the session is OVER budget: the trim pass runs on every read. */
function rowsForTightWindow(fixture: Fixture): BenchCase[] {
  const tight = timeValue(() => fixture.tightRuntime.contextSnapshot()?.messages.length ?? 0);
  return [
    caseOf("contextSnapshot() [over budget]", scaleLabel(fixture), tight, "context_window=2,000 tokens: the trim pass dominates the tick (see trimContext rows)", {
      events: fixture.events,
      messages: fixture.messages,
      estimate_tokens: fixture.estimate_tokens,
    }),
  ];
}

/** Every (a) row: three scales x three rows + the over-budget regime. */
export function contextCases(fixtures: readonly Fixture[]): BenchCase[] {
  const rows = fixtures.flatMap(rowsForScale);
  const tight = fixtures.filter((f) => TIGHT_CASES.includes(f.scale as (typeof TIGHT_CASES)[number]));
  return [...rows, ...tight.flatMap(rowsForTightWindow)];
}
