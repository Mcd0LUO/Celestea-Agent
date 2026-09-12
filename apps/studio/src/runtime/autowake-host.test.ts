/**
 * W769 — a worker's receipt wakes its HOST session on its own.
 *
 * The bug this pins: the receipt was written into the host's mailbox and stayed
 * there until the user typed something, because the host only drains at a turn
 * boundary. Every assertion below runs on the REAL adapter (real agent loop, real
 * tool registry, real worker registry); only the model is offline.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness, readSessionLog } from "./test-util.js";
import type { BusFrame, BusSubscription } from "../sse.js";

const harnesses: StudioHarness[] = [];

function make(): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: [], s2: [] } });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** Poll until `check` holds (delivery + wake are asynchronous by construction). */
async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The session's log as text (the autowake turn is a NORMAL turn, so it lands there). */
function logOf(h: StudioHarness, session: string): string {
  return readSessionLog(h, session);
}

/**
 * The receipt rows of one session, in order: one row per auto-wake turn, because
 * the drained queue becomes that turn's INPUT (`[from <sid>] …`).
 */
function wakeInputs(h: StudioHarness, session: string): string[] {
  return parseSessionJsonl(logOf(h, session))
    .events.filter((e): e is Extract<typeof e, { type: "user_message" }> => e.type === "user_message" && e.text.startsWith("[from "))
    .map((e) => e.text);
}

/** Drain the bus until `done` says so (or the deadline passes). */
async function drain(sub: BusSubscription, frames: BusFrame[], done: (frames: BusFrame[]) => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done(frames)) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
    if (frame === null) return;
    frames.push(frame);
  }
}

const payloadOf = (frame: BusFrame): Record<string, unknown> => (frame.envelope.payload ?? {}) as Record<string, unknown>;

describe("W769 auto-wake (real adapter)", () => {
  it("wakes the idle host session when its worker settles — no keyboard involved", async () => {
    const h = make();
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    const frames: BusFrame[] = [];

    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "brief one", title: "T", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);
    expect(engineOf(h).isBusy("sample-ws/s1")).toBe(false);

    // Nothing touches the host: the receipt itself must produce the turn.
    await until(() => logOf(h, "s1").includes("[from "), "the host session to be auto-woken");
    const sawStart = (f: BusFrame[]): boolean => f.some((x) => x.event === "status" && payloadOf(x)["source"] === "autowake");
    const sawEnd = (f: BusFrame[]): boolean => f.some((x) => x.event === "turn_end");
    await drain(sub, frames, (f) => sawStart(f) && sawEnd(f));
    sub.close();

    const log = logOf(h, "s1");
    const wakes = wakeInputs(h, "s1");
    expect(wakes).toHaveLength(1); // the labelled receipt is the turn's input
    expect(wakes[0]).toMatch(/^\[from [^\]]+\] /);
    expect(log).toContain("echo: "); // …and a normal turn ran over it

    // The start frame says WHY the turn exists (contracts/sse-events.json).
    const starts = frames.filter((f) => f.event === "status" && payloadOf(f)["source"] === "autowake" && payloadOf(f)["phase"] === "start");
    expect(starts.length).toBeGreaterThan(0);
    // The frames are the host session's, i.e. a client sees the wake live.
    expect(starts[0]?.envelope.session ?? null).toBe("sample-ws/s1");
  });

  it("wakes a host that is NOT the active session (the reported scenario)", async () => {
    const h = make();
    await activate(h, "sample-ws/s1");
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W2", brief: "brief two", title: "T", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);

    // Move the UI focus away: s1 is now a BACKGROUND session with a worker.
    await activate(h, "sample-ws/s2");
    await until(() => logOf(h, "s1").includes("[from "), "the background host to be auto-woken");

    expect(wakeInputs(h, "s1")).toHaveLength(1);
    // The focused session was untouched: the wake went to the RIGHT session.
    expect(wakeInputs(h, "s2")).toEqual([]);
  });

  it("does not wake anybody while the host is busy, and loses nothing", async () => {
    const h = make();
    await activate(h, "sample-ws/s1");
    const engine = engineOf(h);
    // A slow host turn keeps the session busy while the worker settles.
    const slow = h.studio.services.bus.subscribe();
    const turn = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(turn.status).toBe(202);
    expect(engine.isBusy("sample-ws/s1")).toBe(true);

    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W3", brief: "brief three", title: "T", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);
    slow.close();

    // The receipt must NOT be swallowed by the busy session…
    await until(() => !engine.isBusy("sample-ws/s1"), "the host turn to settle");
    const registry = engine.workersOf("sample-ws/s1");
    await until(() => registry?.mailbox.pending("sample-ws/s1") === 0 || logOf(h, "s1").includes("[from "), "the receipt to be consumed once the host is free");
    expect(logOf(h, "s1")).toContain("[from ");
    // …and it is consumed exactly once (no duplicate turn).
    // …and exactly ONE wake turn happened (a duplicate consumption would show up
    // as a second receipt row, not as the echo of the first).
    expect(wakeInputs(h, "s1")).toHaveLength(1);
  });
});
