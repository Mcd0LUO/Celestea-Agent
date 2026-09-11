/**
 * Pricing snapshot + cost arithmetic (iteration E §3.2.2, W728 P0).
 *
 * The two rules that matter: a model the snapshot does not cover is `unpriced`
 * (never a silent 0), and the cost is nothing but `tokens/1e6 × unit price`
 * with the component split of the design's worked example.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
} from "./pricing.js";

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
  it("reproduces the design's worked example exactly", () => {
    const cost = costOf(
      { prompt_tokens: 8123, completion_tokens: 411, total_tokens: 8534, cache_read: 4096, reasoning_tokens: 0 },
      { in: 1.0, out: 2.0, cache_read: 0.1 },
    );
    expect(cost).toEqual({ in: 0.008123, out: 0.000822, cache: 0.00041, total: 0.009355 });
  });

  it("adds component-wise so a total cannot drift from its parts", () => {
    const a = costOf({ prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, cache_read: 0, reasoning_tokens: 0 }, { in: 2, out: 0, cache_read: 0 });
    const b = costOf({ prompt_tokens: 250_000, completion_tokens: 0, total_tokens: 250_000, cache_read: 0, reasoning_tokens: 0 }, { in: 2, out: 0, cache_read: 0 });
    expect(a).toEqual({ in: 2, out: 0, cache: 0, total: 2 });
    expect(costAdd(a, b)).toEqual({ in: 2.5, out: 0, cache: 0, total: 2.5 });
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
