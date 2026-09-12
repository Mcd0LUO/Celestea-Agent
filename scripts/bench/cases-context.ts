/**
 * (a) The per-tick context cost — the ONLY overhead W755 added to the statusline.
 *
 * `Runtime.statusline()` is polled by the host and pushed on every SSE tick
 * (`STATUS_TICK_MS` = 2s), and since W755 its `context_usage` falls back to the
 * loop's OWN assembly (`Runtime.statusView().assembled()` ->
 * `Runtime.contextSnapshot()` -> `DefaultAgentLoop.buildRequest`). So one tick
 * costs a full history projection plus a trim decision over the session's whole
 * log — that is what this file measures, at three scales, through the public
 * runtime entry points (no stubbing of the code under test).
 *
 * W762 split the measurement in two, because the runtime now memoizes the
 * assembly on the log's state:
 *   `[assembly]`     the loop's own `buildRequest`, reached directly — the cost
 *                    a tick pays when the log CHANGED since the previous read;
 *   `[repeat read]`  the runtime entry with the log unchanged — a cache hit,
 *                    i.e. what an idle session's polls cost.
 * `statusline() [cold]` / `[tick]` are the same pair one level up (the tick also
 * re-estimates the request it was handed, so a hit is not free).
 * `[no snapshot]` remains the A/B baseline: the same payload with
 * `assembled:()=>null`, so `tick - it` is the W755 overhead. `[over budget]`
 * rows show the same paths with the trim pass ENGAGED (see `cases-tokens.ts`).
 */

import { statuslineOf, type StatusView } from "@celestea/runtime";
import { caseOf, timeValue, type BenchCase, type Timing } from "./timing.js";
import { scaleLabel, type Fixture } from "./fixtures.js";

/** Window of the over-budget rows (forces the trim path; `TIGHT_WINDOW`). */
const TIGHT_CASES = [1_000, 10_000] as const;

function share(snapshot: number, tick: number): number {
  return tick === 0 ? 0 : Math.round((snapshot / tick) * 1_000) / 10;
}

const ASSEMBLY_NOTE = "W755: the request the next step would build (system + derived history + tool schemas), reached through the loop so the W762 cache is out of the way";
const READ_NOTE = "W762: the runtime entry with the log unchanged since the last read — a memoized hit (key = log identity + event count + last event reference)";

/** The tick with a COLD assembly: the view's `assembled` goes straight to the loop. */
function coldView(fixture: Fixture): StatusView {
  return { ...fixture.runtime.statusView(), assembled: () => fixture.loop.contextSnapshot(fixture.runtime.ctx) };
}

/** One scale: assembly, cached read, cold tick, warm tick, and the A/B baseline. */
function rowsForScale(fixture: Fixture): BenchCase[] {
  const assembly = timeValue(() => fixture.loop.contextSnapshot(fixture.runtime.ctx).messages.length);
  const repeat = timeValue(() => fixture.runtime.contextSnapshot()?.messages.length ?? 0);
  const coldTick = timeValue(() => statuslineOf(coldView(fixture)).context_usage.used);
  const tick = timeValue(() => fixture.runtime.statusline().context_usage.used);
  const noSnapshotView: StatusView = { ...fixture.runtime.statusView(), assembled: () => null };
  const tickNoSnapshot = timeValue(() => statuslineOf(noSnapshotView).context_usage.used);
  const sharePct = share(assembly.median_ms, coldTick.median_ms);
  const extra = { events: fixture.events, messages: fixture.messages, estimate_tokens: fixture.estimate_tokens };
  return [
    caseOf("contextSnapshot() [assembly]", scaleLabel(fixture), assembly, ASSEMBLY_NOTE, extra),
    caseOf("contextSnapshot() [repeat read]", scaleLabel(fixture), repeat, READ_NOTE, extra),
    caseOf("statusline() [cold]", scaleLabel(fixture), coldTick, "the tick when the log changed since the last read: statusView() + statuslineOf() over a fresh assembly", { ...extra, snapshot_share_pct: sharePct }),
    caseOf("statusline() [tick]", scaleLabel(fixture), tick, "the public tick as the host calls it; consecutive calls with an unchanged log hit the W762 cache", { ...extra, snapshot_share_pct: sharePct }),
    caseOf("statusline() [no snapshot]", scaleLabel(fixture), tickNoSnapshot, "A/B baseline: the same payload with assembled:()=>null; cold tick - this = the W755 overhead", {
      ...extra,
      w755_overhead_ms: Math.round((coldTick.median_ms - tickNoSnapshot.median_ms) * 1_000) / 1_000,
      snapshot_share_pct: sharePct,
    }),
  ];
}

/** The same paths when the session is OVER budget: the trim pass runs per read. */
function rowsForTightWindow(fixture: Fixture): BenchCase[] {
  const assembly = timeValue(() => fixture.tightLoop.contextSnapshot(fixture.tightRuntime.ctx).messages.length);
  const repeat = timeValue(() => fixture.tightRuntime.contextSnapshot()?.messages.length ?? 0);
  const extra = { events: fixture.events, messages: fixture.messages, estimate_tokens: fixture.estimate_tokens };
  return [
    caseOf("contextSnapshot() [over budget, assembly]", scaleLabel(fixture), assembly, "context_window=2,000 tokens: history + trim pass (see trimContext rows)", extra),
    caseOf("contextSnapshot() [over budget, repeat read]", scaleLabel(fixture), repeat, "the same over-budget session read twice with no append in between (W762 cache hit)", extra),
  ];
}

/** Every (a) row: three scales x five rows + the over-budget regime. */
export function contextCases(fixtures: readonly Fixture[]): BenchCase[] {
  const rows = fixtures.flatMap(rowsForScale);
  const tight = fixtures.filter((f) => TIGHT_CASES.includes(f.scale as (typeof TIGHT_CASES)[number]));
  return [...rows, ...tight.flatMap(rowsForTightWindow)];
}
