/**
 * Usage accounting — the `usage` half of the statusline (Rust W220/W263).
 *
 * The `AgentLoop` records the provider's `usage` stream event for every LLM
 * response; the host reads two views:
 *   - `latest()` — the most recent response (the context-usage surface is the
 *     REAL prompt size of that request: `usage_prompt_tokens`, estimated:false);
 *   - `total()`  — cumulative across every response of this generation.
 *
 * Both accessors return copies, so a caller can never mutate tracked state
 * (Rust `Usage` is `Copy`).
 *
 * The seam is structural (`UsageRecorder` / `UsageAccounting`), not a class
 * identity: `packages/agent-loop` ships its own `UsageTracker` with the same
 * three methods, and the composition root may pass that instance in — the
 * runtime then observes the very same object the loop writes to, with no
 * cross-package type dependency.
 */

import { usageAdd, zeroUsage, type Usage, type UsageBlock } from "@celestea/core";

/** Write side of the seam: what an agent loop needs. */
export interface UsageRecorder {
  record(usage: Usage): void;
}

/** Read side: what the statusline / host needs in addition. */
export interface UsageAccounting extends UsageRecorder {
  latest(): Usage;
  total(): Usage;
}

/** In-memory latest + cumulative tracker (the runtime's default implementation). */
export class UsageTracker implements UsageAccounting {
  private latestUsage: Usage = zeroUsage();
  private totalUsage: Usage = zeroUsage();

  record(usage: Usage): void {
    this.totalUsage = usageAdd(this.totalUsage, usage);
    this.latestUsage = { ...usage };
  }

  latest(): Usage {
    return { ...this.latestUsage };
  }

  total(): Usage {
    return { ...this.totalUsage };
  }

  /** New-turn / new-generation baseline (the tracker keeps no history). */
  reset(): void {
    this.latestUsage = zeroUsage();
    this.totalUsage = zeroUsage();
  }
}

/** Factory form (ARCHITECTURE.md §6.1 `createXxx` convention). */
export function createUsageTracker(): UsageTracker {
  return new UsageTracker();
}

/**
 * `cache_read / prompt_tokens`, clamped to [0,1] and rounded to 4 decimals;
 * 0 when the denominator is 0 (no usage recorded yet). Rust `cache_hit_ratio`.
 */
export function cacheHitRatioRounded(u: Usage): number {
  if (u.prompt_tokens === 0) return 0;
  return round4(clamp01(u.cache_read / u.prompt_tokens));
}

/** One usage block: raw counters plus the derived cache-hit ratio. */
export function usageBlock(u: Usage): UsageBlock {
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    cache_read: u.cache_read,
    cache_hit_ratio: cacheHitRatioRounded(u),
    reasoning_tokens: u.reasoning_tokens,
  };
}

/** The statusline `usage` field: latest block + the same shape under `total`. */
export function usageStatus(u: UsageAccounting): UsageBlock & { total: UsageBlock } {
  return { ...usageBlock(u.latest()), total: usageBlock(u.total()) };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v > 1 ? 1 : v;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
