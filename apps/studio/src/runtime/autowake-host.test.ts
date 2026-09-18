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
import type { OfflineStep } from "./offline-llm.js";
import type { BusFrame, BusSubscription } from "../sse.js";

const harnesses: StudioHarness[] = [];

function make(): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: [], s2: [] } });
  harnesses.push(h);
  return h;
}

/**
 * W855 C8: a harness whose FIRST offline step streams slowly, so there is a real
 * busy window in which a user can pick `mode: "queue"`. The script is filled
 * after the harness exists because the engine composes lazily.
 */
function makeQueue(): StudioHarness {
  const script: OfflineStep[] = [];
  const h = makeEngineHarness({ sessions: { s1: [], s2: [] }, llm: { script, deltaMs: 3, chunkChars: 8 } });
  script.push({ text: "x".repeat(2400) }); // ~0.9s of frames
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

  it("W855 C8: a queued user input wakes the idle host by itself, exactly once", async () => {
    const h = makeQueue();
    await activate(h, "sample-ws/s1");
    const engine = engineOf(h);
    const sub = h.studio.services.bus.subscribe();
    const frames: BusFrame[] = [];

    // 1. a slow turn keeps the session busy; 2. while busy, the user picks queue.
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "长任务", session: "sample-ws/s1" }));
    expect(first.status).toBe(202);
    await until(() => engine.isBusy("sample-ws/s1"), "the slow turn to be busy");
    const queued = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "排队输入", mode: "queue", session: "sample-ws/s1" }));
    expect(queued.body["placement"]).toBe("queued");
    expect(queued.body["injected"]).toBe(false);
    expect(queued.body["pending"]).toBe(1);
    // Busy: the lane holds it and the RUNNING turn never sees it.
    expect(logOf(h, "s1")).not.toContain("排队输入");

    // 3. NO further input: the lane alone must produce the wake turn.
    await until(() => logOf(h, "s1").includes("排队输入"), "the queued message to be auto-delivered");
    await drain(sub, frames, (f) => f.some((x) => x.event === "status" && payloadOf(x)["source"] === "autowake" && payloadOf(x)["phase"] === "start"));
    sub.close();

    // 4. exactly ONE wake turn and ONE row for the queued text.
    const starts = frames.filter((f) => f.event === "status" && payloadOf(f)["source"] === "autowake" && payloadOf(f)["phase"] === "start");
    expect(starts.length).toBe(1);
    const rows = parseSessionJsonl(logOf(h, "s1")).events.filter((e) => e.type === "user_message");
    expect(rows.filter((e) => e.type === "user_message" && e.text === "排队输入")).toHaveLength(1);
  });

  it("W855 C8: the queued user message is delivered BEFORE a mailbox receipt drained in the same idle wake", async () => {
    const h = make();
    await activate(h, "sample-ws/s1");
    const engine = engineOf(h);

    // Both sources are pending while IDLE, so ONE autowake turn drains them:
    // the lane is parked (next-turn) and a receipt is dropped into the mailbox.
    const queued = engine.inject({ input: "排队输入", session: "sample-ws/s1", mode: "queue" });
    expect(queued.placement).toBe("queued");
    const mailbox = engine.workersOf("sample-ws/s1")?.mailbox;
    expect(mailbox).toBeDefined();
    mailbox!.send("sample-ws/s1", "receipt body", "W9");

    await until(() => logOf(h, "s1").includes("排队输入") && logOf(h, "s1").includes("[from W9]"), "the lane message and the receipt");
    const log = logOf(h, "s1");
    // drainPending's order is lane-then-mailbox; autowake must preserve it.
    expect(log.indexOf("排队输入")).toBeLessThan(log.indexOf("[from W9]"));
  });
});
