/**
 * Statusline tracker — port of `celestea_studio/src/main.rs:253-330` (W218/W263).
 *
 * Two live counters, fed by the turn sink:
 *   - `steps`     one per tool CALL (its `tool_result` closes that step, so a
 *                 result never doubles the count — W263 semantics, equal to the
 *                 frontend's per-turn tool counter);
 *   - `rate`      the `tokens_per_sec` estimate over text/thinking deltas: the
 *                 5s sliding-window rate (W754) while the window still carries
 *                 output, else the mean over the turn's ACTIVE intervals (W763).
 *
 * W754 rate semantics (the window half): the rate averages over ACTIVE intervals
 * only. Two deltas farther apart than `GAP_MS` (1s) bound a no-flow break (long
 * tool call, rate limit stall, idle tail of a finished turn), and that break is
 * NOT part of the denominator — a wall-clock span over the whole window would
 * otherwise dilute the rate towards zero. The denominator is the sum of the
 * per-interval spans, each floored at `MIN_ACTIVE_MS` (1s) so a lone burst
 * cannot report a silly rate.
 *
 * W763 turn semantics (the fallback half): the window answer is the responsive
 * one (an observed stream read 570 -> 1003 -> 760 tok/s), but an EMPTY window —
 * a stall longer than 5s, or the plain end of a turn — used to report 0 and stay
 * there, which the operator rejected. So the window rate is reported only while
 * it is positive; otherwise the rate is the mean over the whole TURN's active
 * intervals ([turnRate]), a stable positive number until the next `beginTurn()`.
 * 0 therefore means exactly one thing: this turn has produced no delta yet (TTFT).
 *
 * Unit note: what is computed here is CHARACTERS per second, not tokens. The
 * field has always been named `tokens_per_sec` (frozen contract) and the
 * frontend renders it as an approximate ~1:1 token rate, so the unit semantics
 * are deliberately unchanged by W754 — only the denominator changed.
 *
 * W755 context-usage口径 (aligned with the DSH host's `contextPressure`):
 *   1. a provider usage frame has been seen -> `used` = that request's REAL
 *      `prompt_tokens` (input + cache, never output) PLUS the model-visible
 *      growth measured since the sample, so the number answers for the NEXT
 *      request instead of the last one (`projected:true`);
 *   2. no frame yet, but the loop hands back its own assembly -> `used` = the
 *      token estimate of THAT request (system + trimmed history + tool
 *      schemas), never of the raw session log (`assembled_estimate`);
 *   3. neither -> `used` = 0 / `method:"none"`: the UI shows "unknown" rather
 *      than a made-up ratio.
 * The session log's CHARACTER count is never reported as a token count again
 * ([estimatedContextChars] survives as an internal/debug helper only), and a
 * missing context window is reported as `window:0, ratio:0` — the 1,000,000
 * display fallback never enters a ratio (W755, Fix A/B/C).
 *
 * `now()` is injectable so the rate window is testable without sleeping.
 */

import type { ModelRequest, SessionEvent, Statusline, TurnOutcome } from "@celestea/core";
import { estimateMessagesTokens, estimateTokens } from "@celestea/agent-loop";
import { createUsageTracker, usageStatus, type UsageAccounting } from "./usage.js";

/** W218: sliding-window length for `tokens_per_sec`. */
export const RATE_WINDOW_MS = 5_000;
/** W754: deltas farther apart than this bound a no-flow break — excluded from the rate denominator. */
export const GAP_MS = 1_000;
/** W754: minimum duration credited to one activity interval (the old "1s floor" spirit, without counting stalls). */
export const MIN_ACTIVE_MS = 1_000;
/** W218: cadence of the SSE status "progress" events during a turn. */
export const STATUS_TICK_MS = 2_000;

/** One output delta: when it landed and how many chars it carried. */
export interface RateSample {
  at: number;
  chars: number;
}

export class StatusTracker {
  private steps = 0;
  private samples: RateSample[] = [];
  /** W763: the turn's COMPRESSED activity intervals (grows with stoppages, never with deltas). */
  private segments: TurnSegment[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** New-turn baseline: clear the step counter, the rate window and the turn's intervals (W763). */
  beginTurn(): void {
    this.steps = 0;
    this.samples = [];
    this.segments = [];
  }

  /** Record one step (one tool call). */
  addStep(): void {
    this.steps += 1;
  }

  /** Record one output delta (text/thinking) into the rate window and the turn's intervals (W763). */
  addChars(chars: number): void {
    const at = this.now();
    const n = Math.max(0, Math.trunc(chars));
    this.samples.push({ at, chars: n });
    this.trim(at);
    pushTurnDelta(this.segments, at, n);
  }

  /**
   * W763: activity intervals held for the current turn. Diagnostic/test hook —
   * an uninterrupted stream is ONE segment no matter how many deltas it carries.
   */
  get turnSegmentCount(): number {
    return this.segments.length;
  }

  /** Steps recorded in the current turn. */
  get stepCount(): number {
    return this.steps;
  }

  /**
   * Chars-per-second estimate (W754 + W763): the responsive window rate while
   * the 5s window still carries output, otherwise the turn's active-interval
   * mean. 0 only while this turn has not produced a single delta (TTFT).
   */
  rate(): number {
    const now = this.now();
    this.trim(now);
    const window = windowRateOf(this.samples, now);
    return window > 0 ? window : turnRate(this.segments, now);
  }

  private trim(now: number): void {
    while (this.samples.length > 0 && now - (this.samples[0]?.at ?? now) > RATE_WINDOW_MS) {
      this.samples.shift();
    }
  }
}

/**
 * W754: total ACTIVE milliseconds covered by the samples (the rate denominator).
 *
 * Samples are walked in time order; every adjacent pair closer than `GAP_MS`
 * stays in the same activity interval, a wider step closes the interval and
 * opens a new one (the break itself contributes nothing). The final interval is
 * extended to `now` only while the stream still looks alive (`now` within
 * `GAP_MS` of the last delta), so a stall does not keep inflating the
 * denominator. Each interval is credited at least `MIN_ACTIVE_MS`.
 */
export function activeSpanMs(samples: readonly RateSample[], now: number): number {
  const first = samples[0];
  if (first === undefined) return 0;
  let span = 0;
  let segStart = first.at;
  let prev = first.at;
  for (let i = 1; i < samples.length; i += 1) {
    const at = samples[i]?.at ?? prev;
    if (at - prev > GAP_MS) {
      span += Math.max(prev - segStart, MIN_ACTIVE_MS);
      segStart = at;
    }
    prev = at;
  }
  const tail = now - prev;
  const end = tail >= 0 && tail <= GAP_MS ? now : prev;
  return span + Math.max(end - segStart, MIN_ACTIVE_MS);
}

/**
 * W763: one COMPRESSED activity interval of the current turn. Consecutive deltas
 * closer than `GAP_MS` collapse into a single record, so this list grows with
 * the number of stoppages — never with the number of deltas (10k deltas without
 * a pause is ONE segment), which is what keeps the whole turn in O(pauses)
 * memory instead of O(deltas).
 */
export interface TurnSegment {
  /** Wall clock of the interval's first delta (ms). */
  start: number;
  /** Wall clock of the interval's last delta (ms) — the segment's live edge. */
  at: number;
  /** Characters carried by every delta of this interval. */
  chars: number;
}

/** W763: fold one delta into the turn's segments (O(1); allocates only when a pause opens a new interval). */
export function pushTurnDelta(segments: TurnSegment[], at: number, chars: number): void {
  const last = segments[segments.length - 1];
  if (last === undefined || at - last.at > GAP_MS) {
    segments.push({ start: at, at, chars });
    return;
  }
  last.at = at;
  last.chars += chars;
}

/**
 * W763: Σ ACTIVE ms over the turn's segments — the same flooring rule as
 * [activeSpanMs] (every interval ≥ `MIN_ACTIVE_MS`) and the same guard that only
 * extends the OPEN interval while the stream is still alive, so neither a stall
 * nor a finished turn can inflate the denominator.
 */
export function turnSpanMs(segments: readonly TurnSegment[], now: number): number {
  let ms = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const tail = now - seg.at;
    const open = i === segments.length - 1 && tail >= 0 && tail <= GAP_MS;
    ms += Math.max((open ? now : seg.at) - seg.start, MIN_ACTIVE_MS);
  }
  return ms;
}

/**
 * W763: chars/s averaged over the turn's ACTIVE intervals — the "有流时段均值" the
 * operator asked for. 0 iff the turn has produced no delta at all yet.
 */
export function turnRate(segments: readonly TurnSegment[], now: number): number {
  if (segments.length === 0) return 0;
  let chars = 0;
  for (const seg of segments) chars += seg.chars;
  return (chars / turnSpanMs(segments, now)) * 1_000;
}

/** W754 window half: the 5s-window rate, 0 when the window holds no char-carrying sample. */
function windowRateOf(samples: readonly RateSample[], now: number): number {
  let chars = 0;
  for (const s of samples) chars += s.chars;
  if (chars === 0) return 0;
  return (chars / activeSpanMs(samples, now)) * 1_000;
}

/** Factory form (ARCHITECTURE.md §6.1). */
export function createStatusTracker(now: () => number = Date.now): StatusTracker {
  return new StatusTracker(now);
}

/**
 * W755: which source backs `context_usage.window`.
 *   - `profile`  the session's profile declared a real capacity -> `ratio` is real;
 *   - `fallback` the profile declares none (0 = trimming off), so the only number
 *                left is the contract's DISPLAY default (`CONTEXT_WINDOW_FALLBACK`)
 *                owned by the frontend — `window` stays 0 and no ratio is drawn;
 *   - `unknown`  the configured value is not a usable number at all.
 */
export type ContextWindowSource = "profile" | "fallback" | "unknown";

/**
 * W755 (Fix B): the forward-looking correction of the provider's prompt sample.
 *
 * DSH computes `projectedTokens = pressureTokens + surfaceTokens - sampledSurfaceTokens`
 * so that occupancy answers for the NEXT request rather than the last one
 * (`dsh-token-meter/lib/types/usage-projection.js:178-187`). Same shape here:
 * remember the model-visible estimate observed when a NEW `prompt_tokens` value
 * arrived, and add whatever the visible surface has grown by since.
 *
 * Only growth counts: a shrinking surface (a trim/compaction) never pulls the
 * number BELOW the provider's own measurement — that anchor is a fact.
 *
 * The state is PER SESSION (one instance lives on the session's [StatusView]),
 * never a module singleton and never a timer. A fresh instance per call just
 * degrades to "no projection", which is correct, only lagging.
 */
export class ContextPressure {
  private sampledPrompt = 0;
  private assembledAtSample: number | null = null;

  /**
   * Note the (real prompt, visible estimate) pair of this observation. A prompt
   * value already sampled keeps its original anchor, which is exactly what makes
   * the surface growth measurable; a new value re-anchors.
   */
  observe(promptTokens: number, assembledTokens: number | null): void {
    if (!(promptTokens > 0)) return;
    if (promptTokens === this.sampledPrompt && this.assembledAtSample !== null) return;
    this.sampledPrompt = promptTokens;
    this.assembledAtSample = assembledTokens;
  }

  /**
   * `used` for this observation: the real prompt plus the visible growth since
   * it was sampled. Without either half of the anchor it is just the prompt
   * (`projected:false` — nothing forward-looking was measurable).
   */
  project(promptTokens: number, assembledTokens: number | null): { used: number; projected: boolean } {
    if (!(promptTokens > 0)) return { used: 0, projected: false };
    if (assembledTokens === null || this.assembledAtSample === null) {
      return { used: promptTokens, projected: false };
    }
    const growth = Math.max(0, assembledTokens - this.assembledAtSample);
    return { used: promptTokens + growth, projected: growth > 0 };
  }
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
  /**
   * W755 (Fix A): the model-visible request the NEXT step would build — the
   * loop's OWN assembly (system + trimmed history + tool schemas), or null when
   * the mounted loop cannot snapshot (test doubles). This — not the raw log —
   * is what the context usage falls back to.
   */
  assembled: () => ModelRequest | null;
  /**
   * W755 (Fix B): the per-session projection state. MUST be the same instance on
   * every call for one session (a fresh one per call silently disables the
   * forward-looking correction).
   */
  pressure: ContextPressure;
}

/**
 * W755 (Fix A): token estimate of a MODEL-VISIBLE request — the very estimator
 * the loop's trim budget already uses (`packages/agent-loop/src/context-trim.ts`),
 * reused rather than re-derived, so the two can never disagree: system text +
 * every message (content + structural overhead) + the tool schemas.
 */
export function estimatedContextTokens(request: ModelRequest): number {
  const system = request.system === null ? 0 : estimateTokens(request.system);
  return system + estimateMessagesTokens(request.messages) + estimateTokens(JSON.stringify(request.tools));
}

/** W263: used/window ratio, clamped to [0,1], rounded to 4 decimals. */
export function ratio4(used: number, window: number): number {
  if (window <= 0) return 0;
  const r = used / window;
  return Math.round(Math.min(1, Math.max(0, r)) * 10_000) / 10_000;
}

/**
 * W218 character volume of the session log (user/assistant text + tool call
 * id/name/args + tool result value/error). Thinking deltas and turn markers
 * carry no model-visible history and are free.
 *
 * W755: THIS IS A CHARACTER COUNT, NOT A TOKEN COUNT, and it is no longer part
 * of any reported口径 — `contextUsage` never reports it (the old
 * `session_event_chars` method divided it by a TOKEN window, which over-reported
 * by ~4x for latin text and inflated further for CJK). Kept only as an internal
 * / debug scale reference (and as the regression anchor pinning the fix).
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

/**
 * W755: the context usage, in the DSH口径 — real provider prompt first, else the
 * model-visible assembly's token estimate, else an honest "unknown" (never the
 * session log's character count; see [estimatedContextChars]).
 */
export function contextUsage(view: StatusView): Statusline["context_usage"] {
  const { window, source } = contextWindowOf(view.context_window);
  const assembled = assembledTokensOf(view);
  const prompt = view.usage.latest().prompt_tokens;
  if (prompt > 0) {
    view.pressure.observe(prompt, assembled);
    const { used, projected } = view.pressure.project(prompt, assembled);
    return {
      used,
      window,
      ratio: ratio4(used, window),
      estimated: false,
      method: "usage_prompt_tokens",
      projected,
      window_source: source,
    };
  }
  if (assembled !== null) {
    return {
      used: assembled,
      window,
      ratio: ratio4(assembled, window),
      estimated: true,
      method: "assembled_estimate",
      projected: false,
      window_source: source,
    };
  }
  return { used: 0, window, ratio: 0, estimated: true, method: "none", projected: false, window_source: source };
}

/**
 * W755 (Fix C): the honest window. A missing capacity is NOT a 1,000,000-token
 * window — the contract's display default is for the UI's text only and never
 * enters a ratio (DSH refuses to render the ring at all without a capacity).
 */
function contextWindowOf(configured: number): { window: number; source: ContextWindowSource } {
  if (Number.isFinite(configured) && configured > 0) return { window: Math.trunc(configured), source: "profile" };
  if (configured === 0) return { window: 0, source: "fallback" };
  return { window: 0, source: "unknown" };
}

/** The token estimate of the loop's assembly, or null when it cannot snapshot. */
function assembledTokensOf(view: StatusView): number | null {
  let request: ModelRequest | null = null;
  try {
    request = view.assembled();
  } catch {
    // A statusline read must never fail the endpoint: no snapshot is a valid
    // answer (method "none"), an exception is not.
    request = null;
  }
  return request === null ? null : estimatedContextTokens(request);
}

/**
 * W755: the statusline of a session with NO live generation yet (the studio
 * adapter's "empty one"). Nothing is measurable there — no provider frame, no
 * engine assembly, no events — so it reports the honest `method:"none"` branch
 * (`used:0`) instead of a made-up ratio. A FRESH [ContextPressure] is correct
 * here: with no usage frame no prompt sample is ever observed through it.
 */
export function coldStatusline(input: {
  model: string;
  reasoning_effort: string | null;
  context_window: number;
  now?: () => number;
}): Statusline {
  return statuslineOf({
    model: input.model,
    reasoning_effort: input.reasoning_effort,
    status: createStatusTracker(input.now ?? Date.now),
    usage: createUsageTracker(),
    context_window: input.context_window,
    events: () => [],
    assembled: () => null,
    pressure: new ContextPressure(),
  });
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
