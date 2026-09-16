/**
 * W833 (R3 B8 / W816 F5 + F7) — manual-turn start payload keys and the
 * no-argument cancel() target, on the REAL engine adapter.
 *
 * Source: /server-center/runtime/worker-exec/results/W827-R3修复计划-B-tools-workers-studio.md
 * §B8 W816 F5: a manual turn's status "start" payload must NOT carry a source
 * key; an autowake turn carries source:"autowake".
 * §B8 W816 F7: no-argument cancel() must cancel the most recently ACTIVE busy
 * session, not the first one in creation order.
 */

import { afterEach, describe, expect, it } from "vitest";

import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, asPayload, engineOf, makeEngineHarness, waitIdle } from "./test-util.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness(options);
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

interface Frame {
  event: string;
  payload: Record<string, unknown>;
}

describe("W833 B8/F5: start frame source key", () => {
  it("omits source on a manual turn", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    await h.app.request("/api/turn", jsonRequest("POST", { input: "hi" }));
    const frames: Frame[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (frame === null) break;
      frames.push({ event: frame.event, payload: asPayload(frame.envelope.payload) });
      if (frame.event === "turn_end") break;
    }
    sub.close();
    const start = frames.find((f) => f.event === "status" && f.payload["phase"] === "start");
    expect(start).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(start?.payload, "source")).toBe(false);
  });

  it("includes source=autowake on an autowake start frame", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "b", session: "sample-ws/s1" }));
    expect(spawn.status).toBe(200);
    const frames: Frame[] = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
      if (frame === null) continue;
      frames.push({ event: frame.event, payload: asPayload(frame.envelope.payload) });
      if (frames.some((f) => f.event === "status" && f.payload["source"] === "autowake" && f.payload["phase"] === "start")) break;
    }
    sub.close();
    expect(frames.some((f) => f.event === "status" && f.payload["source"] === "autowake" && f.payload["phase"] === "start")).toBe(true);
  });
});

describe("W833 B8/F7: no-arg cancel targets the most recently active session", () => {
  it("cancels the newest busy session, leaving the older one", async () => {
    const h = make({ sessions: { s1: [], s2: [] }, llm: { script: [{ text: "x".repeat(4000) }], deltaMs: 40, chunkChars: 8 } });
    await activate(h, "sample-ws/s1");
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "one" }));
    expect(first.status).toBe(202);
    await new Promise((r) => setTimeout(r, 60));
    await activate(h, "sample-ws/s2");
    const second = await h.app.request("/api/turn", jsonRequest("POST", { input: "two" }));
    expect(second.status).toBe(202);

    const engine = engineOf(h);
    expect(engine.isBusy("sample-ws/s1")).toBe(true);
    expect(engine.isBusy("sample-ws/s2")).toBe(true);
    expect(engine.cancel()).toBe(true);

    const deadline = Date.now() + 5_000;
    while (engine.isBusy("sample-ws/s2") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(engine.isBusy("sample-ws/s2")).toBe(false);
    expect(engine.isBusy("sample-ws/s1")).toBe(true);

    engine.cancel("sample-ws/s1");
    await waitIdle(h);
  }, 30_000);
});
