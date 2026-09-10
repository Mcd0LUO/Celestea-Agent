/**
 * UsageTracker — port of the `UsageTracker` of
 * `crates/agent-loop/src/loop.rs` (W220).
 *
 * The loop records the `usage` stream event of every LLM response; the host
 * reads `latest()` (most recent response) and `total()` (cumulative) to expose
 * the statusline and to drive future trimming decisions. Both accessors return
 * copies, matching Rust's `Copy` semantics — a caller can never mutate the
 * tracker's state through the returned value.
 */

import { usageAdd, zeroUsage, type Usage } from "@celestea/core";

export class UsageTracker {
  private totalUsage: Usage = zeroUsage();
  private latestUsage: Usage = zeroUsage();

  /** Record one LLM response: adds to the cumulative total, becomes latest. */
  record(usage: Usage): void {
    this.totalUsage = usageAdd(this.totalUsage, usage);
    this.latestUsage = usage;
  }

  /** The usage of the most recent LLM response (zeroed when none yet). */
  latest(): Usage {
    return { ...this.latestUsage };
  }

  /** Cumulative usage across every recorded response. */
  total(): Usage {
    return { ...this.totalUsage };
  }
}

/** Factory form (`createXxx` convention, ARCHITECTURE.md §6.1). */
export function createUsageTracker(): UsageTracker {
  return new UsageTracker();
}
