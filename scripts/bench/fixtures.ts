/**
 * W761 synthetic session fixtures — real loop output, amplified to scale.
 *
 * A fixture is built in two documented steps:
 *
 *   1. **loop output (the template)** — a REAL `DefaultAgentLoop` (composed by
 *      `composeBenchRuntime`, driven through `Runtime.runTurn`) runs real turns
 *      over a real `projectingSessionLog` until the template holds
 *      `min(scale, TEMPLATE_EVENTS)` events. Every event in it was produced by
 *      the engine: turn markers, user/assistant text, thinking bursts, tool
 *      calls and tool results.
 *   2. **amplification (scale only)** — the template is appended again, with
 *      uniquified turn/tool ids, until the log reaches the requested scale.
 *
 * WHY amplification: the loop re-derives and re-trims the WHOLE history on every
 * step (`buildRequest`), so generating a 50k-event log turn by turn is itself
 * O(events²) — ~4 minutes of fixture building for a benchmark that then measures
 * microseconds. The amplification only repeats event SHAPES the engine emitted;
 * nothing measured is stubbed (the projection, the snapshot, the trim and the
 * statusline all run their real bodies over this log), and `amplification` is
 * recorded in every result row so the report can state it.
 */

import { memoryEventStore, projectingSessionLog, type SessionEvent, type SessionLog } from "@celestea/core";
import { estimateMessagesTokens, type DefaultAgentLoop } from "@celestea/agent-loop";
import type { Runtime } from "@celestea/runtime";
import { benchLoopOf, composeBenchRuntime, FIXTURE_TURN_INPUT, TIGHT_WINDOW } from "./seams.js";
import { nowNs } from "./timing.js";

/** Events the real loop produces before amplification takes over. */
export const TEMPLATE_EVENTS = 1_000;
/** Scales the suite runs at (events). */
export const SCALES = [1_000, 10_000, 50_000] as const;

export interface Fixture {
  /** Requested event count. */
  scale: number;
  /** Event count actually reached (the log always ends on a turn boundary). */
  events: number;
  /** Projected model-visible messages (`deriveMessages()`). */
  messages: number;
  /** Engine token estimate of that history (`estimateMessagesTokens`). */
  estimate_tokens: number;
  /** Events produced by the loop itself / appended by amplification. */
  template_events: number;
  appended_events: number;
  /** Turns the amplification replayed (a partial final round is allowed). */
  amplification_turns: number;
  /** Fixture cost: total build time and the part spent inside the real loop. */
  build_ms: number;
  loop_ms: number;
  log: SessionLog;
  runtime: Runtime;
  /** The loop mounted in `runtime` — the cache-free assembly path. */
  loop: DefaultAgentLoop;
  /** The same log under a tiny window: the over-budget (trim engaged) regime. */
  tightRuntime: Runtime;
  /** The loop mounted in `tightRuntime`. */
  tightLoop: DefaultAgentLoop;
}

function elapsedMs(start: bigint): number {
  return Math.round(Number(nowNs() - start) / 1e6);
}

/** Drive real turns until the log holds at least `target` events. */
async function driveTemplate(runtime: Runtime, log: SessionLog, target: number): Promise<number> {
  let turns = 0;
  while (log.events().length < target && turns < target) {
    await runtime.runTurn(FIXTURE_TURN_INPUT);
    turns += 1;
  }
  return log.events().length;
}

/** Re-key one template event so a replayed round cannot collide with the last. */
function rekey(event: SessionEvent, round: number): SessionEvent {
  const suffix = `#${round}`;
  switch (event.type) {
    case "turn_start":
    case "turn_end":
      return { ...event, id: `${event.id}${suffix}` };
    case "tool_call":
    case "tool_result":
      return { ...event, id: `${event.id}${suffix}` };
    default:
      return { ...event };
  }
}

/** Split the template into per-turn event groups (the engine's own boundaries). */
function turnGroups(template: readonly SessionEvent[]): SessionEvent[][] {
  const groups: SessionEvent[][] = [];
  for (const event of template) {
    if (event.type === "turn_start" || groups.length === 0) groups.push([]);
    groups[groups.length - 1]?.push(event);
  }
  return groups;
}

export interface Amplification {
  turns: number;
  appended: number;
}

/**
 * Replay template turns until the log holds at least `scale` events. Whole
 * TURNS only, so the fixture always ends on a `turn_end` boundary and no tool
 * call is left dangling; the count is tracked locally because `log.events()`
 * copies the whole array (that copy would make this O(n²)).
 */
function amplify(log: SessionLog, template: readonly SessionEvent[], scale: number): Amplification {
  const groups = turnGroups(template);
  if (groups.length === 0) return { turns: 0, appended: 0 };
  let count = log.events().length;
  const start = count;
  let turns = 0;
  let round = 0;
  while (count < scale) {
    round += 1;
    for (const group of groups) {
      if (count >= scale) break;
      for (const event of group) log.append(rekey(event, round));
      count += group.length;
      turns += 1;
    }
  }
  return { turns, appended: count - start };
}

/** What the fixture builder needs from the loop phase (one object: 5 params max). */
interface BuildInput {
  scale: number;
  log: SessionLog;
  runtime: Runtime;
  template: SessionEvent[];
  loopMs: number;
  startedAt: bigint;
}

function buildFixture(input: BuildInput): Fixture {
  const { scale, log, runtime, template, loopMs, startedAt } = input;
  const amplification = amplify(log, template, scale);
  const messages = log.deriveMessages();
  const tightRuntime = composeBenchRuntime(log, { context_window_tokens: TIGHT_WINDOW });
  return {
    scale,
    events: log.events().length,
    messages: messages.length,
    estimate_tokens: estimateMessagesTokens(messages),
    template_events: template.length,
    appended_events: amplification.appended,
    amplification_turns: amplification.turns,
    build_ms: elapsedMs(startedAt),
    loop_ms: loopMs,
    log,
    runtime,
    loop: benchLoopOf(runtime),
    tightRuntime,
    tightLoop: benchLoopOf(tightRuntime),
  };
}

/** Build one fixture: real loop output, amplified to `scale` events. */
export async function fixtureFor(scale: number): Promise<Fixture> {
  const startedAt = nowNs();
  const log = projectingSessionLog(memoryEventStore());
  const runtime = composeBenchRuntime(log);
  const loopStart = nowNs();
  const target = Math.min(scale, TEMPLATE_EVENTS);
  await driveTemplate(runtime, log, target);
  const loopMs = elapsedMs(loopStart);
  const template = log.events();
  return buildFixture({ scale, log, runtime, template, loopMs, startedAt });
}

/** Build every fixture sequentially, in ascending scale (stable GC behaviour). */
export async function fixturesFor(scales: readonly number[] = SCALES): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const scale of scales) out.push(await fixtureFor(scale));
  return out;
}

/** `10k events (10,003)` — the scale label used by every row and by the report. */
export function scaleLabel(fixture: Fixture): string {
  const requested = fixture.scale >= 1_000 ? `${Math.round(fixture.scale / 1_000)}k` : String(fixture.scale);
  return fixture.events === fixture.scale
    ? `${requested} events`
    : `${requested} events (${fixture.events.toLocaleString("en-US")})`;
}
