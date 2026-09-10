/**
 * Statusline tracker — port of `celestea_studio/src/main.rs:253-330` (W218/W263).
 *
 * Two live counters, fed by the turn sink:
 *   - `steps`     one per tool CALL (its `tool_result` closes that step, so a
 *                 result never doubles the count — W263 semantics, equal to the
 *                 frontend's per-turn tool counter);
 *   - `rate`      a sliding-window char rate over text/thinking deltas (the
 *                 `tokens_per_sec` estimate), window 5s, span floored at 1s so
 *                 a burst of a few deltas cannot report a silly rate.
 *
 * The context-usage payload prefers the REAL prompt size of the latest request
 * (`usage_prompt_tokens`, estimated:false) and only falls back to the session
 * log's character estimate (`session_event_chars`, estimated:true) while no
 * usage frame has been observed (W263).
 *
 * `now()` is injectable so the rate window is testable without sleeping.
 */

import type { SessionEvent, Statusline, TurnOutcome } from "@celestea/core";
import { usageStatus, type UsageAccounting } from "./usage.js";
import { CONTEXT_WINDOW_FALLBACK } from "./tokens.js";

/** W218: sliding-window length for `tokens_per_sec`. */
export const RATE_WINDOW_MS = 5_000;
/** W218: cadence of the SSE status "progress" events during a turn. */
export const STATUS_TICK_MS = 2_000;

interface RateSample {
  at: number;
  chars: number;
}

export class StatusTracker {
  private steps = 0;
  private samples: RateSample[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** New-turn baseline: clear the step counter and the rate window. */
  beginTurn(): void {
    this.steps = 0;
    this.samples = [];
  }

  /** Record one step (one tool call). */
  addStep(): void {
    this.steps += 1;
  }

  /** Record one output delta (text/thinking) into the rate window. */
  addChars(chars: number): void {
    const at = this.now();
    this.samples.push({ at, chars: Math.max(0, Math.trunc(chars)) });
    this.trim(at);
  }

  /** Steps recorded in the current turn. */
  get stepCount(): number {
    return this.steps;
  }

  /** Current chars-per-second estimate over the sliding window. */
  rate(): number {
    const now = this.now();
    this.trim(now);
    const first = this.samples[0];
    if (first === undefined) return 0;
    const secs = Math.max(1, (now - first.at) / 1_000);
    let chars = 0;
    for (const s of this.samples) chars += s.chars;
    return chars / secs;
  }

  private trim(now: number): void {
    while (this.samples.length > 0 && now - (this.samples[0]?.at ?? now) > RATE_WINDOW_MS) {
      this.samples.shift();
    }
  }
}

/** Factory form (ARCHITECTURE.md §6.1). */
export function createStatusTracker(now: () => number = Date.now): StatusTracker {
  return new StatusTracker(now);
}

/** Everything the statusline needs, so a turn task can snapshot it without a request path. */
export interface StatusView {
  model: string;
  reasoning_effort: string | null;
  status: StatusTracker;
  usage: UsageAccounting;
  /** Live profile context window (0 = trimming off -> contract display default). */
  context_window: number;
  /** The current session log's events (a rebind swaps the producer, not the view). */
  events: () => readonly SessionEvent[];
}

/** W263: used/window ratio, clamped to [0,1], rounded to 4 decimals. */
export function ratio4(used: number, window: number): number {
  if (window <= 0) return 0;
  const r = used / window;
  return Math.round(Math.min(1, Math.max(0, r)) * 10_000) / 10_000;
}

/**
 * W218 context-usage estimate: total character volume of the session log
 * (user/assistant text + tool call id/name/args + tool result value/error).
 * Thinking deltas and turn markers carry no model-visible history and are free.
 */
export function estimatedContextChars(events: readonly SessionEvent[]): number {
  let total = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "user_message":
      case "assistant_message":
        total += ev.text.length;
        break;
      case "tool_call":
        total += ev.id.length + ev.name.length + jsonLen(ev.args);
        break;
      case "tool_result":
        total += ev.id.length + jsonLen(ev.value) + (ev.error?.length ?? 0);
        break;
      default:
        break;
    }
  }
  return total;
}

/** `session_event_chars` vs `usage_prompt_tokens` — the two frozen methods. */
export function contextUsage(view: StatusView): Statusline["context_usage"] {
  const window = view.context_window > 0 ? view.context_window : CONTEXT_WINDOW_FALLBACK;
  const prompt = view.usage.latest().prompt_tokens;
  if (prompt > 0) {
    return { used: prompt, window, ratio: ratio4(prompt, window), estimated: false, method: "usage_prompt_tokens" };
  }
  const used = estimatedContextChars(view.events());
  return { used, window, ratio: ratio4(used, window), estimated: true, method: "session_event_chars" };
}

/** `statusline_of` — the frozen `/api/status` payload. */
export function statuslineOf(view: StatusView): Statusline {
  return {
    model: view.model,
    reasoning_effort: view.reasoning_effort,
    steps: view.status.stepCount,
    tokens_per_sec: Math.round(view.status.rate() * 100) / 100,
    context_usage: contextUsage(view),
    usage: usageStatus(view.usage),
  };
}

function jsonLen(value: unknown): number {
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Terminal outcome -> SSE status phase (the frozen vocabulary). */
export function outcomePhaseOf(outcome: TurnOutcome): string {
  return typeof outcome === "string" ? outcome : "error";
}
