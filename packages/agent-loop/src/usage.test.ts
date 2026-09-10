/** UsageTracker tests — mirror of `usage_events_accumulate_into_shared_tracker`. */

import { describe, expect, it } from "vitest";
import { zeroUsage, type Usage } from "@celestea/core";
import { createUsageTracker, UsageTracker } from "./usage.js";

const usage = (prompt: number, completion: number, cacheRead = 0, reasoning = 0): Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  cache_read: cacheRead,
  reasoning_tokens: reasoning,
});

describe("UsageTracker", () => {
  it("starts zeroed before any stream is recorded", () => {
    const tracker = new UsageTracker();
    expect(tracker.latest()).toEqual(zeroUsage());
    expect(tracker.total()).toEqual(zeroUsage());
  });

  it("keeps the latest stream and the cumulative total", () => {
    const tracker = new UsageTracker();
    tracker.record(usage(10, 5, 3, 2));
    expect(tracker.latest().total_tokens).toBe(15);
    expect(tracker.latest().cache_read).toBe(3);
    expect(tracker.latest().reasoning_tokens).toBe(2);
    expect(tracker.total().total_tokens).toBe(15);
    expect(tracker.total().prompt_tokens).toBe(10);

    tracker.record(usage(20, 5, 1));
    expect(tracker.latest().total_tokens).toBe(25);
    expect(tracker.total()).toEqual(usage(30, 10, 4, 2));
  });

  it("hands out detached copies (Rust Copy semantics)", () => {
    const tracker = createUsageTracker();
    tracker.record(usage(1, 1));
    const latest = tracker.latest();
    latest.total_tokens = 999;
    expect(tracker.latest().total_tokens).toBe(2);
  });
});
