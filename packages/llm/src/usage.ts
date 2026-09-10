/**
 * Token-usage parsing for the OpenAI-compatible stream (P2a).
 *
 * Mirrors `crates/llm/src/client.rs::extract_usage` 1:1: usage arrives either
 * in a usage-only final frame or attached to the last chunk; cache-hit prompt
 * tokens use three different provider key shapes and all of them are probed.
 * The statusline reads exactly these five flat counters.
 */

/** Provider-reported token usage for one turn (all counters default to 0). */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  reasoning_tokens: number;
}

/** P0 placeholder name, kept as an alias of the real Usage shape. */
export type LlmUsageFrame = Usage;

/** The three required keys (usage_json, src/main.rs:575-600). */
export const USAGE_REQUIRED_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;

/** Flat cache-read keys, probed in order (DeepSeek, then Anthropic-style). */
export const CACHE_READ_FLAT_KEYS = ["prompt_cache_hit_tokens", "cache_read_input_tokens"] as const;

/** Nested cache-read key (OpenAI): usage.prompt_tokens_details.cached_tokens. */
export const CACHE_READ_NESTED = { outer: "prompt_tokens_details", inner: "cached_tokens" } as const;

/** Nested reasoning key: usage.completion_tokens_details.reasoning_tokens. */
export const REASONING_TOKENS_NESTED = {
  outer: "completion_tokens_details",
  inner: "reasoning_tokens",
} as const;

/** A fresh all-zero usage block. */
export function zeroUsage(): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_read: 0,
    reasoning_tokens: 0,
  };
}

/** An all-zero usage block (constant; do not mutate). */
export const ZERO_USAGE: Usage = zeroUsage();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** serde_json `as_u64` equivalent: JSON numbers only, non-negative integers. */
function asU64(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function topLevel(usage: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const n = asU64(usage[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function nested(usage: Record<string, unknown>, outer: string, inner: string): number | undefined {
  const obj = usage[outer];
  if (!isRecord(obj)) return undefined;
  return asU64(obj[inner]);
}

/** True when every counter is zero (the Rust `Usage::is_empty` gate). */
export function usageIsEmpty(u: Usage): boolean {
  return (
    u.prompt_tokens === 0 &&
    u.completion_tokens === 0 &&
    u.total_tokens === 0 &&
    u.cache_read === 0 &&
    u.reasoning_tokens === 0
  );
}

/**
 * Parse a raw `usage` object into Usage. Returns undefined when no token
 * counter is present at all (an empty usage object is not a usage frame).
 */
export function usageFromObject(usage: Record<string, unknown>): Usage | undefined {
  const parsed: Usage = {
    prompt_tokens: topLevel(usage, ["prompt_tokens"]) ?? 0,
    completion_tokens: topLevel(usage, ["completion_tokens"]) ?? 0,
    total_tokens: topLevel(usage, ["total_tokens"]) ?? 0,
    cache_read:
      topLevel(usage, CACHE_READ_FLAT_KEYS) ??
      nested(usage, CACHE_READ_NESTED.outer, CACHE_READ_NESTED.inner) ??
      0,
    reasoning_tokens:
      nested(usage, REASONING_TOKENS_NESTED.outer, REASONING_TOKENS_NESTED.inner) ?? 0,
  };
  return usageIsEmpty(parsed) ? undefined : parsed;
}

/**
 * Extract usage from a decoded chat-completions chunk (the whole chunk JSON,
 * not just the usage object). Returns undefined when the chunk carries none.
 */
export function parseUsage(chunk: unknown): Usage | undefined {
  if (!isRecord(chunk)) return undefined;
  const usage = chunk["usage"];
  if (!isRecord(usage)) return undefined;
  return usageFromObject(usage);
}

/** cache_read / prompt_tokens, clamped to [0,1] and rounded to 4 decimals. */
export function cacheHitRatio(u: Usage): number {
  if (u.prompt_tokens <= 0) return 0;
  const ratio = u.cache_read / u.prompt_tokens;
  return Math.round(Math.min(1, Math.max(0, ratio)) * 10_000) / 10_000;
}
