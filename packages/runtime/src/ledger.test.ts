/**
 * Cost & usage ledger — the P0 assertions of iteration E §3.4 (W728).
 *
 * C1 rows/order, C2 token reconciliation, C3 `unpriced`, C4 failure booking,
 * C6 idempotency, C7 price-version immutability, C8 no body text; plus
 * append-only durability, concurrent appends, restart continuity (C5's file
 * half — the aggregate ENDPOINT is P1) and the pass-through guarantee that
 * makes the ledger "observation only".
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Llm, LlmStream, ModelRequest, SessionLog, StreamEvent, Usage } from "@celestea/core";
import { createLedgerLlm } from "./ledger-llm.js";
import {
  USAGE_LEDGER_FILE,
  UsageLedgerFile,
  type UsageLedger,
  aggregateUsage,
  createUsageLedger,
  createUsageLedgerFile,
  ledgerKey,
  openTurnOf,
  turnNumberOf,
  type UsageStepRecord,
} from "./ledger.js";
import { loadPricingFile } from "./pricing.js";
import { memoryLog } from "./fakes.test-util.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tmpDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-"));
  roots.push(root);
  return root;
}

function usage(prompt: number, completion: number, cacheRead = 0): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read: cacheRead,
    reasoning_tokens: 0,
  };
}

function request(model = "deepseek-chat"): ModelRequest {
  return { model, system: "SECRET-SYSTEM-PROMPT", messages: [], tools: [], max_tokens: null, temperature: null };
}

function streamOf(events: readonly StreamEvent[]): LlmStream {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<StreamEvent>> =>
          i < events.length
            ? { done: false, value: events[i++] as StreamEvent }
            : { done: true, value: undefined },
      };
    },
  };
}

/** A `Llm` whose i-th call replays `answers[i]` (the last one repeats). */
function scriptedLlm(answers: ReadonlyArray<readonly StreamEvent[] | Error>): Llm {
  let calls = 0;
  return {
    generate(): Promise<LlmStream> {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(streamOf(answer ?? []));
    },
  };
}

/** A usage frame + a terminal done frame: one complete model step. */
function okStep(prompt: number, completion: number, cacheRead = 0): StreamEvent[] {
  return [
    { kind: "usage", usage: usage(prompt, completion, cacheRead) },
    { kind: "done", message: { role: "assistant", content: [{ type: "text", content: "SECRET-ASSISTANT-BODY" }], tool_call_id: null } },
  ];
}

async function drain(stream: LlmStream): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

interface Rig {
  file: UsageLedgerFile;
  ledger: UsageLedger;
  path: string;
  log: SessionLog;
  llm: Llm;
  lines(): string[];
  rows(): UsageStepRecord[];
}

/** A ledgered session with an open turn 0, driven by `answers`. */
function rig(answers: ReadonlyArray<readonly StreamEvent[] | Error>, dir = tmpDir()): Rig {
  const path = join(dir, USAGE_LEDGER_FILE);
  const file = new UsageLedgerFile({
    path,
    pricing: loadPricingFile(join(dir, "pricing.json")),
    now: (): number => 1_760_000_000_000,
  });
  const ledger = createUsageLedger({ session: "ws/s1", file });
  const log = memoryLog();
  const turnId = log.nextTurnId();
  log.append({ type: "turn_start", id: turnId });
  log.append({ type: "user_message", text: "SECRET-USER-INPUT" });
  ledger.beginTurn(log);
  const llm = createLedgerLlm({
    inner: scriptedLlm(answers),
    sink: ledger,
    provider: "mock",
    model: "deepseek-chat",
    base_url_host: "api.deepseek.com",
  });
  return {
    file,
    ledger,
    path,
    log,
    llm,
    lines: (): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : []),
    rows: (): UsageStepRecord[] => file.read().filter((r): r is UsageStepRecord => r.kind !== "turn_total"),
  };
}

function closeTurn(r: Rig): void {
  const open = r.log.events().filter((e) => e.type === "turn_start").at(-1);
  r.log.append({ type: "turn_end", id: open?.type === "turn_start" ? open.id : "turn-0", outcome: "completed" });
}

/** A priced `<data dir>/pricing.json`. */
function writePricing(dir: string, version: string, inPrice = 1.0): void {
  writeFileSync(
    join(dir, "pricing.json"),
    JSON.stringify({
      version,
      currency: "CNY",
      unit: "per_mtok",
      models: { "deepseek-chat": { in: inPrice, out: 2.0, cache_read: 0.1 } },
    }),
  );
}

describe("C1/C2: step rows and the turn total", () => {
  it("books one row per step plus one turn_total, in (turn, step) order", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(100, 10), okStep(200, 20), okStep(300, 30)], dir);
    for (let i = 0; i < 3; i++) await drain(await r.llm.generate(request()));
    closeTurn(r);
    r.ledger.endTurn("completed");

    const records = r.file.read();
    expect(records).toHaveLength(4);
    expect(records.slice(0, 3).map((x) => `${x.kind}:${x.turn_id}:${"step" in x ? x.step : "?"}`)).toEqual([
      "ok:turn-0:1",
      "ok:turn-0:2",
      "ok:turn-0:3",
    ]);
    const total = records[3];
    expect(total?.kind).toBe("turn_total");
    if (total?.kind !== "turn_total") throw new Error("no turn_total row");
    expect(total.steps).toBe(3);
    expect(total.attempts).toBe(3);
    expect(total.outcome).toBe("completed");
    // C2: the token dimension reconciles EXACTLY.
    expect(total.usage.prompt_tokens).toBe(600);
    expect(total.usage.completion_tokens).toBe(60);
    expect(total.usage.total_tokens).toBe(660);
    expect(total.cost_complete).toBe(true);
    // The step rows each carry the frozen price snapshot of their own version.
    expect(r.rows()[0]?.price?.version).toBe("2026-09-11");
    expect(r.rows()[0]?.priced_by).toBe("table");
  });

  it("derives the open turn from the log, and books nothing for a turn with no model call", () => {
    const log = memoryLog();
    expect(openTurnOf(log.events())).toBeNull();
    const id = log.nextTurnId();
    log.append({ type: "turn_start", id });
    expect(openTurnOf(log.events())).toEqual({ id: "turn-0", turn: 0 });
    log.append({ type: "turn_end", id, outcome: "cancelled" });
    expect(openTurnOf(log.events())).toBeNull();
    expect(turnNumberOf("turn-12")).toBe(12);
    expect(turnNumberOf("legacy")).toBeNull();
  });
});

describe("C3: unpriced models are explicit, never 0", () => {
  it("marks the row unpriced with a null cost and lists the model", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(1000, 100)], dir);
    const unpriced = createLedgerLlm({ inner: scriptedLlm([okStep(1000, 100)]), sink: r.ledger, model: "nope" });
    await drain(await unpriced.generate(request("nope")));

    const row = r.rows()[0];
    expect(row?.priced_by).toBe("unpriced");
    expect(row?.cost).toBeNull();
    expect(row?.cost).not.toBe(0);
    expect(row?.price).toBeNull();
    const totals = createUsageLedger({ session: "ws/s1", file: r.file }).totals();
    expect(totals.unpriced_models).toEqual(["nope"]);
    expect(totals.unpriced_records).toBe(1);
    expect(totals.cost_complete).toBe(false);
    expect(totals.tokens.prompt_tokens).toBe(1000);
  });
});

describe("C4: failures are booked as unknown cost", () => {
  it("books one error row carrying W723's httpStatus/retryable", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const failure = Object.assign(new Error("stream request failed: 429: rate limited"), {
      name: "LlmError",
      kind: "generate",
      httpStatus: 429,
      retryable: true,
    });
    const r = rig([failure], dir);
    await expect(r.llm.generate(request())).rejects.toBe(failure);

    const row = r.rows()[0];
    expect(row?.kind).toBe("error");
    expect(row?.usage).toBeNull();
    expect(row?.cost).toBeNull();
    expect(row?.billed_unknown).toBe(true);
    expect(row?.http_status).toBe(429);
    expect(row?.retryable).toBe(true);
    expect(row?.error_kind).toBe("generate");
    const totals = aggregateUsage(r.file.read());
    expect(totals.billed_unknown_records).toBe(1);
    expect(totals.cost_complete).toBe(false);
    expect(totals.tokens.prompt_tokens).toBe(0);
  });

  it("books ONE error row (with the observed usage) when a stream tears after a usage frame", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig(
      [[{ kind: "usage", usage: usage(50, 5) }, { kind: "failed", kindOf: "stream", message: "torn" }]],
      dir,
    );
    await drain(await r.llm.generate(request()));
    const rows = r.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("error");
    expect(rows[0]?.usage?.prompt_tokens).toBe(50);
    expect(rows[0]?.cost?.total).toBe(0.00006);
    expect(rows[0]?.billed_unknown).toBe(false);
    expect(rows[0]?.retryable).toBeNull();
  });
});

describe("C6/C7/C8: idempotency, price versions, no body text", () => {
  it("does not book the same step twice", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(10, 1)], dir);
    const stream = await r.llm.generate(request());
    await drain(stream);
    const after = r.lines().length;
    await drain(stream); // a second consumption of the same handle
    expect(r.lines()).toHaveLength(after);

    const row = r.rows()[0] as UsageStepRecord;
    expect(r.file.append(row, ledgerKey(row))).toBe(false);
    expect(r.lines()).toHaveLength(after);
  });

  it("keeps old rows byte-identical when the price version changes", async () => {
    const dir = tmpDir();
    writePricing(dir, "v1", 1.0);
    const first = rig([okStep(1000, 0)], dir);
    await drain(await first.llm.generate(request()));
    const before = readFileSync(first.path, "utf8");

    writePricing(dir, "v2", 2.0);
    const second = rig([okStep(1000, 0)], dir);
    await drain(await second.llm.generate(request("deepseek-chat")));

    expect(readFileSync(first.path, "utf8").startsWith(before)).toBe(true);
    expect(first.rows()[0]?.price?.version).toBe("v1");
    const newest = second.rows().at(-1);
    expect(newest?.price?.version).toBe("v2");
    expect(newest?.cost?.in).toBe(0.002);
  });

  it("never writes prompt, message or tool text", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(100, 10)], dir);
    await drain(await r.llm.generate(request()));
    closeTurn(r);
    r.ledger.endTurn("completed");
    const raw = readFileSync(r.path, "utf8");
    expect(raw).not.toContain("SECRET-USER-INPUT");
    expect(raw).not.toContain("SECRET-ASSISTANT-BODY");
    expect(raw).not.toContain("SECRET-SYSTEM-PROMPT");
    expect(Object.keys(r.rows()[0] ?? {})).not.toContain("text");
  });
});

describe("W756: the cache-hit region is billed once, never twice", () => {
  it("books `in` as the UNCACHED prompt only, with the hit region under `cache`", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11"); // in 1.0, out 2.0, cache_read 0.1
    const r = rig([okStep(1000, 100, 800)], dir);
    await drain(await r.llm.generate(request()));
    closeTurn(r);
    r.ledger.endTurn("completed");

    const row = r.rows()[0] as UsageStepRecord;
    expect(row.usage?.prompt_tokens).toBe(1000);
    expect(row.usage?.cache_read).toBe(800);
    // in = (1000 - 800) x 1.0, out = 100 x 2.0, cache = 800 x 0.1.
    expect(row.cost).toEqual({ in: 0.0002, out: 0.0002, cache: 0.00008, total: 0.00048 });
    // The rejected reading (whole prompt x `in` PLUS the cache counter) = 0.00128.
    expect(row.cost?.total).toBeLessThan(0.00128);
    // The token dimension still reconciles: the row counters are untouched.
    const total = r.file.read().find((x) => x.kind === "turn_total");
    if (total?.kind !== "turn_total") throw new Error("no turn_total row");
    expect(total.cost).toEqual(row.cost);
    expect(total.usage.cache_read).toBe(800);
  });
});

describe("append-only durability, concurrency and restart continuity", () => {
  it("appends without rewriting, and interleaved writers keep whole lines", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(10, 1)], dir);
    await drain(await r.llm.generate(request()));
    const prefix = readFileSync(r.path, "utf8");

    const other = new UsageLedgerFile({ path: r.path, pricing: loadPricingFile(join(dir, "pricing.json")) });
    const ledger = createUsageLedger({ session: "ws/s2", file: other });
    for (let i = 1; i <= 25; i++) {
      const handle = ledger.beginStep({ provider: null, model: "deepseek-chat", base_url_host: null, attempt: 0, fallback_from: null });
      handle.record(usage(i, i));
      handle.close({ kind: "ok" });
    }
    const raw = readFileSync(r.path, "utf8");
    expect(raw.startsWith(prefix)).toBe(true);
    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(26);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it("keeps the session's totals across a new ledger instance (no endpoint: P1)", async () => {
    const dir = tmpDir();
    writePricing(dir, "2026-09-11");
    const r = rig([okStep(100, 10), okStep(200, 20)], dir);
    await drain(await r.llm.generate(request()));
    await drain(await r.llm.generate(request()));
    const before = createUsageLedger({ session: "ws/s1", file: r.file }).totals();

    const reopened = new UsageLedgerFile({ path: r.path, pricing: loadPricingFile(join(dir, "pricing.json")) });
    const after = createUsageLedger({ session: "ws/s1", file: reopened });
    expect(after.totals()).toEqual(before);
    expect(after.total().prompt_tokens).toBe(300);
    expect(after.latest().prompt_tokens).toBe(200);
  });

  it("switches off with CELESTEA_USAGE_LEDGER=off and honors the path override", () => {
    const dir = tmpDir();
    expect(createUsageLedgerFile({ dataDir: dir, env: { CELESTEA_USAGE_LEDGER: "off" } })).toBeNull();
    expect(createUsageLedgerFile({ dataDir: dir, env: {} })?.path).toBe(join(dir, USAGE_LEDGER_FILE));
    const override = join(dir, "elsewhere.jsonl");
    expect(createUsageLedgerFile({ dataDir: dir, env: { CELESTEA_USAGE_LEDGER_FILE: override } })?.path).toBe(override);
  });
});

describe("observation only: the Llm seam is passed through unchanged", () => {
  it("replays every event in order, forwards usage and rethrows the same error", async () => {
    const dir = tmpDir();
    const events: StreamEvent[] = okStep(7, 3, 2);
    const r = rig([events], dir);
    const seen = await drain(await r.llm.generate(request()));
    expect(seen).toEqual(events);

    const boom = new Error("upstream exploded");
    const failing = createLedgerLlm({ inner: scriptedLlm([boom]), sink: createUsageLedger({ session: "ws/s1", file: r.file }) });
    await expect(failing.generate(request())).rejects.toBe(boom);
  });
});
