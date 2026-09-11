/**
 * W513 session independence over the REAL engine + HTTP contract.
 *
 * Covered here (the acceptance list of the frozen contract):
 *   1. `activate` never 409s: a second session can be opened and run while the
 *      first is still streaming (per-session busy slots, per-session turns);
 *   2. `POST /api/turn` on a BUSY session injects the input into the RUNNING
 *      turn — the session log shows the injected `user_message` inside the same
 *      turn, before its `turn_end`, and no second turn is started;
 *   3. the same mechanism carries a worker message (mailbox) mid-turn;
 *   4. `GET /api/sessions` lists worker rows (`kind`, `wid`, `status`,
 *      `host_session`) next to the session rows' own `busy` flag.
 */

import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import type { SessionEvent } from "@celestea/core";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import type { BusSubscription } from "../sse.js";
import { activate, engineOf, makeEngineHarness, readSessionLog, turns, waitIdle } from "./test-util.js";
import type { OfflineStep } from "./offline-llm.js";

const harnesses: StudioHarness[] = [];
/** Frames of the slow step: 2400 chars / 8 per frame, 3ms each ≈ 0.9s. */
const SLOW_TEXT = "x".repeat(2400);

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness(options);
  harnesses.push(h);
  return h;
}

/**
 * A harness whose offline LLM serves ONE slow first step (a streamed reply plus
 * a `list_dir` tool call, so the turn has a second step to inject into) and the
 * deterministic echo afterwards. The script array is shared with the LLM, so it
 * is populated AFTER the harness exists (the engine composes lazily).
 */
function makeSlow(sessions: Record<string, readonly SessionEvent[]>): StudioHarness {
  const script: OfflineStep[] = [];
  const h = make({ sessions, llm: { script, deltaMs: 3, chunkChars: 8 } });
  script.push({ text: SLOW_TEXT, tool_calls: [{ id: "c1", name: "list_dir", args: { path: h.workspace } }] });
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function eventsOf(h: StudioHarness, name: string): SessionEvent[] {
  return parseSessionJsonl(readSessionLog(h, name)).events;
}

function userTexts(events: readonly SessionEvent[]): string[] {
  return events.filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
}

/** Poll the log until `predicate` holds (the turn is still running meanwhile). */
async function pollLog(h: StudioHarness, name: string, predicate: (events: SessionEvent[]) => boolean, timeoutMs = 6_000): Promise<SessionEvent[] | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = eventsOf(h, name);
    if (predicate(events)) return events;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Continuously collect frames of one subscription. A polling loop that times out
 * would leave a dangling `next()` waiter behind and swallow the NEXT frame, so
 * the collector subscribes once and drains forever.
 */
interface FrameLog {
  frames: Array<{ event: string; payload: Record<string, unknown> }>;
  find(predicate: (payload: Record<string, unknown>) => boolean): Record<string, unknown> | undefined;
  settle(ms?: number): Promise<void>;
  stop(): void;
}

function collect(sub: BusSubscription): FrameLog {
  const frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
  void (async () => {
    for (;;) {
      const frame = await sub.next();
      if (frame === null) return;
      frames.push({ event: frame.event, payload: (frame.envelope.payload ?? {}) as Record<string, unknown> });
    }
  })();
  return {
    frames,
    find: (predicate) => frames.map((f) => f.payload).find(predicate),
    settle: (ms = 150) => new Promise((r) => setTimeout(r, ms)),
    stop: () => sub.close(),
  };
}

describe("session independence", () => {
  it("opens and runs a second session while the first one is streaming (no 409)", async () => {
    const h = makeSlow({ s1: [], s2: turns(1) });
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "长任务", session: "sample-ws/s1" }));
    expect(first.status).toBe(202);
    expect(engineOf(h).isBusy("sample-ws/s1")).toBe(true);
    expect(engineOf(h).isBusy("sample-ws/s2")).toBe(false);

    // (2) activate another session while s1 runs: 200, never 409.
    const activated = await getJson(h.app, "/api/sessions/sample-ws%2Fs2/activate", jsonRequest("POST"));
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ ok: true, active_session: "sample-ws/s2", runtime: "created", busy: false });

    // (3) the second session runs its own turn while s1 streams. `s2` is planted
    // with ONE completed turn, so its counter CONTINUES from the log (E §1.3 P0 ④,
    // W730): the new turn is the session's 2nd — independent numbering, never a
    // restart at 1 that would collide with the ids already on disk.
    const second = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "B 的任务", session: "sample-ws/s2" }));
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ turn: 2, status: "started", placement: "context" });
    await waitIdle(h);

    expect(userTexts(eventsOf(h, "s2")).slice(-1)).toEqual(["B 的任务"]);
    expect(userTexts(eventsOf(h, "s1"))).toEqual(["长任务"]);
    expect((await getJson(h.app, "/api/status?session=sample-ws%2Fs1")).body).toMatchObject({ session: "sample-ws/s1", busy: false });
    expect(engineOf(h).liveSessions().sort()).toEqual(["sample-ws/s1", "sample-ws/s2"]);
  });

  it("injects a second POST /api/turn into the RUNNING turn (same turn, before turn_end)", async () => {
    const h = makeSlow({ s1: [] });
    await activate(h, "sample-ws/s1");
    const started = await h.app.request("/api/turn", jsonRequest("POST", { input: "第一轮输入", session: "sample-ws/s1" }));
    expect(started.status).toBe(202);

    const injected = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "中途插话", session: "sample-ws/s1" }));
    expect(injected.status).toBe(200);
    expect(injected.body).toEqual({ ok: true, injected: true, turn: 1, pending: 1, placement: "steering", duplicate: false });

    // The interjection is written by the RUNNING turn: it shows up before the
    // turn_end row, while the turn is still in flight.
    const midTurn = await pollLog(h, "s1", (events) => userTexts(events).includes("中途插话"));
    expect(midTurn).not.toBeNull();
    expect((midTurn ?? []).some((e) => e.type === "turn_end")).toBe(false);

    await waitIdle(h);
    const events = eventsOf(h, "s1");
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(userTexts(events)).toEqual(["第一轮输入", "中途插话"]);
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("tool_result")).toBeLessThan(kinds.lastIndexOf("user_message"));
    expect(kinds.lastIndexOf("user_message")).toBeLessThan(kinds.lastIndexOf("turn_end"));
  });

  it("injects a worker message into the running turn at the next step boundary", async () => {
    const h = makeSlow({ s1: [] });
    await activate(h, "sample-ws/s1");
    const started = await h.app.request("/api/turn", jsonRequest("POST", { input: "第一轮", session: "sample-ws/s1" }));
    expect(started.status).toBe(202);

    // Same channel a worker receipt uses: the host session's mailbox.
    const send = await getJson(h.app, "/api/worker/send", jsonRequest("POST", { target: "sample-ws/s1", content: "WORKER_W1_DONE 报告 results/W1-x.md" }));
    expect(send.body).toMatchObject({ ok: true, delivered: true });

    const midTurn = await pollLog(h, "s1", (events) => userTexts(events).some((t) => t.includes("WORKER_W1_DONE")));
    expect(midTurn).not.toBeNull();
    expect((midTurn ?? []).some((e) => e.type === "turn_end")).toBe(false);
    await waitIdle(h);

    const events = eventsOf(h, "s1");
    expect(userTexts(events)).toEqual(["第一轮", "[from celestea.studio-ts] WORKER_W1_DONE 报告 results/W1-x.md"]);
    const kinds = events.map((e) => e.type);
    expect(kinds.lastIndexOf("user_message")).toBeLessThan(kinds.lastIndexOf("turn_end"));
  });

  it("publishes placement (queued/steering/context) and the receipt envelope (W515 §2/§4)", async () => {
    const script: OfflineStep[] = [];
    const h = make({ sessions: { s1: [] }, llm: { script } });
    await activate(h, "sample-ws/s1");
    const log = collect(h.studio.services.bus.subscribe());

    // 1. an idle turn: the input IS the context.
    script.push({ text: "普通回答" });
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "第一轮", session: "sample-ws/s1" }));
    expect(((await first.json()) as Record<string, unknown>)["placement"]).toBe("context");
    await waitIdle(h);

    // 2. a worker on this session settles -> a QUEUED receipt in the mailbox.
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "x", session: "sample-ws/s1" }));
    expect(spawn.body["ok"]).toBe(true);
    const workerId = String(spawn.body["sessionId"]);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      // `state: idle` means the driver parked in its mailbox loop, i.e. the
      // settlement notice was already enqueued into the host mailbox.
      const status = await getJson(h.app, "/api/worker/status?wid=W1");
      const worker = (status.body["workers"] as Array<Record<string, unknown>>)[0];
      if (worker?.["state"] === "idle") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await log.settle(100);

    // 3. the next turn drains it at the TURN START: placement "context", envelope
    //    `subagent-settled` (a settlement notice, not a deliberate relay).
    script.push({ text: "带回执的回答" });
    const second = await h.app.request("/api/turn", jsonRequest("POST", { input: "第二轮", session: "sample-ws/s1" }));
    expect(second.status).toBe(202);
    await waitIdle(h);
    const receiptFrame = log.find((p) => (p["message"] as Record<string, unknown> | undefined)?.["kind"] === "receipt");
    expect(receiptFrame?.["placement"]).toBe("context");
    expect(receiptFrame?.["boundary"]).toBe("turn-start");
    expect((receiptFrame?.["message"] as Record<string, unknown>)["source"]).toMatchObject({ kind: "subagent-settled", form: "notice" });
    expect(userTexts(eventsOf(h, "s1")).some((t) => t.includes("WORKER_W1_DONE"))).toBe(true);

    // 4. an explicit relay message keeps its own envelope.
    await getJson(h.app, "/api/worker/send", jsonRequest("POST", { target: "sample-ws/s1", content: "主动消息" }));
    script.push({ text: "带 relay 的回答" });
    await h.app.request("/api/turn", jsonRequest("POST", { input: "第三轮", session: "sample-ws/s1" }));
    await waitIdle(h);
    const relayFrame = log.find((p) => (p["message"] as Record<string, unknown> | undefined)?.["kind"] === "relay");
    expect((relayFrame?.["message"] as Record<string, unknown>)["source"]).toMatchObject({ kind: "worker-relay", form: "message" });

    // 5. a busy session: the interjection is STEERING now, CONTEXT at the step.
    const slow = makeSlow({ s1: [] });
    await activate(slow, "sample-ws/s1");
    const slowLog = collect(slow.studio.services.bus.subscribe());
    await slow.app.request("/api/turn", jsonRequest("POST", { input: "长任务", session: "sample-ws/s1" }));
    const injected = await getJson(slow.app, "/api/turn", jsonRequest("POST", { input: "中途插话", session: "sample-ws/s1" }));
    expect(injected.body["placement"]).toBe("steering");
    await slowLog.settle(200);
    const steering = slowLog.find((p) => p["placement"] === "steering");
    expect((steering?.["message"] as Record<string, unknown>)["lane"]).toBe("next-step");
    await waitIdle(slow);
    await slowLog.settle(200);
    const context = slowLog.find((p) => p["placement"] === "context" && p["boundary"] === "step");
    expect(context?.["boundary"]).toBe("step");
    expect((context?.["message"] as Record<string, unknown>)["summary"]).toBe("中途插话");

    log.stop();
    slowLog.stop();
  });

  it("lists worker rows with wid/status/host_session and per-session busy flags", async () => {
    const h = makeSlow({ s1: [] });
    await activate(h, "sample-ws/s1");
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "do the thing", title: "T", session: "sample-ws/s1" }));
    expect(spawn.body).toMatchObject({ ok: true, wid: "W1" });

    const before = await getJson(h.app, "/api/sessions");
    const rows = before.body["sessions"] as Array<Record<string, unknown>>;
    const worker = rows.find((r) => r["kind"] === "worker");
    expect(worker).toMatchObject({ kind: "worker", wid: "W1", host_session: "sample-ws/s1" });
    expect(typeof worker?.["status"]).toBe("string");
    expect(String(worker?.["id"])).toMatch(/^worker:sample-ws_s1-session-/);
    expect(rows.find((r) => r["id"] === "sample-ws/s1")).toMatchObject({ kind: "session", workspace: "sample-ws", busy: false });

    const messages = await getJson(h.app, `/api/sessions/${encodeURIComponent(String(worker?.["id"]))}/messages`);
    expect(messages.body["ok"]).toBe(true);

    // While s1 runs, ITS row is busy and so is the worker's host annotation.
    const started = await h.app.request("/api/turn", jsonRequest("POST", { input: "长任务", session: "sample-ws/s1" }));
    expect(started.status).toBe(202);
    const during = await getJson(h.app, "/api/sessions");
    const duringRows = during.body["sessions"] as Array<Record<string, unknown>>;
    expect(duringRows.find((r) => r["id"] === "sample-ws/s1")?.["busy"]).toBe(true);
    expect(duringRows.find((r) => r["kind"] === "worker")?.["busy"]).toBe(true);
    await getJson(h.app, "/api/cancel", jsonRequest("POST"));
    await waitIdle(h);
  });
});
