/**
 * Model fallback decorator (iteration E §4.2, P1) — a `Llm`, not a new seam.
 *
 * `createFallbackLlm({ targets, clientFor, policy, onAttempt, steps })` returns
 * the SAME `Llm` interface the rest of the engine already consumes, which is why
 * `agent-loop`'s `loop.ts` does not change one line (§4.6): the switch between
 * targets happens entirely inside `generate`/the returned stream.
 *
 * The decorator owns exactly four things (§4.2.2, each mechanically testable):
 *   1. the TRIGGER TABLE — which failures hand over to the next target and which
 *      ones terminate (a 401/403/400 is a configuration problem: another model
 *      cannot fix it). The table itself is data ([DEFAULT_FALLBACK_POLICY]);
 *   2. the `produced` LOCK — once a text/thinking delta reached the consumer the
 *      attempt is NEVER redone: redoing it would drop text the user already saw
 *      and double-bill / double-write side effects (§4.5 R4-2);
 *   3. target-level COOLDOWN — `failureThreshold` consecutive failures bench a
 *      target for `cooldownMs`; a benched target is tried last, never first;
 *   4. VISIBILITY — every hand-over is reported through `onAttempt` (the host
 *      turns that into an SSE `status` frame, a local audit line and the
 *      statusline's `effective_model`), and through the optional step sink, so
 *      one user intent that cost N attempts is visible as N ledger rows.
 *
 * Honest boundaries (§4.5): availability fallback ONLY (no quality judgement),
 * no key rotation, no persistent cooldown (that is P2).
 */

import type { Usage } from "@celestea/core";
import { LlmError, retryAfterMsOf, TIMEOUT_ERROR_PREFIX, type LlmErrorKind, type TimeoutStage } from "./errors.js";
import { hostOf } from "./host.js";
import type { Llm, LlmStream, ModelRequestDraft, StreamEvent } from "./seam.js";

/** One fallback target: its own client, hence its own base_url/key/timeouts. */
export interface LlmTarget {
  /** Stable name used in the ledger (`fallback_from`), the SSE frame and audits. */
  name: string;
  /** `providers.json` row id, for the ledger's `provider` column. */
  provider: string;
  model: string;
  /** Absent = inherit the composed profile's base_url. */
  baseUrl?: string | null;
  /** Env var NAME holding this target's key (never the key itself, §4.5 R4-3). */
  apiKeyEnv?: string | null;
}

/** §4.2.1 defaults, verbatim. */
export interface FallbackPolicy {
  /** 1 primary + 1 fallback by default; never more targets than this. */
  maxAttempts: number;
  /** Target-level cooldown once a target has failed `failureThreshold` times. */
  cooldownMs: number;
  failureThreshold: number;
  notRetryableStatuses: number[];
  retryableStatuses: number[];
  /** Honour `Retry-After`, but never wait longer than `cooldownMs` (§4.5 R4-4). */
  respectRetryAfter: boolean;
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  maxAttempts: 2,
  cooldownMs: 60_000,
  failureThreshold: 3,
  notRetryableStatuses: [400, 401, 403, 404, 422],
  retryableStatuses: [408, 425, 429, 500, 502, 503, 504],
  respectRetryAfter: true,
};

/** What one CLOSED attempt is booked as (structurally = runtime's `LedgerStepSink`). */
export interface FallbackStepHandle {
  record(usage: Usage): void;
  close(outcome: {
    kind: "ok" | "error";
    error_kind?: string | null;
    http_status?: number | null;
    retryable?: boolean | null;
  }): void;
}

export interface FallbackStepSink {
  beginStep(info: {
    provider: string | null;
    model: string | null;
    base_url_host: string | null;
    attempt: number;
    fallback_from: string | null;
  }): FallbackStepHandle;
}

/**
 * One HAND-OVER, as reported to the host (SSE/audit/statusline). The hook fires
 * when the decorator actually switches — not for the attempt that failed, and
 * never when the failure is terminal (produced-lock / non-retryable status), so
 * "a frame was emitted" always means "another target is being tried".
 */
export interface FallbackAttemptInfo {
  /** Index of the attempt that is ABOUT to run (§5.2 numbering). */
  attempt: number;
  /** The target about to run. */
  target: string;
  model: string;
  /** The target that just failed and is being left behind. */
  from: string | null;
  /** `http_503` / `timeout_idle` / `stream` / `network` / `generate`. */
  reason: string;
  httpStatus: number | null;
  /** text/thinking deltas already delivered by the failing attempt. */
  produced: number;
}

/** Target health, shared by every session of one process (§4.2.2 cooldown). */
export class FallbackState {
  private readonly failures = new Map<string, number>();
  private readonly benchUntil = new Map<string, number>();

  consecutiveFailures(name: string): number {
    return this.failures.get(name) ?? 0;
  }

  cooldownUntil(name: string): number {
    return this.benchUntil.get(name) ?? 0;
  }

  isCooling(name: string, now: number): boolean {
    return this.cooldownUntil(name) > now;
  }

  /** One failed attempt; `failureThreshold` in a row benches the target. */
  noteFailure(name: string, now: number, policy: FallbackPolicy): void {
    const failures = this.consecutiveFailures(name) + 1;
    this.failures.set(name, failures);
    if (failures >= policy.failureThreshold) this.benchUntil.set(name, now + policy.cooldownMs);
  }

  noteSuccess(name: string): void {
    this.failures.set(name, 0);
    this.benchUntil.set(name, 0);
  }

  snapshot(now: number): Array<{ name: string; cooling: boolean; consecutive_failures: number; cooldown_until: number }> {
    const names = new Set([...this.failures.keys(), ...this.benchUntil.keys()]);
    return [...names].sort().map((name) => ({
      name,
      cooling: this.isCooling(name, now),
      consecutive_failures: this.consecutiveFailures(name),
      cooldown_until: this.cooldownUntil(name),
    }));
  }
}

export interface FallbackLlmOptions {
  targets: LlmTarget[];
  /** Builds ONE client per target (own base_url/key/timeouts); called lazily. */
  clientFor: (target: LlmTarget) => Llm;
  policy?: Partial<FallbackPolicy>;
  /** Process-shared cooldown/health; a private one is created when absent. */
  state?: FallbackState;
  /** Called once per failed attempt (the visibility hook). */
  onAttempt?: (info: FallbackAttemptInfo) => void;
  /** Per-attempt ledger booking; absent = no ledger hook. */
  steps?: FallbackStepSink | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The decorator + the read-only views the statusline needs (§4.2.3 #4). */
export interface FallbackLlm extends Llm {
  /** Target of the newest attempt (the EFFECTIVE model), null before any. */
  effective(): { name: string; model: string } | null;
  /** Targets in the order this process would try them right now (cooling last). */
  chain(): string[];
  /** Reason of the newest hand-over (`http_503`, …), null while none happened. */
  lastReason(): string | null;
  /** Failed attempts observed by THIS decorator (diagnostics/tests). */
  failedAttempts(): number;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Cooled-down targets go LAST: a benched target is never the preferred one. */
export function orderTargets(targets: readonly LlmTarget[], state: FallbackState, now: number): LlmTarget[] {
  const warm = targets.filter((t) => !state.isCooling(t.name, now));
  const cold = targets.filter((t) => state.isCooling(t.name, now));
  return [...warm, ...cold];
}

/**
 * The mutable state of ONE decorator instance. It is a plain object so the
 * attempt loop can live at module level: §4.1 caps a function at 80 lines and
 * `createFallbackLlm` is a factory, not the algorithm.
 */
interface FallbackRuntime {
  opts: FallbackLlmOptions;
  targets: LlmTarget[];
  policy: FallbackPolicy;
  state: FallbackState;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  clients: Map<string, Llm>;
  failed: number;
  lastReason: string | null;
  effective: { name: string; model: string } | null;
}

export function createFallbackLlm(opts: FallbackLlmOptions): FallbackLlm {
  const targets = opts.targets.filter((t) => t.name.trim() !== "");
  if (targets.length === 0) throw new Error("fallback: at least one target is required");
  const rt: FallbackRuntime = {
    opts,
    targets,
    policy: { ...DEFAULT_FALLBACK_POLICY, ...(opts.policy ?? {}) },
    state: opts.state ?? new FallbackState(),
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? sleepMs,
    clients: new Map<string, Llm>(),
    failed: 0,
    lastReason: null,
    effective: null,
  };
  return {
    generate: (req: ModelRequestDraft): Promise<LlmStream> => Promise.resolve(attemptLoop(rt, req)),
    effective: () => rt.effective,
    chain: () => orderTargets(targets, rt.state, rt.now()).map((t) => t.name),
    lastReason: () => rt.lastReason,
    failedAttempts: () => rt.failed,
  };
}

/** One client per target, built on first use (its own base_url/key/timeouts). */
function clientOf(rt: FallbackRuntime, target: LlmTarget): Llm {
  const known = rt.clients.get(target.name);
  if (known !== undefined) return known;
  const built = rt.opts.clientFor(target);
  rt.clients.set(target.name, built);
  return built;
}

/** One failed attempt: count it, and bench the target if it keeps failing. */
function noteFailure(rt: FallbackRuntime, target: LlmTarget, info: FailureInfo): void {
  rt.failed += 1;
  rt.lastReason = info.reason;
  rt.state.noteFailure(target.name, rt.now(), rt.policy);
}

/** The switch itself is the event the host publishes (§4.2.3). */
function announce(rt: FallbackRuntime, next: LlmTarget, attempt: number, from: string, info: FailureInfo): void {
  rt.opts.onAttempt?.({
    attempt,
    target: next.name,
    model: next.model,
    from,
    reason: info.reason,
    httpStatus: info.httpStatus,
    produced: info.produced,
  });
}

/** `Retry-After` is honoured up to `cooldownMs`; beyond it we move on. */
async function honourRetryAfter(rt: FallbackRuntime, info: FailureInfo): Promise<void> {
  if (!rt.policy.respectRetryAfter || info.retryAfterMs === null) return;
  if (info.retryAfterMs > rt.policy.cooldownMs) return;
  if (info.retryAfterMs > 0) await rt.sleep(info.retryAfterMs);
}

/** The whole attempt loop, lazily: the first events are pulled by the loop. */
async function* attemptLoop(rt: FallbackRuntime, req: ModelRequestDraft): LlmStream {
  const plan = orderTargets(rt.targets, rt.state, rt.now()).slice(0, Math.max(1, rt.policy.maxAttempts));
  let from: string | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const target = plan[attempt] as LlmTarget;
    const step = rt.opts.steps?.beginStep({
      provider: target.provider,
      model: target.model,
      base_url_host: hostOf(target.baseUrl ?? null),
      attempt,
      fallback_from: from,
    });
    let stream: LlmStream;
    try {
      stream = await clientOf(rt, target).generate(req);
    } catch (error) {
      const info = describeFailure(error, 0, rt.policy);
      step?.close({ kind: "error", error_kind: info.kind, http_status: info.httpStatus, retryable: info.retryable });
      noteFailure(rt, target, info);
      if (!info.retryable) throw error;
      lastError = error;
      // W835 (P1-2): only wait for Retry-After when another target will run.
      // An exhausted chain must fail fast instead of sleeping up to cooldownMs.
      const next = plan[attempt + 1];
      if (next !== undefined) {
        await honourRetryAfter(rt, info);
        announce(rt, next, attempt + 1, target.name, info);
      }
      from = target.name;
      continue;
    }
    rt.effective = { name: target.name, model: target.model };
    const outcome = yield* consume(stream, step, rt.policy);
    if (outcome.kind === "done") {
      rt.state.noteSuccess(target.name);
      return;
    }
    noteFailure(rt, target, outcome.info);
    // produced > 0 = the lock: the attempt is never redone (§4.2.2).
    if (outcome.info.produced > 0 || !outcome.info.retryable) {
      yield outcome.terminal;
      return;
    }
    lastError = outcome.error;
    // W835 (P1-2): no last-target Retry-After sleep (see the catch branch above).
    const next = plan[attempt + 1];
    if (next !== undefined) {
      await honourRetryAfter(rt, outcome.info);
      announce(rt, next, attempt + 1, target.name, outcome.info);
    }
    from = target.name;
  }
  throw lastError ?? new LlmError("llm fallback: every target failed", "generate", { retryable: false });
}

/** The verdict of one consumed attempt. */
type AttemptOutcome =
  | { kind: "done" }
  | { kind: "failed"; info: FailureInfo; terminal: StreamEvent; error: unknown };

/** Forward one attempt's events, counting what the consumer has already seen. */
async function* consume(
  stream: LlmStream,
  step: FallbackStepHandle | undefined,
  policy: FallbackPolicy,
): AsyncGenerator<StreamEvent, AttemptOutcome, undefined> {
  let produced = 0;
  let closed = false;
  // W835 (P1-3): close the step EXACTLY once. The `finally` covers the case the
  // old code missed: the consumer abandoned the attempt (break / cancel), the
  // generator is returned, and the usage already recorded must still be booked
  // instead of silently dropped.
  const closeStep = (outcome: {
    kind: "ok" | "error";
    error_kind?: string | null;
    http_status?: number | null;
    retryable?: boolean | null;
  }): void => {
    if (closed) return;
    closed = true;
    step?.close(outcome);
  };
  try {
    for await (const event of stream) {
      if (isProducedEvent(event)) produced += 1;
      if (event.kind === "done") {
        closeStep({ kind: "ok" });
        // The terminal event is FORWARDED, not swallowed: the loop derives the
        // turn's `assistant_message` from it (loop.ts:246-253).
        yield event;
        return { kind: "done" };
      }
      // The step buffer is fed HERE, exactly like the W728 observer does: a
      // usage frame belongs to the attempt that produced it (§3.2.3).
      if (event.kind === "usage") step?.record(event.usage);
      if (event.kind === "failed" || event.kind === "interrupted") {
        const info = describeEvent(event, produced);
        closeStep({ kind: "error", error_kind: info.kind, http_status: null, retryable: info.retryable });
        return { kind: "failed", info, terminal: event, error: errorOfEvent(event, info) };
      }
      yield event;
    }
    const info = describeEvent({ kind: "interrupted" }, produced);
    closeStep({ kind: "error", error_kind: info.kind, http_status: null, retryable: info.retryable });
    return { kind: "failed", info, terminal: { kind: "interrupted" }, error: errorOfEvent({ kind: "interrupted" }, info) };
  } catch (error) {
    const info = describeFailure(error, produced, policy);
    closeStep({ kind: "error", error_kind: info.kind, http_status: info.httpStatus, retryable: info.retryable });
    return { kind: "failed", info, terminal: { kind: "interrupted" }, error };
  } finally {
    // Early `return()` from the consumer (break / cancel): book the attempt as
    // ok so its already-recorded usage keeps its row. A no-op on every normal
    // exit because [closeStep] is idempotent.
    closeStep({ kind: "ok" });
  }
}

/**
 * The slice of the trigger table a classifier reads. W9104: the same-target
 * retry decorator (`retry.ts`) reuses this table, and it must not have to carry
 * the fallback policy's `maxAttempts`/`cooldownMs`/`failureThreshold` to do it —
 * one home for the statuses, two policies consuming it.
 */
export type StatusTable = Pick<FallbackPolicy, "notRetryableStatuses" | "retryableStatuses">;

/** One attempt's failure, in the vocabulary of §4.2.2's table. */
export interface FailureInfo {
  reason: string;
  kind: LlmErrorKind;
  retryable: boolean;
  httpStatus: number | null;
  retryAfterMs: number | null;
  produced: number;
  message: string;
}

/** `text`/`thinking` reaching the consumer = the attempt cannot be redone. */
export function isProducedEvent(event: StreamEvent): boolean {
  return event.kind === "text" || event.kind === "thinking";
}

/**
 * Classify a thrown failure. `produced > 0` overrides everything: a failure
 * after visible output is terminal, whatever its status said.
 */
export function describeFailure(
  error: unknown,
  produced: number,
  policy: StatusTable = DEFAULT_FALLBACK_POLICY,
): FailureInfo {
  const rec = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const message = typeof rec["message"] === "string" ? rec["message"] : String(error);
  const status = typeof rec["httpStatus"] === "number" ? rec["httpStatus"] : null;
  const stage = typeof rec["timeoutStage"] === "string" ? (rec["timeoutStage"] as TimeoutStage) : null;
  const isTimeout = rec["isTimeout"] === true || rec["kind"] === "timeout" || message.startsWith(TIMEOUT_ERROR_PREFIX);
  const kind = typeof rec["kind"] === "string" ? (rec["kind"] as LlmErrorKind) : "generate";
  const base = { produced, httpStatus: status, message, retryAfterMs: retryAfterMsOf(error) };
  if (produced > 0) return { ...base, reason: reasonOf(status, isTimeout, stage, kind), kind, retryable: false };
  if (status !== null) {
    return { ...base, reason: `http_${status}`, kind, retryable: statusRetryable(status, policy) };
  }
  if (isTimeout) return { ...base, reason: `timeout_${stage ?? "idle"}`, kind: "timeout", retryable: true };
  if (rec["retryable"] === true) return { ...base, reason: "network", kind, retryable: true };
  if (kind === "stream") return { ...base, reason: "stream", kind, retryable: true };
  return { ...base, reason: "generate", kind, retryable: false };
}

/** Classify a terminal stream event (`failed{kindOf}` / `interrupted`). */
export function describeEvent(
  event: Extract<StreamEvent, { kind: "failed" }> | { kind: "interrupted" },
  produced: number,
): FailureInfo {
  const base = { produced, retryable: produced === 0, httpStatus: null, retryAfterMs: null };
  if (event.kind === "interrupted") {
    return { ...base, reason: "interrupted", kind: "stream", message: "stream interrupted" };
  }
  const kindOf = event.kindOf;
  const kind: LlmErrorKind = kindOf === "timeout" ? "timeout" : kindOf;
  const reason = kindOf === "timeout" ? "timeout_idle" : kindOf;
  return { ...base, reason, kind, message: event.message };
}

function reasonOf(status: number | null, isTimeout: boolean, stage: TimeoutStage | null, kind: LlmErrorKind): string {
  if (status !== null) return `http_${status}`;
  if (isTimeout) return `timeout_${stage ?? "idle"}`;
  return kind === "stream" ? "stream" : "generate";
}

/** A status is worth another target unless it is a request/credential problem. */
function statusRetryable(status: number, policy: StatusTable): boolean {
  if (policy.notRetryableStatuses.includes(status)) return false;
  return status >= 500 || policy.retryableStatuses.includes(status);
}

/** The error a terminal event maps to when the whole chain is exhausted. */
function errorOfEvent(
  event: Extract<StreamEvent, { kind: "failed" }> | { kind: "interrupted" },
  info: FailureInfo,
): LlmError {
  const kind: LlmErrorKind =
    event.kind === "interrupted" ? "stream" : event.kindOf === "generate" ? "generate" : "stream";
  return new LlmError(info.message, kind, { retryable: info.retryable });
}
