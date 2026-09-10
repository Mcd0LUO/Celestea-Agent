/**
 * LIVE engine wiring, end to end through the PRODUCTION default runtime
 * (W511) — no real network: the upstream is a local mock (`startMockProvider`).
 *
 * What is under test is the deployment path the offline seam used to hide:
 *   providers.json -> startup profile (model / base_url / key channel)
 *   -> `@celestea/llm` client -> real tool call -> real session log
 *   -> `/api/health` + `/api/status` reporting the model and the step count.
 *
 * The offline test proves the switch still works (`CELESTEA_LLM_MODE=offline`):
 * the deterministic seam answers and the mock upstream sees ZERO requests.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionJsonl } from "@celestea/session";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { DONE_FRAME, startMockProvider, textDelta, toolCallDelta, usageChunk } from "./mock-provider.test-util.js";

interface LiveHost {
  app: Hono;
  studio: StudioApp;
  root: string;
  sessionLog: string;
  cleanup(): void;
}

const liveHosts: LiveHost[] = [];

afterEach(() => {
  while (liveHosts.length > 0) liveHosts.pop()?.cleanup();
});

/** A `CELESTEA_*`-free environment plus the caller's overrides. */
function cleanEnv(over: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  return { ...env, ...over };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface LiveHostOptions {
  baseUrl: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string | null;
  modelReasoningEfforts?: string[];
  /** Plant `session.json` with a per-session model override. */
  sessionModel?: string;
}

/**
 * Build the PRODUCTION app (nothing injected) over a throwaway data root whose
 * providers.json carries one `chat_completions` row pointing at `baseUrl`.
 */
function makeLiveHost(opts: LiveHostOptions): LiveHost {
  const root = mkdtempSync(join(tmpdir(), "live-llm-"));
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  const staticRoot = join(root, "dist");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>live</title>\n");
  writeFileSync(join(sessionDir, "cli-main.jsonl"), "");
  if (opts.sessionModel !== undefined) writeJson(join(sessionDir, "session.json"), { model: opts.sessionModel });
  writeJson(join(root, "workspaces.json"), { workspaces: [{ path: workspace }], active_session: "ws/s1" });
  writeJson(join(root, "prompts.json"), {});
  writeJson(join(root, "providers.json"), {
    providers: [
      {
        id: "mock",
        name: "Mock Gateway",
        note: "mock upstream",
        base_url: opts.baseUrl,
        request_format: "chat_completions",
        api_key: opts.apiKey ?? null,
        models: [
          {
            id: opts.model,
            name: opts.model,
            reasoning_efforts: opts.modelReasoningEfforts ?? ["low", "high"],
            context_window: 1_000_000,
            max_output_tokens: null,
          },
        ],
      },
    ],
    default_model: opts.model,
  });
  const env = cleanEnv({
    CELESTEA_API_KEY: "test-key",
    CELESTEA_TOOL_ROOTS: workspace,
    CELESTEA_SANDBOX_NET: "0",
    ...opts.env,
  });
  const config = loadStudioConfig({ cwd: root, env, paths: { staticRoot } });
  const studio = createStudioApp({ config, env });
  const host: LiveHost = {
    app: studio.app,
    studio,
    root,
    sessionLog: join(sessionDir, "cli-main.jsonl"),
    cleanup: (): void => rmSync(root, { recursive: true, force: true }),
  };
  liveHosts.push(host);
  return host;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** POST /api/turn (202 + turn number). */
async function runTurn(app: Hono, input: string): Promise<number> {
  const res = await app.request("/api/turn", jsonRequest("POST", { input }));
  expect(res.status).toBe(202);
  const body = (await res.json()) as Record<string, unknown>;
  return Number(body["turn"]);
}

async function waitIdle(studio: StudioApp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (studio.services.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("live turn did not settle");
    await sleep(5);
  }
  await sleep(5);
}

function eventsOf(host: LiveHost): Array<Record<string, unknown>> {
  const events = parseSessionJsonl(readFileSync(host.sessionLog, "utf8")).events;
  return events as unknown as Array<Record<string, unknown>>;
}

async function jsonOf(app: Hono, path: string): Promise<Record<string, unknown>> {
  return (await (await app.request(path)).json()) as Record<string, unknown>;
}

describe("live LLM assembly (mock upstream, no real network)", () => {
  it("answers with the real model, runs a tool call, counts the step and reports usage", async () => {
    const model = "mock-v4-flash";
    const upstream = await startMockProvider([
      [toolCallDelta("call-1", "run_shell", { command: "echo ts-live-ok" }), usageChunk(120, 8), DONE_FRAME],
      [textDelta("收"), textDelta("到"), usageChunk(240, 4), DONE_FRAME],
    ]);
    try {
      const host = makeLiveHost({ baseUrl: upstream.v1BaseUrl, model, env: { CELESTEA_REASONING_EFFORT: "xhigh-custom" } });
      await runTurn(host.app, "用 run_shell 执行 echo ts-live-ok 然后回复收到");
      await waitIdle(host.studio);

      const events = eventsOf(host);
      const assistant = events.find((e) => e["type"] === "assistant_message");
      expect(assistant?.["text"]).toBe("收到");
      expect(String(assistant?.["text"])).not.toMatch(/^echo:/);

      const call = events.find((e) => e["type"] === "tool_call");
      expect(call).toMatchObject({ name: "run_shell", args: { command: "echo ts-live-ok" } });
      const result = events.find((e) => e["type"] === "tool_result");
      const value = result?.["value"] as Record<string, unknown> | undefined;
      expect(String(value?.["stdout"])).toContain("ts-live-ok");
      expect(result?.["error"]).toBeNull();
      expect(events.find((e) => e["type"] === "turn_end")).toMatchObject({ outcome: "completed" });

      const status = await jsonOf(host.app, "/api/status");
      expect(status["model"]).toBe(model);
      expect(Number(status["steps"])).toBeGreaterThanOrEqual(1);
      const usage = status["usage"] as Record<string, unknown>;
      expect(Number(usage["prompt_tokens"])).toBeGreaterThan(0);
      expect(Number((usage["total"] as Record<string, unknown>)["prompt_tokens"])).toBeGreaterThan(0);

      const health = await jsonOf(host.app, "/api/health");
      expect(health["model"]).toBe(model);
      expect(health["base_url"]).toBe(upstream.v1BaseUrl);
      expect((await jsonOf(host.app, "/api/config"))["model"]).toBe(model);

      // The real request the engine sent upstream.
      expect(upstream.requests).toHaveLength(2);
      const first = upstream.requests[0];
      expect(first?.url).toBe("/v1/chat/completions");
      expect(first?.headers["authorization"]).toBe("Bearer test-key");
      expect(first?.body["model"]).toBe(model);
      expect(first?.body["reasoning_effort"]).toBe("xhigh-custom");
      const tools = first?.body["tools"] as Array<{ function: { name: string } }>;
      expect(tools.map((t) => t.function.name)).toContain("run_shell");
      const secondMessages = upstream.requests[1]?.body["messages"] as Array<{ role: string }>;
      expect(secondMessages.some((m) => m.role === "tool")).toBe(true);
    } finally {
      await upstream.close();
    }
  });

  it("hot-swaps the model through POST /api/config and reports it on health/status", async () => {
    const upstream = await startMockProvider([[textDelta("第二模型"), usageChunk(90, 3), DONE_FRAME]]);
    try {
      const host = makeLiveHost({ baseUrl: upstream.v1BaseUrl, model: "mock-v4-flash" });
      expect((await jsonOf(host.app, "/api/health"))["model"]).toBe("mock-v4-flash");

      const patched = await host.app.request(
        "/api/config",
        jsonRequest("POST", { model: "mock-v4-pro", max_output_tokens: 1234, reasoning_effort: "max" }),
      );
      expect(patched.status).toBe(200);
      const body = (await patched.json()) as Record<string, unknown>;
      expect(body["model"]).toBe("mock-v4-pro");
      expect(body["max_output_tokens"]).toBe(1234);
      expect((await jsonOf(host.app, "/api/health"))["model"]).toBe("mock-v4-pro");
      expect((await jsonOf(host.app, "/api/status"))["model"]).toBe("mock-v4-pro");

      await runTurn(host.app, "hi");
      await waitIdle(host.studio);
      expect(upstream.requests[0]?.body["model"]).toBe("mock-v4-pro");
      expect(upstream.requests[0]?.body["max_tokens"]).toBe(1234);
      expect(upstream.requests[0]?.body["reasoning_effort"]).toBe("max");
      expect(eventsOf(host).find((e) => e["type"] === "assistant_message")?.["text"]).toBe("第二模型");
    } finally {
      await upstream.close();
    }
  });

  it("honors a session-level model override when the session is activated", async () => {
    const upstream = await startMockProvider([[textDelta("会话模型"), usageChunk(60, 3), DONE_FRAME]]);
    try {
      const host = makeLiveHost({ baseUrl: upstream.v1BaseUrl, model: "mock-v4-flash", sessionModel: "mock-session-model" });
      expect((await jsonOf(host.app, "/api/health"))["model"]).toBe("mock-v4-flash");

      const activated = await host.app.request(`/api/sessions/${encodeURIComponent("ws/s1")}/activate`, jsonRequest("POST"));
      expect(activated.status).toBe(200);
      expect((await jsonOf(host.app, "/api/health"))["model"]).toBe("mock-session-model");
      expect((await jsonOf(host.app, "/api/status"))["model"]).toBe("mock-session-model");

      await runTurn(host.app, "hi");
      await waitIdle(host.studio);
      expect(upstream.requests[0]?.body["model"]).toBe("mock-session-model");
      expect(eventsOf(host).find((e) => e["type"] === "assistant_message")?.["text"]).toBe("会话模型");
    } finally {
      await upstream.close();
    }
  });

  it("switches to the offline seam on CELESTEA_LLM_MODE=offline (mock sees nothing)", async () => {
    const upstream = await startMockProvider([[textDelta("never"), DONE_FRAME]]);
    try {
      const host = makeLiveHost({ baseUrl: upstream.v1BaseUrl, model: "mock-v4-flash", env: { CELESTEA_LLM_MODE: "offline" } });
      await runTurn(host.app, "离线一轮");
      await waitIdle(host.studio);
      const assistant = eventsOf(host).find((e) => e["type"] === "assistant_message");
      expect(String(assistant?.["text"])).toMatch(/^echo: /);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });

  it("still borrows a keyless provider's stored key, and never leaks it into a response", async () => {
    const upstream = await startMockProvider([[textDelta("ok"), usageChunk(10, 1), DONE_FRAME]]);
    try {
      const host = makeLiveHost({
        baseUrl: upstream.v1BaseUrl,
        model: "mock-v4-flash",
        apiKey: "stored-secret-key",
        env: { CELESTEA_API_KEY: undefined },
      });
      await runTurn(host.app, "hi");
      await waitIdle(host.studio);
      expect(upstream.requests[0]?.headers["authorization"]).toBe("Bearer stored-secret-key");
      expect(await (await host.app.request("/api/health")).text()).not.toContain("stored-secret-key");
      expect(await (await host.app.request("/api/providers")).text()).not.toContain("stored-secret-key");
      expect(await (await host.app.request("/api/config")).text()).not.toContain("stored-secret-key");
    } finally {
      await upstream.close();
    }
  });
});
