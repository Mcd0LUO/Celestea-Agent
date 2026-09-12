/**
 * REAL-engine contract tests: `/api/turn`, `/api/events`, `/api/cancel`,
 * `/api/status` and `/api/tools` driven by `packages/runtime` (real agent loop +
 * real tool registry + real JSONL session log) over the OFFLINE LLM seam.
 *
 * No network: the model is local and deterministic, so every assertion below is
 * about the HOST contract, not about a provider.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SSE_EVENT_NAMES } from "@celestea/core";
import { parseSessionJsonl } from "@celestea/session";
import { getJson, jsonRequest, type StudioHarness } from "../harness.test-util.js";
import type { OfflineStep } from "./offline-llm.js";
import { activate, asPayload, engineOf, makeEngineHarness, readSessionLog, runTurnWithFrames, turns, waitIdle } from "./test-util.js";

const harnesses: StudioHarness[] = [];

function make(options: Parameters<typeof makeEngineHarness>[0] = {}): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: turns(1) }, ...options });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("POST /api/turn over the real engine", () => {
  it("drives a real turn: SSE frames, JSONL log and terminal status", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    const res = await runTurnWithFrames(h, "hi");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ turn: 1, status: "started", placement: "context" });

    const events = res.frames.map((f) => f.event);
    expect(events[0]).toBe("status");
    expect(events).toContain("text");
    expect(events).toContain("done");
    expect(events).toContain("turn_end");
    expect(res.frames.every((f) => f.turn === 1)).toBe(true);
    expect(events.filter((e) => e === "turn_end")).toHaveLength(1);

    const text = res.frames.filter((f) => f.event === "text").map((f) => String(f.payload["delta"])).join("");
    expect(text).toBe("echo: hi");
    const done = res.frames.find((f) => f.event === "done");
    expect(done?.payload).toEqual({ text: "echo: hi", tool_calls: [] });
    const end = res.frames.find((f) => f.event === "turn_end");
    expect(end?.payload).toEqual({ outcome: "completed", error: null });
    const closing = res.frames[res.frames.length - 1];
    expect(closing?.event).toBe("status");
    expect(closing?.payload["phase"]).toBe("completed");

    const parsed = parseSessionJsonl(readSessionLog(h, "s1"));
    expect(parsed.tornTail).toBeNull();
    expect(parsed.events.map((e) => e.type)).toEqual(["turn_start", "user_message", "assistant_message", "turn_end"]);
    expect(engineOf(h).lastTurnOutcome()).toBe("completed");
  });

  it("W513: a concurrent turn becomes an interjection, then cancels cooperatively", async () => {
    const h = make({ sessions: { s1: [] }, llm: { script: [{ text: "x".repeat(4000) }], deltaMs: 3, chunkChars: 8 } });
    await activate(h, "sample-ws/s1");
    const sub = h.studio.services.bus.subscribe();
    const first = await h.app.request("/api/turn", jsonRequest("POST", { input: "slow" }));
    expect(first.status).toBe(202);

    const second = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "again" }));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, injected: true, turn: 1, pending: 1, placement: "steering", duplicate: false });

    const cancel = await getJson(h.app, "/api/cancel", jsonRequest("POST"));
    expect(cancel.body).toEqual({ ok: true, cancelled: true });
    await waitIdle(h);

    const frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
    for (;;) {
      const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), 500))]);
      if (frame === null) break;
      frames.push({ event: frame.event, payload: asPayload(frame.envelope.payload) });
      if (frame.event === "status" && asPayload(frame.envelope.payload)["phase"] === "cancelled") break;
    }
    sub.close();
    expect(frames.some((f) => f.event === "turn_end" && f.payload["outcome"] === "cancelled")).toBe(true);
    expect(frames[frames.length - 1]?.payload["phase"]).toBe("cancelled");
    expect(engineOf(h).lastTurnOutcome()).toBe("cancelled");

    const parsed = parseSessionJsonl(readSessionLog(h, "s1"));
    const end = parsed.events.find((e) => e.type === "turn_end");
    expect(end?.type === "turn_end" ? end.outcome : null).toBe("cancelled");
    expect((await getJson(h.app, "/api/cancel", jsonRequest("POST"))).body).toEqual({ ok: true, cancelled: false });
  });

  it("dispatches a real tool call through the guarded registry", async () => {
    const script: OfflineStep[] = [];
    const h = make({ sessions: { s1: [] }, llm: { script } });
    await activate(h, "sample-ws/s1");
    // The production path guard is mounted with CELESTEA_TOOL_ROOTS = workspace.
    script.push({ thinking: "look first", tool_calls: [{ id: "c1", name: "list_dir", args: { path: h.workspace } }] });
    script.push({ text: "listed" });
    const res = await runTurnWithFrames(h, "list the dir");
    const tool = res.frames.find((f) => f.event === "tool");
    expect(tool?.payload).toMatchObject({ id: "c1", name: "list_dir", args: { path: h.workspace } });
    const result = res.frames.find((f) => f.event === "tool_result");
    expect(result?.payload).toMatchObject({ id: "c1", ok: true, error: null });
    expect(res.frames.filter((f) => f.event === "thinking")).toHaveLength(1);

    const parsed = parseSessionJsonl(readSessionLog(h, "s1"));
    expect(parsed.events.map((e) => e.type)).toEqual([
      "turn_start",
      "user_message",
      "thinking_delta",
      "tool_call",
      "tool_result",
      "assistant_message",
      "turn_end",
    ]);
    const status = await getJson(h.app, "/api/status");
    expect(status.body["steps"]).toBe(1);
  });

  it("runs without an active session on an in-memory log (no directory is invented)", async () => {
    const h = make();
    const res = await runTurnWithFrames(h, "detached");
    expect(res.status).toBe(202);
    expect(engineOf(h).sessionLogPath()).toBeNull();
    expect((await getJson(h.app, "/api/status")).body["session"]).toBeNull();
  });
});

describe("GET /api/events — the frozen 8 event names", () => {
  it("streams every contract event in the frozen envelope", async () => {
    const h = make();
    const res = await h.app.request("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    const names = ["text", "thinking", "tool", "tool_result", "done", "turn_end", "status", "compact"];
    expect([...SSE_EVENT_NAMES].sort()).toEqual([...names].sort());
    const first = reader?.read();
    for (const [i, name] of names.entries()) {
      h.studio.services.bus.emit(name as never, i + 1, { probe: name });
    }
    const decoder = new TextDecoder();
    let wire = decoder.decode((await first)?.value);
    const deadline = Date.now() + 2_000;
    while (!names.every((n) => wire.includes(`event: ${n}`)) && Date.now() < deadline) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done === true) break;
      wire += decoder.decode(chunk.value);
    }
    for (const name of names) expect(wire).toContain(`event: ${name}`);
    expect(wire).toContain('"turn":8');
    expect(wire).toContain('"payload":{"probe":"compact"}');
    await reader?.cancel();
  });
});

describe("worker endpoints over the real registry", () => {
  it("spawns, addresses and reports a worker through the engine tools", async () => {
    const h = make();
    const spawn = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "do the thing", title: "T" }));
    expect(spawn.status).toBe(200);
    expect(spawn.body).toMatchObject({ ok: true, sessionId: "session-0", wid: "W1" });

    const rows = (await getJson(h.app, "/api/sessions")).body["sessions"] as Array<Record<string, unknown>>;
    const worker = rows.find((r) => r["kind"] === "worker");
    expect(worker).toMatchObject({ id: "worker:session-0", workspace: "engine" });

    const messages = await getJson(h.app, "/api/sessions/worker%3Asession-0/messages");
    expect(messages.body["ok"]).toBe(true);
    expect((await getJson(h.app, "/api/sessions/worker%3Aghost/messages")).status).toBe(404);

    const send = await getJson(h.app, "/api/worker/send", jsonRequest("POST", { target: "session-0", content: "hi" }));
    expect(send.body).toMatchObject({ ok: true, delivered: true });
    expect((await getJson(h.app, "/api/worker/status?wid=W1")).body).toMatchObject({ ok: true, wid: "W1", total: 1 });
    expect((await getJson(h.app, "/api/worker/status?wid=W9")).body).toMatchObject({ ok: false, wid: "W9", error: "no worker W9 in registry" });
    const duplicate = await getJson(h.app, "/api/worker/spawn", jsonRequest("POST", { wid: "W1", brief: "again" }));
    expect(duplicate.status).toBe(502);
    await waitIdle(h, 8_000);
  });
});

describe("GET /api/status and /api/tools", () => {
  it("reports steps, usage, cache_hit_ratio and context_usage from the live trackers", async () => {
    const h = make();
    const before = await getJson(h.app, "/api/status");
    expect(Object.keys(before.body).sort()).toEqual([
      "busy",
      "context_usage",
      "grants_active",
      "mode",
      "model",
      "reasoning_effort",
      "session",
      "steps",
      "tokens_per_sec",
      "usage",
    ]);
    // W755: no usage frame yet, so the fallback is the token estimate of the
    // LOOP'S OWN next request (not the session log's character count).
    expect(before.body["context_usage"]).toMatchObject({
      estimated: true,
      method: "assembled_estimate",
      projected: false,
      window_source: "profile",
    });
    expect((before.body["context_usage"] as { used: number }).used).toBeGreaterThan(0);

    await runTurnWithFrames(h, "hi");
    const after = await getJson(h.app, "/api/status");
    const usage = after.body["usage"] as { prompt_tokens: number; cache_hit_ratio: number; total: { prompt_tokens: number } };
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.cache_hit_ratio).toBeCloseTo(0.5, 2);
    expect(usage.total.prompt_tokens).toBe(usage.prompt_tokens);
    expect(after.body["steps"]).toBe(0);
    expect(after.body["context_usage"]).toMatchObject({
      estimated: false,
      method: "usage_prompt_tokens",
      window: 1_000_000,
      window_source: "profile",
    });
    // W755 (Fix B): the real prompt is a FLOOR — the number may carry the visible
    // growth measured after that sample, never less than the provider's own count.
    expect((after.body["context_usage"] as { used: number }).used).toBeGreaterThanOrEqual(usage.prompt_tokens);
  });

  it("lists the composed tool registry (builtins + worker tools)", async () => {
    const h = make();
    const { body } = await getJson(h.app, "/api/tools");
    const tools = body["tools"] as Array<{ name: string; description: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_shell");
    expect(names).toContain("spawn_worker");
    expect(names).toContain("worker_status");
    expect(Object.keys(tools[0] ?? {}).sort()).toEqual(["description", "name"]);
    expect(names).toEqual([...names].sort());
  });
});

/** The `standard` tool-access variant text (the default mode's prompt). */
const STANDARD_TOOL_ACCESS_MARK = "stepping through the tools one at a time is the normal path here";

describe("GET /api/sessions/{id}/context over the real engine", () => {
  it("serves the engine's own assembly: system prompt, history and tool schemas", async () => {
    const h = make({ sessions: { s1: [] } });
    await activate(h, "sample-ws/s1");
    await runTurnWithFrames(h, "hi");

    const { body } = await getJson(h.app, "/api/sessions/sample-ws%2Fs1/context");
    expect(body["ok"]).toBe(true);
    expect(body["session"]).toBe("sample-ws/s1");
    expect(body["model"]).toBe("offline-model");
    // The system prompt is the loop's config one, assembled for THIS session
    // (W768: every session resolves its own workspace/session variables; before
    // that, a session without a mode inherited the startup-primed prompt, which
    // named whichever workspace happened to be active then).
    const system = String(body["system"]);
    expect(system).toContain("the active session is sample-ws/s1");
    expect(system).toContain(`workspace directory, ${h.workspace}`);
    expect(system).toContain(STANDARD_TOOL_ACCESS_MARK);
    const tools = (body["tools"] as Array<{ name: string; parameters: Record<string, unknown> }>).map((t) => t.name);
    expect(tools).toContain("read_file");
    expect(tools).toEqual([...tools].sort());

    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.map((m) => m["role"])).toEqual(["user", "assistant"]);
    expect(messages.map((m) => m["content"])).toEqual(["hi", "echo: hi"]);
    expect(body["counts"]).toEqual({ system_chars: String(body["system"]).length, tool_count: tools.length, message_count: 2 });
    expect(body["truncated"]).toBe(false);

    // The usage block is the statusline's existing口径, not a second accounting.
    const status = await getJson(h.app, "/api/status");
    const usage = status.body["context_usage"] as Record<string, unknown>;
    expect(body["context"]).toEqual({ used: usage["used"], window: 1_000_000, ratio: usage["ratio"], estimated: usage["estimated"] });
    expect(body["context"]).toMatchObject({ estimated: false, window: 1_000_000 });
    expect(usage["used"]).toBe((status.body["usage"] as { prompt_tokens: number }).prompt_tokens);
  });

  it("404s an unknown session without composing an instance", async () => {
    const h = make();
    const res = await getJson(h.app, "/api/sessions/sample-ws%2Fghost/context");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "unknown session 'sample-ws/ghost'" });
    expect(engineOf(h).liveSessions()).not.toContain("sample-ws/ghost");
  });
});
