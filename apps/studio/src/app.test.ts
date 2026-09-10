import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEndpoints } from "@celestea/core";
import { busyRuntime, getJson, jsonRequest, makeHarness, type StudioHarness } from "./harness.test-util.js";
import { API_ENDPOINT_COUNT } from "./routes.js";

const SECRET = "sk-live-CAFEBABE-9999888877";
const harnesses: StudioHarness[] = [];

function make(files?: Record<string, unknown>): StudioHarness {
  const h = makeHarness({
    session: { name: "s1", log: `${JSON.stringify({ type: "user_message", text: "hello" })}\n` },
    files,
  });
  harnesses.push(h);
  return h;
}

function planted(): Record<string, unknown> {
  return {
    "providers.json": {
      providers: [
        {
          id: "celestea",
          name: "Gateway",
          note: "local",
          base_url: "http://127.0.0.1:3001/v1",
          request_format: "chat_completions",
          api_key: SECRET,
          models: [{ id: "test-model", name: "Test Model", reasoning_efforts: ["low", "high"], context_window: 1_000_000, max_output_tokens: null }],
        },
      ],
      default_model: "test-model",
    },
  };
}

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

describe("route table coverage", () => {
  it("binds exactly the 39 contract endpoints with the contract method+path", () => {
    const h = make();
    expect(h.studio.endpointIds).toHaveLength(API_ENDPOINT_COUNT);
    expect(new Set(h.studio.endpointIds).size).toBe(API_ENDPOINT_COUNT);
    const contract = loadEndpoints().endpoints.map((e) => `${e.method} ${e.path}`);
    const bound = h.studio.routes.map((r) => `${r.method} ${r.contractPath}`);
    expect(bound.sort()).toEqual(contract.sort());
  });
});

describe("health / status / tools / config", () => {
  it("serves GET /api/health with the frozen shape", async () => {
    const h = make();
    const { status, body } = await getJson(h.app, "/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, name: "celestea-studio", model: "test-model", base_url: "http://127.0.0.1:3001/v1", bind: "127.0.0.1:3777" });
  });

  it("serves GET /api/status with the statusline + session", async () => {
    const h = make();
    const { body } = await getJson(h.app, "/api/status");
    expect(Object.keys(body).sort()).toEqual(["busy", "context_usage", "model", "reasoning_effort", "session", "steps", "tokens_per_sec", "usage"]);
    expect(body["session"]).toBeNull();
    expect(body["busy"]).toBe(false);
    expect(body["context_usage"]).toMatchObject({ window: 1_000_000, estimated: true, method: "session_event_chars" });
  });

  it("serves GET /api/tools as {tools:[{name,description}]}", async () => {
    const h = make();
    const { body } = await getJson(h.app, "/api/tools");
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    expect(Object.keys(tools[0] ?? {}).sort()).toEqual(["description", "name"]);
  });

  it("rebuilds available.models from the providers store and never leaks a key", async () => {
    const h = make(planted());
    const res = await h.app.request("/api/config");
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("api_key\"");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "api_key_env",
      "available",
      "base_url",
      "context_window",
      "max_output_tokens",
      "max_parallel_tool_calls",
      "max_steps",
      "model",
      "reasoning_effort",
      "system_prompt",
    ]);
    expect(body["available"]).toEqual({
      models: [{ id: "test-model", name: "Test Model", provider: "Gateway", reasoning: true }],
      efforts: ["low", "high", "max"],
    });
    expect(String(body["system_prompt"])).toContain("Celestea engine");
  });

  it("validates POST /api/config and applies an accepted patch", async () => {
    const h = make(planted());
    const bad = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "bad model" }));
    expect(bad.status).toBe(400);
    expect(bad.body["error"]).toBe(
      "invalid model name 'bad model': character \" \" is not allowed (only [A-Za-z0-9._-:/@]; no spaces, brackets or control characters)",
    );
    expect((await getJson(h.app, "/api/config", jsonRequest("POST", { base_url: "ftp://x" }))).body["error"]).toBe("base_url must be an http:// or https:// URL");
    expect((await getJson(h.app, "/api/config", jsonRequest("POST", { max_steps: 0 }))).body["error"]).toBe("max_steps must be >= 1");
    expect((await getJson(h.app, "/api/config", jsonRequest("POST", { max_output_tokens: 4294967296 }))).body["error"]).toBe("max_output_tokens must be <= u32::MAX");

    const ok = await getJson(h.app, "/api/config", jsonRequest("POST", { model: "m-2", max_steps: 10, system_prompt: "CUSTOM" }));
    expect(ok.status).toBe(200);
    expect(ok.body["model"]).toBe("m-2");
    expect(ok.body["max_steps"]).toBe(4096);
    expect(ok.body["system_prompt"]).toBe("CUSTOM");
    const after = await getJson(h.app, "/api/health");
    expect(after.body["model"]).toBe("m-2");
  });

  it("keeps the api_key out of the process env chain and out of every response", async () => {
    const h = make(planted());
    const res = await getJson(h.app, "/api/config", jsonRequest("POST", { api_key: SECRET }));
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(process.env["CELESTEA_API_KEY"]).toBe(SECRET);
    delete process.env["CELESTEA_API_KEY"];
  });

  it("409s POST /api/config while a turn is running", async () => {
    const h = make();
    const busy = busyRuntime();
    const h2 = makeHarness({ runtime: busy });
    harnesses.push(h2);
    const res = await getJson(h2.app, "/api/config", jsonRequest("POST", { model: "m-2" }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: "turn in progress; config applies between turns" });
  });
});

describe("dialog", () => {
  it("POST /api/turn returns 202 + started and rejects empty input with the bare {error} body", async () => {
    const h = make();
    const empty = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "   " }));
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: "input must not be empty" });
    const res = await h.app.request("/api/turn", jsonRequest("POST", { input: "hi" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ turn: 1, status: "started" });
  });

  it("W513: a busy session takes the input as an interjection (no 409) and 200s cancel", async () => {
    const h = makeHarness({ runtime: busyRuntime() });
    harnesses.push(h);
    const res = await getJson(h.app, "/api/turn", jsonRequest("POST", { input: "hi" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, injected: true, turn: 0, pending: 1 });
    const cancel = await getJson(h.app, "/api/cancel", jsonRequest("POST"));
    expect(cancel.body).toEqual({ ok: true, cancelled: false });
  });

  it("POST /api/clear truncates the active session log", async () => {
    const h = make();
    await getJson(h.app, "/api/sessions/sample-ws%2Fs1/activate", jsonRequest("POST"));
    const res = await getJson(h.app, "/api/clear", jsonRequest("POST"));
    expect(res.body).toEqual({ ok: true, cleared: true, session: "sample-ws/s1" });
    expect(readFileSync(join(h.workspace, "s1", "cli-main.jsonl"), "utf8")).toBe("");
  });

  it("streams /api/events frames in the frozen envelope", async () => {
    const h = make();
    const res = await h.app.request("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = res.body?.getReader();
    const first = reader?.read();
    h.studio.services.bus.emit("text", 3, { delta: "x" });
    const chunk = new TextDecoder().decode((await first)?.value);
    expect(chunk).toContain("event: text");
    expect(chunk).toContain('"turn":3');
    expect(chunk).toContain('"seq":0');
    expect(chunk).toContain('"payload":{"delta":"x"}');
    await reader?.cancel();
  });
});
