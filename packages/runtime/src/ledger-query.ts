/**
 * Aggregate views over the append-only usage ledger (iteration E §3.2.4, W785 P1).
 *
 * Two readers, both pure functions of the records a [UsageLedgerFile] hands over,
 * so a restart, a hot swap or a second process cannot change the answer:
 *
 *   - [queryLedger]      — `GET /api/usage/ledger`: the step rows of the ledger,
 *                          filtered (`session`/`since`/`until`) and folded into
 *                          one row per `session` | `turn` | `model` | `day` |
 *                          `day_model` (the last is the day x model cross
 *                          product the usage page's per-model trend needs, W9103);
 *   - [ledgerCostBlock]  — `/api/status.cost`: one session's running total, its
 *                          newest `turn_total` row and how many attempts bought it.
 *
 * `turn_total` rows are DELIBERATELY excluded from every sum: they are the
 * reconciliation convenience of §3.2.1 (they restate the steps of their turn), so
 * counting them would book every token twice. Details stay the only truth.
 *
 * `cost` is `null` — never `0` — when no contributing row carried a cost, and
 * `unpriced_records`/`unpriced_models` name the models the price table could not
 * cover (§3.2.2 rule 3: an unknown price is UNKNOWN, not free).
 */

import { usageAdd, zeroUsage, type Usage } from "@celestea/core";
import { costAdd, type LedgerCost } from "./pricing.js";
import {
  aggregateUsage,
  type LedgerTotals,
  type UsageLedgerRecord,
  type UsageStepRecord,
  type UsageTurnTotalRecord,
} from "./ledger.js";

/** The dimension one aggregate row is folded by (§3.2.4). */
export type LedgerGroupBy = "session" | "turn" | "model" | "day" | "day_model";

/** What `GET /api/usage/ledger` accepts. `since`/`until` are SECONDS, like `ts`. */
export interface LedgerQuery {
  session?: string;
  since?: number;
  until?: number;
  group_by?: LedgerGroupBy;
}

/** One aggregate row: the same accumulation rule for every dimension. */
export interface LedgerQueryRow {
  key: string;
  tokens: Usage;
  /** null = no contributing row was priced (never 0, §3.2.2). */
  cost: LedgerCost | null;
  records: number;
  /** Rows that carried usage the table could not price. */
  unpriced_records: number;
  /**
   * The group's wall-clock span, in epoch SECONDS: the oldest and the newest
   * `ts` among the rows that folded into it. A row exists only because at least
   * one step folded into it, and every step carries a `ts`, so both are always
   * numbers — the span of a ONE-step group is 0, not unknown.
   *
   * W9103: the usage page needs "how long was the longest session", which the
   * token/cost accumulators alone cannot answer (they sum, they do not span).
   */
  first_ts: number;
  last_ts: number;
}

/** The `GET /api/usage/ledger` body (P1 ①). */
export interface LedgerQueryResult {
  ok: true;
  currency: string;
  group_by: LedgerGroupBy;
  rows: LedgerQueryRow[];
  totals: LedgerTotals;
  unpriced_models: string[];
  price_version: string | null;
}

/** The `/api/status.cost` block (P1 ②) — the engine's own estimate, per session. */
export interface LedgerCostBlock {
  /** Sum of the session's step-row costs; null = nothing priced yet (not 0). */
  session_total: number | null;
  /** Cost of the session's NEWEST `turn_total` row; null = none/unpriced. */
  turn_total: number | null;
  /**
   * How many ATTEMPTS bought it — the COUNT of this session's step rows, the
   * same口径 as `turn_total.attempts` in the ledger (E §3.4 D6: three attempts
   * read as 3, never as 1+2+3 = 6). One row is one attempt by construction.
   */
  attempts: number;
  currency: string;
  /** `unpriced` = at least one row was unpriced or unbilled (cost incomplete). */
  priced_by: "table" | "unpriced";
  unpriced_models: string[];
  records: number;
  cost_complete: boolean;
}

/** The default dimension when the query omits `group_by` (§3.2.4). */
export const DEFAULT_LEDGER_GROUP_BY: LedgerGroupBy = "session";

/** Every dimension the endpoint accepts, in contract order. */
export const LEDGER_GROUP_BY_VALUES: readonly LedgerGroupBy[] = [
  "session",
  "turn",
  "model",
  "day",
  "day_model",
];

/** Label of a row whose model the provider never reported (§3.2.1). */
export const UNKNOWN_MODEL_LABEL = "(unknown model)";

/** The step rows a query counts, in file order (see the module header). */
function queryRows(records: readonly UsageLedgerRecord[], q: LedgerQuery): UsageStepRecord[] {
  const out: UsageStepRecord[] = [];
  for (const record of records) {
    if (record.kind === "turn_total") continue;
    if (!inRange(record, q)) continue;
    out.push(record);
  }
  return out;
}

/** `session` exact match plus the INCLUSIVE `since`/`until` window (§3.2.4). */
function inRange(record: UsageStepRecord, q: LedgerQuery): boolean {
  if (q.session !== undefined && record.session !== q.session) return false;
  if (q.since !== undefined && record.ts < q.since) return false;
  if (q.until !== undefined && record.ts > q.until) return false;
  return true;
}

/** The UTC calendar day of a step row (§3.2.4's `day` key). */
function dayKeyOf(record: UsageStepRecord): string {
  return new Date(record.ts * 1000).toISOString().slice(0, 10);
}

/** The key one step row folds into for the requested dimension. */
function groupKeyOf(record: UsageStepRecord, by: LedgerGroupBy): string {
  if (by === "model") return record.model ?? UNKNOWN_MODEL_LABEL;
  if (by === "turn") return `${record.session}|${record.turn_id ?? "-"}`;
  if (by === "day") return dayKeyOf(record);
  // W9103: the day x model CROSS product — the usage page's trend chart is one
  // line per model per day, which neither `day` nor `model` alone can express.
  if (by === "day_model") return `${dayKeyOf(record)}|${record.model ?? UNKNOWN_MODEL_LABEL}`;
  return record.session;
}

/** One aggregate row while it is being folded. */
interface RowAcc {
  tokens: Usage;
  cost: LedgerCost | null;
  records: number;
  unpriced: number;
  /** See [LedgerQueryRow.first_ts]/[LedgerQueryRow.last_ts]. */
  firstTs: number;
  lastTs: number;
}

/** Tokens, cost and the unpriced count all follow the SAME per-row rule. */
function accumulate(acc: RowAcc, record: UsageStepRecord): void {
  acc.records += 1;
  // Every step row carries a `ts` (it is the row's own write time), so the span
  // is exact rather than inferred: min/max over the folded rows.
  if (record.ts < acc.firstTs) acc.firstTs = record.ts;
  if (record.ts > acc.lastTs) acc.lastTs = record.ts;
  if (record.usage !== null) {
    acc.tokens = usageAdd(acc.tokens, record.usage);
    if (record.priced_by === "unpriced") acc.unpriced += 1;
  }
  if (record.cost !== null) acc.cost = acc.cost === null ? record.cost : costAdd(acc.cost, record.cost);
}

/** A fresh accumulator seeded with the first row's timestamp. */
function newAcc(record: UsageStepRecord): RowAcc {
  return {
    tokens: zeroUsage(),
    cost: null,
    records: 0,
    unpriced: 0,
    firstTs: record.ts,
    lastTs: record.ts,
  };
}

/** Stable, locale-independent key order (`<`/`>` on code units, ascending). */
function compareKeys(a: LedgerQueryRow, b: LedgerQueryRow): number {
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** Fold the selected step rows into the aggregate rows of one dimension. */
function foldRows(selected: readonly UsageStepRecord[], by: LedgerGroupBy): LedgerQueryRow[] {
  const groups = new Map<string, RowAcc>();
  for (const record of selected) {
    const key = groupKeyOf(record, by);
    const acc = groups.get(key) ?? newAcc(record);
    accumulate(acc, record);
    groups.set(key, acc);
  }
  const rows: LedgerQueryRow[] = [];
  for (const [key, acc] of groups) {
    rows.push({
      key,
      tokens: acc.tokens,
      cost: acc.cost,
      records: acc.records,
      unpriced_records: acc.unpriced,
      first_ts: acc.firstTs,
      last_ts: acc.lastTs,
    });
  }
  return rows.sort(compareKeys);
}

/**
 * The aggregate view: filter, fold by dimension, and total.
 *
 * `totals` reuses [aggregateUsage] over the ALREADY filtered rows (the P0
 * aggregate, unchanged: it owns the currency/price-version/unpriced rules), and the
 * result echoes its `currency`/`price_version`/`unpriced_models` so a client never
 * has to recompute them from the rows.
 */
export function queryLedger(records: readonly UsageLedgerRecord[], q: LedgerQuery): LedgerQueryResult {
  const by = q.group_by ?? DEFAULT_LEDGER_GROUP_BY;
  const selected = queryRows(records, q);
  const totals = aggregateUsage(selected);
  return {
    ok: true,
    currency: totals.currency,
    group_by: by,
    rows: foldRows(selected, by),
    totals,
    unpriced_models: totals.unpriced_models,
    price_version: totals.price_version,
  };
}

/** The newest `turn_total` row of one session (file order = write order). */
function lastTurnTotal(records: readonly UsageLedgerRecord[], session: string): UsageTurnTotalRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record !== undefined && record.kind === "turn_total" && record.session === session) return record;
  }
  return null;
}

/** The step rows of ONE session (the `turn_total` rows never contribute). */
function sessionSteps(records: readonly UsageLedgerRecord[], session: string): UsageStepRecord[] {
  const out: UsageStepRecord[] = [];
  for (const record of records) {
    if (record.kind !== "turn_total" && record.session === session) out.push(record);
  }
  return out;
}

/**
 * `/api/status.cost` for ONE session (P1 ②): what this session has spent so far,
 * what its newest turn cost, and how many attempts that took.
 */
export function ledgerCostBlock(records: readonly UsageLedgerRecord[], session: string): LedgerCostBlock {
  const steps = sessionSteps(records, session);
  const totals = aggregateUsage(steps);
  const last = lastTurnTotal(records, session);
  const attempts = steps.length;
  return {
    session_total: totals.cost === null ? null : totals.cost.total,
    turn_total: last === null || last.cost === null ? null : last.cost.total,
    attempts,
    currency: totals.currency,
    priced_by: totals.cost_complete ? "table" : "unpriced",
    unpriced_models: totals.unpriced_models,
    records: steps.length,
    cost_complete: totals.cost_complete,
  };
}
