/**
 * REAL-engine tests for the configuration / maintenance surface:
 * `GET+POST /api/config` (generation hot swap), `POST /api/sessions/{id}/compact`
 * and `POST /api/clear`, all against `packages/runtime` with the offline LLM.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import { activate, engineOf, makeEngineHarness, readSessionLog, runTurnWithFrames, turns, waitIdle } from "./test-util.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: [] }, ...options });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("POST /api/config — generation hot swap", () => {
  it("composes a new generation and reuses its profile", async () => {
    const h = make();
    const before = await getJson(h.app, "/api/config");
    expect(before.body["model"]).toBe("offline-model");
    expect(before.body["max_steps"]).toBe(4096);
    const epoch0 = engineOf(h).generationEpoch();

    const patched = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "m-2", system_prompt: "CUSTOM", max_steps: 10, context_window: 32_000 }));
    expect(patched.status).toBe(200);
    expect(patched.body["model"]).toBe("m-2");
    expect(patched.body["max_steps"]).toBe(4096); // MIN_STEPS floor is contract
    expect(patched.body["context_window"]).toBe(32_000);
    expect(patched.body["system_prompt"]).toBe("CUSTOM");
    expect(engineOf(h).generationEpoch()).toBeGreaterThan(epoch0);
    expect(engineOf(h).profile()).toMatchObject({ model: "m-2", system_prompt: "CUSTOM", context_window: 32_000 });
    expect((await getJson(h.app, "/api/health")).body["model"]).toBe("m-2");

    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "after swap");
    expect(res.status).toBe(202);
    expect(res.frames.find((f) => f.event === "done")?.payload["text"]).toBe("echo: after swap");
    expect(parseSessionJsonl(readSessionLog(h, "s1")).events).toHaveLength(4);
  });

  it("409s a config change while a turn is running", async () => {
    const h = make({ llm: { script: [{ text: "y".repeat(2000) }], deltaMs: 2, chunkChars: 8 } });
    const started = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(started.status).toBe(202);
    const res = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "m-3" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "turn in progress; config applies between turns" });
    await getJson(h.app, "/api/cancel", jsonRequest("POST"));
    await waitIdle(h);
  });
});

describe("POST /api/sessions/{id}/compact", () => {
  it("compacts a long session: rewrite + backup + SSE frame + rebind", async () => {
    const h = make({ sessions: { s1: [], s12: turns(12) } });
    await activate(h, "sample-ws/s12");
    const original = readSessionLog(h, "s12");
    const sub = h.studio.services.bus.subscribe();

    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs12/compact", jsonRequest("POST"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, compacted: true, kept_turns: 4, note: "已压缩：摘要轮 + 最近4轮" });

    const frame = await sub.next();
    expect(frame?.event).toBe("compact");
    expect(frame?.envelope.turn).toBe(0);
    expect(frame?.envelope.payload).toMatchObject({ session: "sample-ws/s12", kept_turns: 4, rebound: true });
    sub.close();

    const parsed = parseSessionJsonl(readSessionLog(h, "s12"));
    expect(parsed.events.map((e) => e.type).slice(0, 4)).toEqual(["turn_start", "user_message", "assistant_message", "turn_end"]);
    const head = parsed.events[1];
    expect(head?.type === "user_message" ? head.text.startsWith("【上下文压缩】") : false).toBe(true);
    expect(head?.type === "user_message" ? head.text : "").toContain("digest");
    const kept = parsed.events.filter((e) => e.type === "turn_start").map((e) => (e.type === "turn_start" ? e.id : ""));
    expect(kept).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5"]);
    const users = parsed.events.filter((e) => e.type === "user_message").map((e) => (e.type === "user_message" ? e.text : ""));
    expect(users.slice(1)).toEqual(["问 8", "问 9", "问 10", "问 11"]);
    expect(readFileSync(join(h.workspace, "s12", "cli-main.jsonl.precompact"), "utf8")).toBe(original);

    // The live generation was rebound: the NEXT turn id continues after turn-5.
    const res2 = await runTurnWithFrames(h, "post compact");
    const next = parseSessionJsonl(readSessionLog(h, "s12")).events.filter((e) => e.type === "turn_start");
    expect(next.map((e) => (e.type === "turn_start" ? e.id : ""))).toEqual(["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6"]);
    expect(res2.frames.find((f) => f.event === "done")?.payload["text"]).toBe("echo: post compact");
  });

  it("skips a short history, and 409s while a turn runs", async () => {
    const h = make({ sessions: { s1: [], s3: turns(3) } });
    await activate(h, "sample-ws/s3");
    const original = readSessionLog(h, "s3");
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fs3/compact", jsonRequest("POST"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, compacted: false, note: "历史不足，无需压缩" });
    expect(readSessionLog(h, "s3")).toBe(original);

    const busy = make({ sessions: { s1: [] }, llm: { script: [{ text: "z".repeat(3000) }], deltaMs: 2, chunkChars: 8 } });
    const started = await busy.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(started.status).toBe(202);
    const denied = await getJson(busy.app, "/api/sessions/sample-ws%2Fs1/compact", jsonRequest("POST"));
    expect(denied.status).toBe(409);
    expect(denied.body).toEqual({ ok: false, error: "turn 进行中，无法压缩" });
    await getJson(busy.app, "/api/cancel", jsonRequest("POST"));
    await waitIdle(busy);
  });
});

describe("POST /api/clear", () => {
  it("truncates the active log and resets the turn counter", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const first = await runTurnWithFrames(h, "one");
    expect(first.turn).toBe(1);

    const cleared = await getJson(h.app, "/api/clear", jsonRequest("POST"));
    expect(cleared.body).toEqual({ ok: true, cleared: true, session: "sample-ws/s1" });
    expect(readSessionLog(h, "s1")).toBe("");

    const second = await runTurnWithFrames(h, "two");
    expect(second.turn).toBe(1);
    expect(parseSessionJsonl(readSessionLog(h, "s1")).events.map((e) => e.type)).toEqual([
      "turn_start",
      "user_message",
      "assistant_message",
      "turn_end",
    ]);
  });
});
