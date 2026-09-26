/**
 * Usage ledger, end to end through the PRODUCTION app (W728 §3 P0 + W785 P1).
 *
 * What only this level can prove: the wiring (a real turn through a REAL
 * `@celestea/llm` client → the ledger file), the failure path with W723's
 * structured cause (a 503 books ONE error row whose cost is UNKNOWN, not 0), the
 * price snapshot in production, and — W785 — that the P1 aggregate view reads the
 * SAME file the turn just wrote: `GET /api/usage/ledger` (rows/totals per
 * `group_by`, 422 on a malformed dimension) and `/api/status.cost` (C5's file
 * half: everything is derived from the file, so a restart cannot change it).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { USAGE_LEDGER_FILE, UsageLedgerFile, type UsageStepRecord } from "@celestea/runtime";
import { createStudioApp, type StudioApp } from "../app.js";
import { loadStudioConfig } from "../config.js";
import { jsonRequest } from "../harness.test-util.js";
import { costBlockView, usageLedgerView } from "./ledger-view.js";
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

/** Σ of one session's STEP rows in the file (`turn_total` excluded, like the view). */
function sessionStepTotals(path: string, session: string): { records: number; prompt: number; completion: number } {
  let records = 0;
  let prompt = 0;
  let completion = 0;
  for (const row of ledgerRows(path)) {
    if (row["kind"] === "turn_total" || row["session"] !== session) continue;
    records += 1;
    const usage = row["usage"] as Row | null;
    if (usage === null) continue;
    prompt += usage["prompt_tokens"] as number;
    completion += usage["completion_tokens"] as number;
  }
  return { records, prompt, completion };
}

/** The `ts` of the first step row (the ledger's own clock, in seconds). */
function firstStepTs(path: string): number {
  const row = ledgerRows(path).find((r) => r["kind"] !== "turn_total") ?? {};
  return row["ts"] as number;
}

/** `GET` a ledger URL and parse the body (the query is the test's subject). */
async function getJsonRow(app: Hono, url: string): Promise<Row> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return (await res.json()) as Row;
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

    // W785 P1 ②: the SAME session's cost block comes from the SAME rows — an
    // unbilled attempt is UNKNOWN (null), never 0, and `attempts` counts it.
    const status = (await (await host.app.request("/api/status")).json()) as Row;
    expect(status["cost"]).toEqual({
      session_total: null,
      turn_total: null,
      attempts: 1,
      currency: "CNY",
      priced_by: "unpriced",
      unpriced_models: [],
      records: 1,
      cost_complete: false,
    });
  });

  it("writes nothing at all when CELESTEA_USAGE_LEDGER=off", async () => {
    const upstream = await startMockProvider([[textDelta("off"), usageChunk(10, 1), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl, { CELESTEA_USAGE_LEDGER: "off" });
      await runTurn(host.app, "no ledger please");
      await waitIdle(host.studio);
      expect(existsSync(host.ledgerPath)).toBe(false);
      expect(ledgerRows(host.ledgerPath)).toEqual([]);

      // W785: "off" is not an error — the endpoint answers 200 with ok:false, and
      // /api/status omits `cost` entirely instead of inventing a null block.
      const ledger = await host.app.request("/api/usage/ledger");
      expect(ledger.status).toBe(200);
      expect(await ledger.json()).toEqual({ ok: false, error: "usage ledger disabled" });
      const status = (await (await host.app.request("/api/status")).json()) as Row;
      expect(status["cost"]).toBeUndefined();
    } finally {
      await upstream.close();
    }
  });

});

describe("aggregate view over the ledger file (W785 P1 ①/②)", () => {
  it("serves one row per session, keyed and totalled like the ledger's own step rows", async () => {
    const upstream = await startMockProvider([[textDelta("收"), usageChunk(1000, 200), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl);
      await runTurn(host.app, "aggregate please");
      await waitIdle(host.studio);

      const res = await host.app.request("/api/usage/ledger?session=ws%2Fs1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Row;
      expect(body["ok"]).toBe(true);
      expect(body["group_by"]).toBe("session");
      expect(body["currency"]).toBe("CNY");
      expect(body["price_version"]).toBe("2026-09-11");
      expect(body["unpriced_models"]).toEqual([]);

      const rows = body["rows"] as Row[];
      expect(rows).toHaveLength(1);
      const row = rows[0] ?? {};
      expect(row["key"]).toBe("ws/s1");
      // ONE step row: the `turn_total` row restates it and is never counted twice.
      expect(row["records"]).toBe(1);
      expect(row["unpriced_records"]).toBe(0);
      expect(row["cost"]).toEqual({ in: 0.001, out: 0.0004, cache: 0, total: 0.0014 });

      // `totals` equals the sums of THAT session's step rows in the file.
      const expected = sessionStepTotals(host.ledgerPath, "ws/s1");
      const totals = body["totals"] as Row;
      expect(totals["records"]).toBe(expected.records);
      expect(totals["tokens"]).toMatchObject({ prompt_tokens: expected.prompt, completion_tokens: expected.completion });
      expect(totals["cost"]).toEqual({ in: 0.001, out: 0.0004, cache: 0, total: 0.0014 });
      expect(totals["cost_complete"]).toBe(true);

      // W785 P1 ②: /api/status answers the same session's cost block.
      const status = (await (await host.app.request("/api/status")).json()) as Row;
      expect(status["cost"]).toEqual({
        session_total: 0.0014,
        turn_total: 0.0014,
        attempts: 1,
        currency: "CNY",
        priced_by: "table",
        unpriced_models: [],
        records: 1,
        cost_complete: true,
      });
    } finally {
      await upstream.close();
    }
  });

  it("folds by model and honours the inclusive since/until window", async () => {
    const upstream = await startMockProvider([[textDelta("m"), usageChunk(1000, 200), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl);
      await runTurn(host.app, "fold by model");
      await waitIdle(host.studio);
      const ts = firstStepTs(host.ledgerPath);

      const byModel = await getJsonRow(host.app, `/api/usage/ledger?group_by=model`);
      expect(byModel["group_by"]).toBe("model");
      expect((byModel["rows"] as Row[]).map((r) => r["key"])).toEqual([MODEL]);

      // Both bounds are INCLUSIVE, so the row's own second is inside the window...
      const inside = await getJsonRow(host.app, `/api/usage/ledger?since=${ts}&until=${ts}`);
      expect((inside["rows"] as Row[]).map((r) => r["key"])).toEqual(["ws/s1"]);
      // ...and a window that starts one second later excludes it without failing.
      const outside = await getJsonRow(host.app, `/api/usage/ledger?since=${ts + 1}`);
      expect(outside["rows"]).toEqual([]);
      expect((outside["totals"] as Row)["records"]).toBe(0);
    } finally {
      await upstream.close();
    }
  });

  it("rejects a malformed dimension and a non-integer bound with 422", async () => {
    const upstream = await startMockProvider([[textDelta("x"), usageChunk(1, 1), DONE_FRAME]]);
    try {
      const host = makeHost(upstream.v1BaseUrl);

      const bogus = await host.app.request("/api/usage/ledger?group_by=bogus");
      expect(bogus.status).toBe(422);
      expect(await bogus.json()).toEqual({
        ok: false,
        error: "field 'group_by' must be one of session, turn, model, day, day_model",
      });

      const since = await host.app.request("/api/usage/ledger?since=yesterday");
      expect(since.status).toBe(422);
      expect(await since.json()).toEqual({ ok: false, error: "field 'since' must be an integer" });
    } finally {
      await upstream.close();
    }
  });
});

/**
 * W836 R3 batch F (P2-2): the two host views the adapter wires
 * (`real-runtime-adapter.ts:593/598`) must count a rolled `.1` segment, so a
 * rotation cannot zero `/api/status.cost`. The probe drives those real view
 * functions over a `UsageLedgerFile` with a tiny threshold.
 */
function appendLedgerStep(file: UsageLedgerFile, step: number, prompt: number, completion: number): void {
  const record: UsageStepRecord = {
    v: 1, ts: 1, kind: "ok", session: "ws/s1", turn: 0, turn_id: "turn-0",
    step, attempt: 0, provider: "mock", model: "deepseek-chat", base_url_host: null,
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_read: 0, reasoning_tokens: 0 },
    billed_unknown: false, error_kind: null, http_status: null, retryable: null,
    price: null, cost: null, priced_by: "unpriced", fallback_from: null,
  };
  file.append(record);
}

describe("W836 P2-2: the host ledger views survive a rotation", () => {
  it("counts current + `.1` in /api/status.cost and /api/usage/ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-view-r3-"));
    roots.push(root);
    const path = join(root, USAGE_LEDGER_FILE);
    const file = new UsageLedgerFile({ path, maxBytes: 1 });
    appendLedgerStep(file, 1, 100, 10);
    appendLedgerStep(file, 2, 200, 20);
    expect(existsSync(`${path}.1`)).toBe(true);

    const block = costBlockView(file, "ws/s1", null);
    expect(block?.records).toBe(2);
    expect(block?.session_total).toBeNull();
    expect(block?.priced_by).toBe("unpriced");
    expect(block?.unpriced_models).toEqual(["deepseek-chat"]);

    const view = usageLedgerView(file, { session: "ws/s1" });
    if (!view.ok) throw new Error("ledger view unavailable");
    expect(view.totals.records).toBe(2);
    expect(view.totals.tokens.prompt_tokens).toBe(300);
    expect(view.totals.tokens.completion_tokens).toBe(30);
  });
});
