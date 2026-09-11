/**
 * Usage ledger, end to end through the PRODUCTION app (W728 §3 P0).
 *
 * What only this level can prove: the wiring (a real turn through a REAL
 * `@celestea/llm` client → the ledger file), the failure path with W723's
 * structured cause (a 503 books ONE error row whose cost is UNKNOWN, not 0),
 * the price snapshot in production, and that P0 added NO endpoint (§3.3: the
 * aggregate `GET /api/usage/ledger` is P1 and must still be 404).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { DONE_FRAME, startMockProvider, textDelta, usageChunk } from "./mock-provider.test-util.js";

const MODEL = "mock-v4-flash";
const roots: string[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.close();
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/**
 * A minimal upstream that always answers with ONE status error (the SSE path is
 * covered by `startMockProvider`, which the live-engine tests already use).
 */
async function startFailingUpstream(status: number, body: string): Promise<string> {
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

interface Host {
  app: Hono;
  studio: StudioApp;
  ledgerPath: string;
}

/** The production app over a throwaway data root, with pricing + the ledger. */
function makeHost(v1BaseUrl: string, envOverride: NodeJS.ProcessEnv = {}): Host {
  const root = mkdtempSync(join(tmpdir(), "usage-ledger-"));
  roots.push(root);
  const workspace = join(root, "ws");
  const sessionDir = join(workspace, "s1");
  const staticRoot = join(root, "dist");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>ledger</title>\n");
  writeFileSync(join(sessionDir, "cli-main.jsonl"), "");
  const write = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  write(join(root, "workspaces.json"), { workspaces: [{ path: workspace }], active_session: "ws/s1" });
  write(join(root, "prompts.json"), {});
  write(join(root, "pricing.json"), {
    version: "2026-09-11",
    currency: "CNY",
    unit: "per_mtok",
    models: { [MODEL]: { in: 1.0, out: 2.0, cache_read: 0.1 } },
  });
  write(join(root, "providers.json"), {
    providers: [
      {
        id: "mock",
        name: "Mock Gateway",
        note: "ledger upstream",
        base_url: v1BaseUrl,
        request_format: "chat_completions",
        api_key: null,
        models: [{ id: MODEL, name: MODEL, reasoning_efforts: [], context_window: 1_000_000, max_output_tokens: null }],
      },
    ],
    default_model: MODEL,
  });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CELESTEA_")) env[k] = v;
  env["CELESTEA_API_KEY"] = "test-key";
  env["CELESTEA_TOOL_ROOTS"] = workspace;
  env["CELESTEA_SANDBOX_NET"] = "0";
  Object.assign(env, envOverride);
  const config = loadStudioConfig({ cwd: root, env, paths: { staticRoot } });
  const studio = createStudioApp({ config, env });
  return { app: studio.app, studio, ledgerPath: join(root, "usage-ledger.jsonl") };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runTurn(app: Hono, input: string): Promise<void> {
  const res = await app.request("/api/turn", jsonRequest("POST", { input }));
  expect(res.status).toBe(202);
}

async function waitIdle(studio: StudioApp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (studio.services.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("turn did not settle");
    await sleep(5);
  }
  await sleep(5);
}

type Row = Record<string, unknown>;

function ledgerRows(path: string): Row[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Row);
  } catch {
    return [];
  }
}

describe("production app books every model step", () => {
  it("books an ok row and a turn_total row for a completed turn", async () => {
    const upstream = await startMockProvider([[textDelta("收"), usageChunk(1000, 200), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl);
      await runTurn(host.app, "LEDGER-SECRET-INPUT");
      await waitIdle(host.studio);

      const rows = ledgerRows(host.ledgerPath);
      expect(rows).toHaveLength(2);
      const step = rows[0] ?? {};
      expect(step["kind"]).toBe("ok");
      expect(step["session"]).toBe("ws/s1");
      expect(step["turn"]).toBe(0);
      expect(step["turn_id"]).toBe("turn-0");
      expect(step["step"]).toBe(1);
      expect(step["attempt"]).toBe(0);
      expect(step["provider"]).toBe("mock");
      expect(step["model"]).toBe(MODEL);
      expect(step["base_url_host"]).toBe(new URL(upstream.v1BaseUrl).host);
      expect(step["priced_by"]).toBe("table");
      expect(step["billed_unknown"]).toBe(false);
      expect((step["price"] as Row)["version"]).toBe("2026-09-11");
      expect(step["cost"]).toEqual({ in: 0.001, out: 0.0004, cache: 0, total: 0.0014 });

      const total = rows[1] ?? {};
      expect(total["kind"]).toBe("turn_total");
      expect(total["steps"]).toBe(1);
      expect(total["attempts"]).toBe(1);
      expect(total["outcome"]).toBe("completed");
      expect((total["usage"] as Row)["prompt_tokens"]).toBe(1000);
      expect((total["usage"] as Row)["completion_tokens"]).toBe(200);
      expect(total["cost_complete"]).toBe(true);

      // C8: counters and names only — never the conversation.
      const raw = readFileSync(host.ledgerPath, "utf8");
      expect(raw).not.toContain("LEDGER-SECRET-INPUT");
      expect(raw).not.toContain("收");
      expect(raw).not.toContain("test-key");
    } finally {
      await upstream.close();
    }
  });

  it("books a 503 as ONE error row whose cost is UNKNOWN (C4) and adds no endpoint", async () => {
    const baseUrl = await startFailingUpstream(503, '{"error":"unavailable"}');
    const host = makeHost(baseUrl);

    await runTurn(host.app, "failed turn");
    await waitIdle(host.studio);

    const rows = ledgerRows(host.ledgerPath);
    expect(rows).toHaveLength(2);
    const step = rows[0] ?? {};
    expect(step["kind"]).toBe("error");
    expect(step["usage"]).toBeNull();
    expect(step["cost"]).toBeNull();
    expect(step["billed_unknown"]).toBe(true);
    expect(step["http_status"]).toBe(503);
    expect(step["retryable"]).toBe(true);
    expect(step["error_kind"]).toBe("generate");
    const total = rows[1] ?? {};
    expect(total["kind"]).toBe("turn_total");
    expect(total["cost"]).toBeNull();
    expect(total["cost_complete"]).toBe(false);
    expect(total["billed_unknown_steps"]).toBe(1);
    expect(total["outcome"]).toMatchObject({ error: { kind: "generate" } });

    // P0 added no endpoint and no status block: both are P1 (§3.3).
    expect((await host.app.request("/api/usage/ledger")).status).toBe(404);
    const status = (await (await host.app.request("/api/status")).json()) as Row;
    expect(status["cost"]).toBeUndefined();
  });

  it("writes nothing at all when CELESTEA_USAGE_LEDGER=off", async () => {
    const upstream = await startMockProvider([[textDelta("off"), usageChunk(10, 1), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl, { CELESTEA_USAGE_LEDGER: "off" });
      await runTurn(host.app, "no ledger please");
      await waitIdle(host.studio);
      expect(existsSync(host.ledgerPath)).toBe(false);
      expect(ledgerRows(host.ledgerPath)).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

});
