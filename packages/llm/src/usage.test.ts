import { describe, expect, it } from "vitest";

import {
  cacheHitRatio,
  parseUsage,
  USAGE_REQUIRED_KEYS,
  usageFromObject,
  usageIsEmpty,
  ZERO_USAGE,
} from "@celestea/llm";

describe("usage parsing (DeepSeek direct keys)", () => {
  it("reads the flat prompt_cache_hit_tokens cache key", () => {
    const usage = parseUsage({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 7,
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      cache_read: 5,
      reasoning_tokens: 0,
    });
  });

  it("reads the OpenAI nested prompt_tokens_details.cached_tokens key", () => {
    const usage = parseUsage({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
    expect(usage?.cache_read).toBe(6);
    expect(usage?.reasoning_tokens).toBe(4);
    expect(usage?.total_tokens).toBe(30);
  });

  it("reads the cache_read_input_tokens (Anthropic-style) cache key", () => {
    const usage = parseUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 1,
        total_tokens: 101,
        cache_read_input_tokens: 88,
      },
    });
    expect(usage?.cache_read).toBe(88);
  });

  it("prefers the flat cache keys over the nested one", () => {
    const usage = usageFromObject({
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 4,
      prompt_tokens_details: { cached_tokens: 9 },
    });
    expect(usage?.cache_read).toBe(4);
  });

  it("keeps the three required keys listed in USAGE_REQUIRED_KEYS", () => {
    expect([...USAGE_REQUIRED_KEYS]).toEqual([
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
    ]);
  });
});

describe("usage parsing (gates and edge cases)", () => {
  it("returns undefined for absent, empty or non-usage payloads", () => {
    expect(parseUsage({ choices: [] })).toBeUndefined();
    expect(parseUsage({ usage: {} })).toBeUndefined();
    expect(parseUsage({})).toBeUndefined();
    expect(parseUsage(null)).toBeUndefined();
    expect(parseUsage("usage")).toBeUndefined();
    expect(parseUsage({ usage: { prompt_cache_hit_tokens: 0 } })).toBeUndefined();
  });

  it("defaults missing counters to 0", () => {
    const usage = usageFromObject({ total_tokens: 3 });
    expect(usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 3,
      cache_read: 0,
      reasoning_tokens: 0,
    });
  });

  it("ignores non-numeric / negative / fractional counters (serde as_u64 parity)", () => {
    const usage = usageFromObject({
      prompt_tokens: "12",
      completion_tokens: -3,
      total_tokens: 9.5,
      prompt_cache_hit_tokens: null,
      completion_tokens_details: { reasoning_tokens: "4" },
    });
    // every counter was rejected, so there is no usage frame at all
    expect(usage).toBeUndefined();
    expect(usageIsEmpty(ZERO_USAGE)).toBe(true);
    expect(usageIsEmpty({ ...ZERO_USAGE, total_tokens: 1 })).toBe(false);
  });

  it("computes the clamped 4-decimal cache hit ratio", () => {
    expect(cacheHitRatio({ ...ZERO_USAGE, prompt_tokens: 100, cache_read: 25 })).toBe(0.25);
    expect(cacheHitRatio({ ...ZERO_USAGE, prompt_tokens: 0, cache_read: 5 })).toBe(0);
    expect(cacheHitRatio({ ...ZERO_USAGE, prompt_tokens: 3, cache_read: 9 })).toBe(1);
  });
});
