/**
 * Pricing snapshot + cost arithmetic (iteration E §3.2.2, W728 P0).
 *
 * The three rules that matter: a model the snapshot does not cover is `unpriced`
 * (never a silent 0); the cost is nothing but `tokens/1e6 × unit price` with the
 * component split of the design's worked example; and the cache-hit region is
 * billed ONCE, at the cache price (the prompt counter already contains it) —
 * `in` is the UNCACHED input.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Usage } from "@celestea/core";
import {
  PRICING_UNIT,
  costAdd,
  costOf,
  emptyPricing,
  loadPricingFile,
  parsePricing,
  priceFor,
  priceSnapshot,
  pricingPath,
  type LedgerCost,
  type ModelPrice,
} from "./pricing.js";

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * The REJECTED reading, kept only as a regression oracle: the whole prompt at
 * `in` PLUS the cache counter on top (the hit region charged twice). The new
 * formula must never agree with it while `cache_read > 0`.
 */
function doubleChargedCostOf(u: Usage, p: ModelPrice): LedgerCost {
  const inCost = round6((u.prompt_tokens / 1e6) * p.in);
  const outCost = round6((u.completion_tokens / 1e6) * p.out);
  const cacheCost = round6((u.cache_read / 1e6) * p.cache_read);
  return { in: inCost, out: outCost, cache: cacheCost, total: round6(inCost + outCost + cacheCost) };
}

const usage = (prompt: number, completion = 0, cacheRead = 0): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  cache_read: cacheRead,
  reasoning_tokens: 0,
});

const PRICE: ModelPrice = { in: 1.0, out: 2.0, cache_read: 0.1 };

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A throwaway `<data dir>/pricing.json` with two priced models. */
function pricingFile(): string {
  const root = mkdtempSync(join(tmpdir(), "pricing-"));
  roots.push(root);
  const path = join(root, "pricing.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: "2026-09-11",
      currency: "CNY",
      unit: "per_mtok",
      models: {
        "deepseek-chat": { in: 1.0, out: 2.0, cache_read: 0.1 },
        "half-priced": { in: 0.5, out: 1.0 },
      },
    }),
  );
  return path;
}

describe("pricing table", () => {
  it("parses the snapshot and defaults a missing cache price to 0", () => {
    const t = loadPricingFile(pricingFile());
    expect(t.version).toBe("2026-09-11");
    expect(t.currency).toBe("CNY");
    expect(t.unit).toBe(PRICING_UNIT);
    expect(priceFor(t, "deepseek-chat")).toEqual({ in: 1.0, out: 2.0, cache_read: 0.1 });
    expect(priceFor(t, "half-priced")).toEqual({ in: 0.5, out: 1.0, cache_read: 0 });
  });

  it("returns null (not 0) for an unknown model", () => {
    const t = loadPricingFile(pricingFile());
    expect(priceFor(t, "nope")).toBeNull();
    expect(priceFor(t, null)).toBeNull();
  });

  it("treats a missing file as an empty table instead of throwing", () => {
    const t = loadPricingFile(join(tmpdir(), "definitely-absent-pricing.json"));
    expect(t.models).toEqual({});
    expect(t.version).toBe("none");
    expect(priceFor(t, "deepseek-chat")).toBeNull();
    expect(emptyPricing().models).toEqual({});
  });

  it("treats an unparsable file as an empty table (every model unpriced)", () => {
    const root = mkdtempSync(join(tmpdir(), "pricing-bad-"));
    roots.push(root);
    const path = join(root, "pricing.json");
    writeFileSync(path, "{ not json");
    expect(loadPricingFile(path).models).toEqual({});
    expect(parsePricing({ models: 3 })).toBeNull();
    expect(parsePricing("nope")).toBeNull();
  });

  it("honors CELESTEA_PRICING_FILE and the <data dir> default", () => {
    expect(pricingPath("/data", {})).toBe(join("/data", "pricing.json"));
    expect(pricingPath("/data", { CELESTEA_PRICING_FILE: "/elsewhere/p.json" })).toBe("/elsewhere/p.json");
  });
});

describe("cost arithmetic", () => {
  it("reproduces the design's worked example with the cache region billed once", () => {
    const cost = costOf(usage(8123, 411, 4096), PRICE);
    // in = the 8123 - 4096 = 4027 UNCACHED prompt tokens; cache = 4096 at 0.1.
    expect(cost).toEqual({ in: 0.004027, out: 0.000822, cache: 0.00041, total: 0.005259 });
  });

  it("bills a cache hit at the cache price only (prompt=1000, cache_read=800)", () => {
    const u = usage(1000, 0, 800);
    const cost = costOf(u, PRICE);
    expect(cost.in).toBe(0.0002); // 200 billable input tokens
    expect(cost.cache).toBe(0.00008); // 800 hit tokens at the cache price
    expect(cost.total).toBe(0.00028);
    // The hit region is NOT also charged at the input price.
    expect(cost.total).toBeLessThan(doubleChargedCostOf(u, PRICE).total);
    expect(cost.total).toBe(round6(doubleChargedCostOf(u, PRICE).total - (800 / 1e6) * PRICE.in));
  });

  it("is byte-identical to the old formula when nothing was cached (no regression)", () => {
    for (const prompt of [0, 1, 200, 1000, 8123, 1_000_000]) {
      for (const completion of [0, 411]) {
        const u = usage(prompt, completion, 0);
        expect(costOf(u, PRICE)).toEqual(doubleChargedCostOf(u, PRICE));
      }
    }
  });

  it("floors the input component at 0 when cache_read > prompt_tokens (anomalous data)", () => {
    const cost = costOf(usage(100, 0, 250), PRICE);
    expect(cost.in).toBe(0); // never negative
    expect(cost.cache).toBe(0.000025); // 250 tokens at 0.1: the reported counter is still billed
    expect(cost.out).toBe(0);
    expect(cost.total).toBe(0.000025);
    expect(cost.total).toBeGreaterThanOrEqual(0);
    expect(costOf(usage(0, 0, 0), PRICE)).toEqual({ in: 0, out: 0, cache: 0, total: 0 });
  });

  it("never bills the cache-hit region twice (regression anchor)", () => {
    const u = usage(10_000, 500, 9_000);
    const cost = costOf(u, PRICE);
    const legacy = doubleChargedCostOf(u, PRICE);
    // in is the uncached input — NOT the whole prompt.
    expect(cost.in).toBe(0.001); // 1000 tokens
    expect(cost.in).not.toBe(round6((u.prompt_tokens / 1e6) * PRICE.in));
    expect(cost.cache).toBe(0.0009); // 9000 tokens at 0.1
    // The two readings differ by exactly the hit region priced at `in`.
    expect(round6(legacy.total - cost.total)).toBe(0.009);
    expect(cost.total).toBe(0.0029); // 0.001 in + 0.001 out + 0.0009 cache
  });

  it("adds component-wise so a total cannot drift from its parts", () => {
    const a = costOf(usage(1_000_000, 0, 0), { in: 2, out: 0, cache_read: 0 });
    const b = costOf(usage(250_000, 0, 0), { in: 2, out: 0, cache_read: 0 });
    expect(a).toEqual({ in: 2, out: 0, cache: 0, total: 2 });
    expect(costAdd(a, b)).toEqual({ in: 2.5, out: 0, cache: 0, total: 2.5 });
    const cached = costAdd(costOf(usage(1000, 0, 800), PRICE), costOf(usage(1000, 0, 800), PRICE));
    expect(cached).toEqual({ in: 0.0004, out: 0, cache: 0.00016, total: 0.00056 });
  });

  it("freezes the snapshot per row (version travels with the money)", () => {
    const t = loadPricingFile(pricingFile());
    const price = priceFor(t, "deepseek-chat");
    expect(price).not.toBeNull();
    expect(priceSnapshot(t, price ?? { in: 0, out: 0, cache_read: 0 })).toEqual({
      version: "2026-09-11",
      currency: "CNY",
      unit: "per_mtok",
      in: 1,
      out: 2,
      cache_read: 0.1,
    });
  });
});
