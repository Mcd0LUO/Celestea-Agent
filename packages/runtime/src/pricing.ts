/**
 * Pricing snapshot for the usage ledger (iteration E §3.2.2, W728 P0).
 *
 * The engine converts tokens into money with EXACTLY one rule:
 * `tokens / 1e6 × unit price`. It deliberately does NOT re-implement the
 * platform's billing (group multipliers, expressions, cache discounts):
 * `newapi` owns the price of record (LTS `biz/newapi.md` I1–I3), so a snapshot
 * here is an engine-side ESTIMATE, never a second source of truth (§3.5 R3-2).
 *
 * `pricing.json` is operator/ops supplied (§3.5 R3-1: P0 does not depend on the
 * newapi sync script). A model absent from the table is NOT priced as 0:
 * [priceFor] returns null and the caller must mark the record `unpriced`.
 * A missing or unreadable file is an empty table (every model unpriced) — it is
 * reported on stderr and never throws, because a pricing problem must not break
 * a turn.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@celestea/core";

/** `<data dir>/pricing.json` (§3.2.2). */
export const PRICING_FILE = "pricing.json";
/** Path override (`CELESTEA_PRICING_FILE`). */
export const ENV_PRICING_FILE = "CELESTEA_PRICING_FILE";
/** The only unit the ledger understands (per million tokens). */
export const PRICING_UNIT = "per_mtok";

/** Unit prices of one model, in `PricingTable.currency`, per million tokens. */
export interface ModelPrice {
  in: number;
  out: number;
  cache_read: number;
}

/** A loaded price table plus where it came from (never a bare number map). */
export interface PricingTable {
  version: string;
  currency: string;
  unit: typeof PRICING_UNIT;
  models: Record<string, ModelPrice>;
  effective_from: number | null;
  /** Absolute path the snapshot was read from; null = no table at all. */
  path: string | null;
}

/** Money of one ledger row: the three components and their sum. */
export interface LedgerCost {
  in: number;
  out: number;
  cache: number;
  total: number;
}

/** A table with no models: every lookup is `unpriced` (never 0). */
export function emptyPricing(path: string | null = null): PricingTable {
  return { version: "none", currency: "CNY", unit: PRICING_UNIT, models: {}, effective_from: null, path };
}

/** `<data dir>/pricing.json`, overridable with `CELESTEA_PRICING_FILE`. */
export function pricingPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_PRICING_FILE];
  return override === undefined || override.trim() === "" ? join(dataDir, PRICING_FILE) : override;
}

/** Price of `model`, or null when the snapshot does not cover it. */
export function priceFor(table: PricingTable, model: string | null): ModelPrice | null {
  if (model === null) return null;
  const price = table.models[model];
  return price === undefined ? null : price;
}

/**
 * `prompt × in + completion × out + cache_read × cache_read`, rounded to 6
 * decimals. The component split mirrors the design's worked example (§3.2.1):
 * the prompt counter is charged at the input price AS REPORTED, and the cache
 * counter is charged separately — the engine never invents a "discounted
 * prompt" derivation the platform did not state.
 */
export function costOf(usage: Usage, price: ModelPrice): LedgerCost {
  const inCost = round6((usage.prompt_tokens / 1e6) * price.in);
  const outCost = round6((usage.completion_tokens / 1e6) * price.out);
  const cacheCost = round6((usage.cache_read / 1e6) * price.cache_read);
  return { in: inCost, out: outCost, cache: cacheCost, total: round6(inCost + outCost + cacheCost) };
}

/** Sum of two costs, component-wise (so the total cannot drift from the parts). */
export function costAdd(a: LedgerCost, b: LedgerCost): LedgerCost {
  const inCost = round6(a.in + b.in);
  const outCost = round6(a.out + b.out);
  const cacheCost = round6(a.cache + b.cache);
  return { in: inCost, out: outCost, cache: cacheCost, total: round6(inCost + outCost + cacheCost) };
}

/** The frozen form written into every priced ledger row (a per-row snapshot). */
export interface PriceSnapshot extends ModelPrice {
  version: string;
  currency: string;
  unit: string;
}

/** `price` field of a priced ledger row. */
export function priceSnapshot(table: PricingTable, price: ModelPrice): PriceSnapshot {
  return {
    version: table.version,
    currency: table.currency,
    unit: table.unit,
    in: price.in,
    out: price.out,
    cache_read: price.cache_read,
  };
}

/** Parse a pricing.json document; null = malformed (caller falls back to empty). */
export function parsePricing(input: unknown, path: string | null = null): PricingTable | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const models = parseModels(rec["models"]);
  if (models === null) return null;
  const effective = rec["effective_from"];
  return {
    version: text(rec["version"]) ?? "unknown",
    currency: text(rec["currency"]) ?? "CNY",
    unit: PRICING_UNIT,
    models,
    effective_from: typeof effective === "number" && Number.isFinite(effective) ? effective : null,
    path,
  };
}

/**
 * Read the snapshot. A missing file is an empty table (everything unpriced). A
 * file that exists but does not parse is ALSO an empty table, reported on
 * stderr: pricing half the fleet by a half-read table would under-report cost
 * silently (G3-7).
 */
export function loadPricingFile(path: string): PricingTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return emptyPricing(path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    warn(`pricing file ${path} is not valid JSON (${errorText(e)}) — every model is unpriced`);
    return emptyPricing(path);
  }
  const table = parsePricing(parsed, path);
  if (table === null) {
    warn(`pricing file ${path} has no usable "models" map — every model is unpriced`);
    return emptyPricing(path);
  }
  return table;
}

/** The `models` map, or null when the document has no usable shape at all. */
function parseModels(input: unknown): Record<string, ModelPrice> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const out: Record<string, ModelPrice> = {};
  for (const [model, value] of Object.entries(input as Record<string, unknown>)) {
    const price = parsePrice(value);
    if (price !== null) out[model] = price;
  }
  return out;
}

/** One table row; `in`/`out` are required, `cache_read` defaults to 0. */
function parsePrice(value: unknown): ModelPrice | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const inCost = asPrice(rec["in"]);
  const outCost = asPrice(rec["out"]);
  if (inCost === null || outCost === null) return null;
  return { in: inCost, out: outCost, cache_read: asPrice(rec["cache_read"]) ?? 0 };
}

function asPrice(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function warn(message: string): void {
  process.stderr.write(`usage ledger: ${message}\n`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
