/**
 * LLM seam constants (P2 placeholder, contract-freezing only).
 *
 * The three usage key names are contract: the statusline reads exactly these.
 */

export interface LlmUsageFrame {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read?: number;
  reasoning_tokens?: number;
}

/** The three required keys (usage_json, src/main.rs:575-600). */
export const USAGE_REQUIRED_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;

/** Three timeout tiers documented for the raw SSE client. */
export interface Timeouts {
  /** connect / first byte */
  connectMs: number;
  /** idle between frames */
  idleMs: number;
  /** whole-request wall clock */
  totalMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { connectMs: 15_000, idleMs: 120_000, totalMs: 600_000 };

/** reasoning_effort is a FREE STRING and must be passed through untouched. */
export function normalizeReasoningEffort(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t === "" || t.toLowerCase() === "off") return null;
  return v;
}
