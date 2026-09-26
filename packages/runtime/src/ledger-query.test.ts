/**
 * The ledger's aggregate views — iteration E §3.2.4 (W785 P1 ①/②).
 *
 * These are pure functions of the records, so the assertions are exact: the fold
 * of every dimension, the inclusive `since`/`until` window, the "unpriced is
 * null, never 0" rule, and the two `turn_total` traps (it must not be counted in
 * a sum, but its cost IS what `/api/status.cost.turn_total` reports).
 */

import { describe, expect, it } from "vitest";
import type { Usage } from "@celestea/core";
import { type UsageLedgerRecord, type UsageStepRecord, type UsageTurnTotalRecord } from "./ledger.js";
import { DEFAULT_LEDGER_GROUP_BY, UNKNOWN_MODEL_LABEL, ledgerCostBlock, queryLedger } from "./ledger-query.js";
import type { LedgerCost, PriceSnapshot } from "./pricing.js";

const PRICE: PriceSnapshot = { version: "2026-09-11", currency: "CNY", unit: "per_mtok", in: 1, out: 2, cache_read: 0.1 };
const TS = 1_760_000_000; // 2025-10-09T08:53:20Z

function usage(prompt: number, completion: number, cacheRead = 0): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_read: cacheRead,
    reasoning_tokens: 0,
  };
}

function cost(total: number): LedgerCost {
  return { in: total, out: 0, cache: 0, total };
}

/** A priced `ok` step row of `ws/a` unless overridden. */
function step(over: Partial<UsageStepRecord> = {}): UsageStepRecord {
  return {
    v: 1,
    ts: TS,
    kind: "ok",
    session: "ws/a",
    turn: 0,
    turn_id: "turn-0",
    step: 1,
    attempt: 0,
    provider: "deepseek",
    model: "deepseek-chat",
    base_url_host: "api.deepseek.com",
    usage: usage(1000, 200),
    billed_unknown: false,
    error_kind: null,
    http_status: null,
    retryable: null,
    price: PRICE,
    cost: cost(0.0014),
    priced_by: "table",
    fallback_from: null,
    ...over,
  };
}

/** The per-turn summary row (never a contributor, always a reconciliation row). */
function turnTotal(over: Partial<UsageTurnTotalRecord> = {}): UsageTurnTotalRecord {
  return {
    v: 1,
    ts: TS,
    kind: "turn_total",
    session: "ws/a",
    turn: 0,
    turn_id: "turn-0",
    steps: 1,
    attempts: 1,
    usage: usage(1000, 200),
    cost: cost(0.0014),
    cost_complete: true,
    priced_by: "table",
    unpriced_models: [],
    billed_unknown_steps: 0,
    outcome: "completed",
    ...over,
  };
}

/** Two sessions, two turns, two days, two models — plus summary rows to ignore. */
function corpus(): UsageLedgerRecord[] {
  return [
    step({ ts: TS, session: "ws/a", turn_id: "turn-0", step: 1, model: "deepseek-chat", usage: usage(1000, 200), cost: cost(0.0014) }),
    step({ ts: TS, session: "ws/a", turn_id: "turn-0", step: 2, model: "deepseek-chat", usage: usage(500, 100), cost: cost(0.0007) }),
    turnTotal({ ts: TS, session: "ws/a", turn_id: "turn-0", steps: 2, usage: usage(1500, 300), cost: cost(0.0021) }),
    step({ ts: TS + 86_400, session: "ws/a", turn_id: "turn-1", step: 1, model: "nope", price: null, priced_by: "unpriced", cost: null, usage: usage(10, 5) }),
    step({ ts: TS + 86_400, session: "ws/b", turn_id: "turn-0", step: 1, model: null, price: null, cost: null, priced_by: "unpriced", usage: usage(7, 3) }),
    turnTotal({ ts: TS + 86_400, session: "ws/b", turn_id: "turn-0", steps: 1, cost: null, cost_complete: false, priced_by: "unpriced" }),
  ];
}

describe("queryLedger · folding", () => {
  it("defaults to `session` and folds every step row of the corpus", () => {
    const result = queryLedger(corpus(), {});
    expect(result.ok).toBe(true);
    expect(result.group_by).toBe(DEFAULT_LEDGER_GROUP_BY);
    expect(result.rows.map((r) => r.key)).toEqual(["ws/a", "ws/b"]);
    expect(result.rows[0]?.records).toBe(3);
    expect(result.rows[0]?.tokens).toEqual(usage(1510, 305));
    expect(result.rows[0]?.cost).toEqual({ in: 0.0021, out: 0, cache: 0, total: 0.0021 });
    expect(result.rows[1]?.records).toBe(1);
    expect(result.rows[1]?.unpriced_records).toBe(1);
    // The `turn_total` rows are restatements: counting them would book 1500+300 twice.
    expect(result.totals.records).toBe(4);
    expect(result.totals.tokens).toEqual(usage(1517, 308));
  });

  it("folds by `turn` on `<session>|<turn_id>`, null turn_id becoming `-`", () => {
    const records = [...corpus(), step({ turn_id: null, turn: null, session: "ws/a", usage: usage(1, 1), cost: cost(0.0001) })];
    const result = queryLedger(records, { group_by: "turn" });
    expect(result.rows.map((r) => r.key)).toEqual(["ws/a|-", "ws/a|turn-0", "ws/a|turn-1", "ws/b|turn-0"]);
    expect(result.rows[1]?.records).toBe(2);
    expect(result.rows[1]?.tokens).toEqual(usage(1500, 300));
  });

  it("folds by `model`, naming the models the provider never reported", () => {
    const result = queryLedger(corpus(), { group_by: "model" });
    // Key order is code-unit ascending, so "(unknown model)" sorts before the names
    // (a row whose provider reported NO model folds into that label, not into "").
    expect(result.rows.map((r) => r.key)).toEqual([UNKNOWN_MODEL_LABEL, "deepseek-chat", "nope"]);
    expect(result.rows.find((r) => r.key === UNKNOWN_MODEL_LABEL)?.records).toBe(1);
  });

  it("folds by `day` on the UTC date of `ts`", () => {
    const result = queryLedger(corpus(), { group_by: "day" });
    expect(result.rows.map((r) => r.key)).toEqual(["2025-10-09", "2025-10-10"]);
    expect(result.rows[0]?.records).toBe(2);
    expect(result.rows[1]?.records).toBe(2);
  });

  /**
   * W9103: the usage page's trend chart is one line per model per day, which
   * neither `day` nor `model` alone can express — hence the cross product.
   */
  it("folds by `day_model` on `<YYYY-MM-DD>|<model>`", () => {
    const result = queryLedger(corpus(), { group_by: "day_model" });
    expect(result.rows.map((r) => r.key)).toEqual([
      `2025-10-09|deepseek-chat`,
      `2025-10-10|${UNKNOWN_MODEL_LABEL}`,
      "2025-10-10|nope",
    ]);
    // The two same-day/same-model steps of ws/a collapse into ONE row...
    expect(result.rows[0]?.records).toBe(2);
    expect(result.rows[0]?.tokens).toEqual(usage(1500, 300));
    // ...while a null model still lands on the shared unknown label, not on "".
    expect(result.rows[1]?.records).toBe(1);
    expect(result.rows[1]?.tokens).toEqual(usage(7, 3));
    // The cross product partitions the same rows: no double counting, no loss.
    expect(result.rows.reduce((n, r) => n + r.records, 0)).toBe(result.totals.records);
  });
});

/**
 * W9103: the group's wall-clock span. The token/cost accumulators SUM, so they
 * cannot answer "how long was the longest session" — these two fields can.
 */
describe("queryLedger · per-row time span", () => {
  it("reports the oldest and newest `ts` of the folded rows", () => {
    const records = [
      step({ ts: TS, session: "ws/a", usage: usage(1, 1), cost: cost(0.1) }),
      step({ ts: TS + 500, session: "ws/a", usage: usage(1, 1), cost: cost(0.1) }),
      step({ ts: TS + 100, session: "ws/a", usage: usage(1, 1), cost: cost(0.1) }),
    ];
    const row = queryLedger(records, { group_by: "session" }).rows[0];
    // Not the file order: the MIN and the MAX of the folded `ts` values.
    expect(row?.first_ts).toBe(TS);
    expect(row?.last_ts).toBe(TS + 500);
    expect((row?.last_ts ?? 0) - (row?.first_ts ?? 0)).toBe(500);
  });

  it("gives a one-step group a span of 0, never an unknown", () => {
    const row = queryLedger([step({ ts: TS })], { group_by: "session" }).rows[0];
    expect(row?.first_ts).toBe(TS);
    expect(row?.last_ts).toBe(TS);
  });

  it("spans per dimension: one day's rows stay inside that day", () => {
    const rows = queryLedger(corpus(), { group_by: "day" }).rows;
    expect(rows[0]?.first_ts).toBe(TS);
    expect(rows[0]?.last_ts).toBe(TS);
    expect(rows[1]?.first_ts).toBe(TS + 86_400);
    expect(rows[1]?.last_ts).toBe(TS + 86_400);
  });
});

describe("queryLedger · filter, unpriced and empty", () => {
  it("filters by session and by an INCLUSIVE since/until window", () => {
    const all = queryLedger(corpus(), { session: "ws/a" });
    expect(all.rows.map((r) => r.key)).toEqual(["ws/a"]);
    expect(all.totals.records).toBe(3);

    const window = queryLedger(corpus(), { since: TS, until: TS });
    expect(window.totals.records).toBe(2);
    expect(window.rows.map((r) => r.key)).toEqual(["ws/a"]);

    expect(queryLedger(corpus(), { since: TS + 1 }).totals.records).toBe(2);
    expect(queryLedger(corpus(), { until: TS - 1 }).totals.records).toBe(0);
    expect(queryLedger(corpus(), { session: "ws/a", since: TS + 1 }).totals.records).toBe(1);
  });

  it("reports an unpriced model instead of charging it 0", () => {
    // The session mixes a priced turn with an unpriced one: the estimate covers
    // what the table covered and SAYS it is incomplete (never a silent 0).
    const mixed = queryLedger(corpus(), { session: "ws/a" });
    expect(mixed.rows[0]?.unpriced_records).toBe(1);
    expect(mixed.rows[0]?.cost).toEqual({ in: 0.0021, out: 0, cache: 0, total: 0.0021 });
    expect(mixed.unpriced_models).toEqual(["nope"]);
    expect(mixed.totals.cost_complete).toBe(false);
    // The price version of the LAST priced row is what the client is told.
    expect(mixed.price_version).toBe("2026-09-11");

    // The unpriced row on its own: the cost is UNKNOWN (null), never 0.
    const only = queryLedger(corpus(), { session: "ws/a", since: TS + 1 });
    expect(only.rows[0]?.cost).toBeNull();
    expect(only.totals.cost).toBeNull();
    expect(only.totals.unpriced_records).toBe(1);
    expect(only.price_version).toBeNull();
  });

  it("answers an empty ledger with an empty view, never a fabricated 0", () => {
    const result = queryLedger([], { group_by: "model" });
    expect(result.rows).toEqual([]);
    expect(result.totals.records).toBe(0);
    expect(result.totals.cost).toBeNull();
    expect(result.currency).toBe("CNY");
    expect(result.price_version).toBeNull();
    expect(result.unpriced_models).toEqual([]);
  });
});

describe("ledgerCostBlock · /api/status.cost", () => {
  it("sums one session's steps and reports its newest turn_total row", () => {
    const records = corpus();
    const block = ledgerCostBlock(records, "ws/a");
    expect(block.session_total).toBe(0.0021);
    expect(block.turn_total).toBe(0.0021);
    expect(block.attempts).toBe(3);
    expect(block.currency).toBe("CNY");
    expect(block.priced_by).toBe("unpriced");
    expect(block.unpriced_models).toEqual(["nope"]);
    expect(block.records).toBe(3);
    expect(block.cost_complete).toBe(false);
  });

  it("counts attempts as ROWS (D6口径: three attempts read as 3) and keeps an empty session at null", () => {
    const records = [
      step({ step: 1, attempt: 0, usage: usage(10, 1), cost: cost(0.0001) }),
      step({ step: 2, attempt: 1, usage: usage(20, 2), cost: cost(0.0002), kind: "error" }),
      step({ step: 3, attempt: 2, usage: usage(30, 3), cost: cost(0.0003) }),
    ];
    const block = ledgerCostBlock(records, "ws/a");
    expect(block.attempts).toBe(3);
    expect(block.session_total).toBe(0.0006);
    // No `turn_total` row was ever written, so the turn cost is UNKNOWN (null).
    expect(block.turn_total).toBeNull();

    const other = ledgerCostBlock(records, "ws/b");
    expect(other).toMatchObject({ session_total: null, turn_total: null, attempts: 0, records: 0, priced_by: "table" });
    expect(ledgerCostBlock([], "ws/a").session_total).toBeNull();
  });
});
