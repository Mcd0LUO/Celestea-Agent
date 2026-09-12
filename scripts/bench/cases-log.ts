/**
 * (d) The session log: the projection replay and the append path.
 *
 * `projectingSessionLog` (core) is the single source of truth every other
 * measurement reads from: `deriveMessages()` projects the WHOLE event log on
 * every call (tool calls accumulate into one assistant message, sub-call rows
 * are dropped, the result is protocol-balanced), and the statusline's snapshot
 * calls it on every tick. These rows are the floor under (a): whatever the tick
 * costs, this much of it is pure projection.
 */

import { memoryEventStore, projectingSessionLog } from "@celestea/core";
import { caseOf, timeValue, type BenchCase } from "./timing.js";
import { scaleLabel, type Fixture } from "./fixtures.js";

/** Events replayed into a fresh log by the append row. */
const REPLAY_EVENTS = 1_000;

/** `deriveMessages()` + `events()` per fixture (the projection replay). */
export function logCases(fixtures: readonly Fixture[]): BenchCase[] {
  const rows: BenchCase[] = [];
  for (const fixture of fixtures) {
    const derived = timeValue(() => fixture.log.deriveMessages().length);
    rows.push(caseOf("SessionLog.deriveMessages()", scaleLabel(fixture), derived, "replays the whole event log and re-balances tool calls", {
      events: fixture.events,
      messages: fixture.messages,
      events_per_message: Math.round((fixture.events / fixture.messages) * 100) / 100,
    }));
    const copied = timeValue(() => fixture.log.events().length);
    rows.push(caseOf("SessionLog.events()", scaleLabel(fixture), copied, "the defensive copy a statusline read used to pay for", { events: fixture.events }));
  }
  return rows;
}

/** Append throughput: replay `REPLAY_EVENTS` events into a fresh REAL log. */
export function appendCases(fixture: Fixture): BenchCase[] {
  const template = fixture.log.events().slice(0, REPLAY_EVENTS);
  const replay = (): number => {
    const log = projectingSessionLog(memoryEventStore());
    for (const event of template) log.append(event);
    return log.events().length;
  };
  const timing = timeValue(replay, { targetMs: 60 });
  return [
    caseOf("SessionLog.append() replay", `${template.length.toLocaleString("en-US")} events`, timing, "fresh in-memory store per replay (real projectingSessionLog + memoryEventStore)", {
      events: template.length,
      per_event_ms: Math.round((timing.median_ms / Math.max(1, template.length)) * 1_000_000) / 1_000_000,
    }),
  ];
}
