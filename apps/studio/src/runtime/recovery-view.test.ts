/**
 * E §1.3 P1 ② (W787): the `recovery` block of `GET /api/status` on the REAL host
 * path — an addition to an EXISTING endpoint (P1 adds no endpoint), always
 * present, always about the QUERIED session.
 *
 * The block answers four operator questions and each is asserted here against a
 * real session directory:
 *   - which turns did this engine close after a crash (`recovered_turns`);
 *   - how many turns the log leaves open right now (`dangling_turns`);
 *   - did the log fork from the disk (`degraded`, G1-6 / A7's host half);
 *   - what was the outcome of the last closed turn (`last_outcome`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeEventLog } from "@celestea/runtime";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, turns, type EngineHarnessOptions } from "./test-util.js";

const harnesses: StudioHarness[] = [];
const SESSION = "sample-ws/s1";

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function make(opts: EngineHarnessOptions = {}): StudioHarness {
  const h = makeEngineHarness(opts);
  harnesses.push(h);
  return h;
}

/** A sidecar for the planted session (self-description `<workspace>/<session>`). */
function checkpointJson(patch: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      version: 1,
      session: "sample-ws/s1",
      pid: 12345,
      boot_id: "b-0000beef",
      updated_at: 1_700_000_000,
      clean_shutdown: false,
      open_turn: null,
      last_outcome: "interrupted",
      degraded: { log_write_errors: 0 },
      lanes: { next_turn: [], next_step: [] },
      delivered_ids: [],
      repaired: [],
      ...patch,
    },
    null,
    2,
  )}\n`;
}

describe("GET /api/status.recovery (E §1.3 P1 ②)", () => {
  it("reports the repaired turns of a crashed session and NO dangling turn", async () => {
    const h = make({
      sessions: { s1: turns(1) },
      rawFiles: {
        "sample-ws/s1/checkpoint.json": checkpointJson({
          repaired: [{ at: 1_700_000_001, action: "synthesize_turn_end", turn_id: "turn-4" }],
        }),
      },
    });
    await activate(h, SESSION);
    const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
    expect(status.body["recovery"]).toEqual({
      session: SESSION,
      recovered_turns: ["turn-4"],
      dangling_turns: 0,
      degraded: false,
      // The LOG is the truth (K4): its last turn_end is `completed`.
      last_outcome: "completed",
    });
  });

  it("A7 (host half): a sticky sidecar degradation shows up as recovery.degraded", async () => {
    const h = make({
      sessions: { s1: turns(1) },
      rawFiles: { "sample-ws/s1/checkpoint.json": checkpointJson({ degraded: { log_write_errors: 3 } }) },
    });
    await activate(h, SESSION);
    const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
    const recovery = status.body["recovery"] as Record<string, unknown>;
    expect(recovery["degraded"]).toBe(true);
  });

  it("counts an OPEN turn of the live log and reports no last outcome yet", async () => {
    const open = [{ type: "turn_start" as const, id: "turn-7" }];
    const h = make({ sessions: { s1: open } });
    await activate(h, SESSION);
    const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
    const recovery = status.body["recovery"] as Record<string, unknown>;
    // §1.2.3 row 1: a dangling turn with NO checkpoint is never closed (fail-safe),
    // so the block reports it instead of hiding it.
    expect(recovery["dangling_turns"]).toBe(1);
    expect(recovery["last_outcome"]).toBeNull();
    expect(recovery["recovered_turns"]).toEqual([]);
  });

  it("a session with no live instance answers the EMPTY block (a poll never composes)", async () => {
    const h = make({ sessions: { s1: turns(1) } });
    const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
    expect(status.body["recovery"]).toEqual({ session: SESSION, recovered_turns: [], dangling_turns: 0, degraded: false, last_outcome: null });
  });

  it("the checkpoint decorator is what makes the block real: a live turn writes it", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, SESSION);
    const res = await h.app.request("/api/turn", jsonRequest("POST", { input: "hi", session: SESSION }));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const onDisk = JSON.parse(readFileSync(join(h.workspace, "s1", "checkpoint.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk["completed"]).toBeUndefined();
    expect(onDisk["session"]).toBe(SESSION);
    expect((onDisk["lanes"] as Record<string, unknown>)["next_turn"]).toEqual([]);
    const status = await getJson(h.app, `/api/status?session=${encodeURIComponent(SESSION)}`);
    expect((status.body["recovery"] as Record<string, unknown>)["last_outcome"]).toBe("completed");
  });
});
