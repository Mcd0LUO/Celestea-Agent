/**
 * `run_code` hard limits + tuning knobs (W255 parity:
 * `crates/tools/src/run_code.rs:39-153`).
 *
 * The limits are parent-side and non-negotiable: the child program cannot talk
 * its way past them, because the broker never dispatches what they forbid.
 * - ≤[`MAX_SUB_CALLS`] sub-calls (the next one is refused, not dispatched);
 * - wall clock ≤ the ceiling from [`ENV_RUN_CODE_MAX_TIMEOUT_MS`] (default
 *   [`MAX_TIMEOUT_MS`] = 120s; [`ENV_RUN_CODE_TIMEOUT_MS`] tunes the *default*
 *   wall clock, the ceiling tunes what a per-call `timeout_ms` may ask for);
 * - sub-call output ledger ≤[`MAX_SUB_OUTPUT_BYTES`] (truncate + warning);
 * - program stdout/stderr logs ≤[`MAX_LOG_BYTES`] (render only).
 *
 * Since `docs/feature-sandbox-time-semantics.md` §3.3 the child's `RLIMIT_CPU`
 * is derived from this run's wall clock, so the wall clock is the only time knob
 * the model has — see [`runCodeMaxTimeoutMs`].
 */

import { envInt } from "../env.js";
import { contractError } from "../errors.js";
import { ToolFailure } from "../tool-failure.js";

/** Stable prefix of every structured `run_code` infrastructure error. */
export const RUN_CODE_ERROR_PREFIX = "run_code";

/**
 * The SDK whitelist — the only tool names the parent dispatches for a sub-call.
 * `spawn_worker` / `send_message` / `process_control` / `http_request` /
 * `run_code` are deliberately excluded (eval §6.5).
 */
export const SDK_TOOLS: readonly string[] = ["read_file", "write_file", "list_dir", "run_shell"];

/** Hard sub-call budget: the 21st dispatched sub-call is refused. */
export const MAX_SUB_CALLS = 20;
/** Hard output ledger for sub-call results: 256 KiB (truncate + warn). */
export const MAX_SUB_OUTPUT_BYTES = 256 * 1024;
/** Hard budget for the program's stdout/stderr log lines (non-protocol): 64 KiB. */
export const MAX_LOG_BYTES = 64 * 1024;
/** Upper bound for one stdout line (protocol requests included): 1 MiB. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Default whole-run wall clock: 120s. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * The legacy hard cap for `timeout_ms`: 120s — now the DEFAULT of the
 * deployer-configurable ceiling (see [`ENV_RUN_CODE_MAX_TIMEOUT_MS`]).
 *
 * The constant is kept, and kept at 120000, so a host with no env answers
 * exactly what it always did; `contracts/tools.json` and the `run_code` DESC are
 * written against this default.
 */
export const MAX_TIMEOUT_MS = 120_000;
/**
 * §3.3: the deployer's ceiling for a per-call `timeout_ms` (default 600000ms).
 *
 * Why it became configurable: the child program now carries an `RLIMIT_CPU`
 * derived from THIS call's wall clock (§3.1), so the wall clock is the only time
 * knob the model has — pinning it at 120s made a legitimately longer program
 * impossible without a code change. Raising it is an operator decision, so it is
 * an env knob, and the DEFAULT is unchanged (120s): nothing gets slower or
 * looser by accident.
 */
export const ENV_RUN_CODE_MAX_TIMEOUT_MS = "CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS";
/** §3.3: the default of [`ENV_RUN_CODE_MAX_TIMEOUT_MS`] — the historical 120s cap. */
export const DEFAULT_MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
/** Grace period for the child to exit after its final/error line. */
export const EXIT_GRACE_MS = 2_000;
/**
 * W833 (R3 B1 / W812 P1-1): bounded wait for ONE protocol reply to reach the
 * child's stdin. A program that requests a sub-call and then stops reading
 * stdin fills the OS pipe buffer; without this bound the parent would park on
 * the write callback forever (the wall clock only fires once the pump returns
 * to the reader). A wedged write is a wall-clock failure: kill + code=timeout.
 */
export const STDIN_WRITE_TIMEOUT_MS = 5_000;
/**
 * W896: the value above is the *default*; the effective one rides on
 * [RunCodeConfig] so a test can shrink it. Before this, the only way to exercise
 * "the child stopped reading stdin" was to wait out the real 5s — which is why
 * that case cost 7.6s in the gate. Making the knob explicit does not weaken the
 * production path: nothing overrides it outside tests, so the shipped value is
 * still 5s.
 */
/** Env var: default whole-run wall clock in ms (clamped to [1, 120000]). */
export const ENV_RUN_CODE_TIMEOUT_MS = "CELAESTEA_RUN_CODE_TIMEOUT_MS";

/** Tuning knobs for the broker (legacy `RunCodeConfig`). */
export interface RunCodeConfig {
  /** Default wall clock; a per-call `timeout_ms` is bounded by [`RunCodeConfig.maxTimeoutMs`]. */
  timeoutMs: number;
  /**
   * §3.3: ceiling for a per-call `timeout_ms`, from
   * [`ENV_RUN_CODE_MAX_TIMEOUT_MS`] (default [`DEFAULT_MAX_TIMEOUT_MS`] = 120000).
   */
  maxTimeoutMs: number;
  /** Sub-call budget; the next call is refused. */
  maxSubCalls: number;
  /** Sub-call output ledger in bytes. */
  maxSubOutputBytes: number;
  /** Program stdout/stderr log budget in bytes. */
  maxLogBytes: number;
  /** Bound on ONE protocol reply reaching the child's stdin (default 5s). */
  stdinWriteTimeoutMs: number;
}

/** Defaults: 120s wall clock (cap 120s), 20 sub-calls, 256KiB sub-call output, 64KiB logs. */
export function runCodeConfig(overrides: Partial<RunCodeConfig> = {}): RunCodeConfig {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: overrides.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    maxSubCalls: overrides.maxSubCalls ?? MAX_SUB_CALLS,
    maxSubOutputBytes: overrides.maxSubOutputBytes ?? MAX_SUB_OUTPUT_BYTES,
    maxLogBytes: overrides.maxLogBytes ?? MAX_LOG_BYTES,
    stdinWriteTimeoutMs: overrides.stdinWriteTimeoutMs ?? STDIN_WRITE_TIMEOUT_MS,
  };
}

/**
 * [`runCodeConfig`] after applying `CELAESTEA_RUN_CODE_TIMEOUT_MS` (the default
 * wall clock) and `CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS` (the ceiling).
 */
export function runCodeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RunCodeConfig {
  const ms = envInt(env, ENV_RUN_CODE_TIMEOUT_MS);
  const cap = runCodeMaxTimeoutMs(env);
  return runCodeConfig({ maxTimeoutMs: cap, ...(ms === undefined ? {} : { timeoutMs: clampTimeoutMs(ms, cap) }) });
}

/**
 * §3.3: the effective ceiling for a per-call `timeout_ms`.
 *
 * Absent → [`DEFAULT_MAX_TIMEOUT_MS`] (120000, the historical hard cap).
 * Present and positive → that value. Present but not a usable positive integer
 * (non-numeric, `0`, negative) → the default, never "unlimited": a typo in an
 * operator knob must not silently remove the ceiling.
 */
export function runCodeMaxTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = envInt(env, ENV_RUN_CODE_MAX_TIMEOUT_MS);
  return configured !== undefined && configured > 0 ? configured : DEFAULT_MAX_TIMEOUT_MS;
}

/** Clamp a wall clock to [1ms, `max`] — the ceiling is hard (default 120000ms). */
export function clampTimeoutMs(ms: number, max: number = DEFAULT_MAX_TIMEOUT_MS): number {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(ms), 1), max);
}

/** Structured infrastructure error (`run_code: code=<code> msg="<quoted>"`). */
export function runCodeFailure(code: string, message: string): ToolFailure {
  return new ToolFailure(code, contractError(RUN_CODE_ERROR_PREFIX, code, message));
}

/**
 * The effective wall clock: `config.timeoutMs` unless the call passes
 * `timeout_ms`, which must be an integer in [1, `config.maxTimeoutMs`] (legacy
 * `invalid_arg`). The ceiling comes from the config, not from a module constant,
 * so the deployer's `CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS` is what actually bounds
 * the model — and the failure message names THAT number.
 */
export function resolveTimeoutMs(raw: unknown, config: RunCodeConfig): number {
  if (raw === undefined || raw === null) return config.timeoutMs;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw runCodeFailure("invalid_arg", "timeout_ms must be an integer");
  }
  if (raw < 1) throw runCodeFailure("invalid_arg", `timeout_ms must be >= 1, got ${raw}`);
  if (raw > config.maxTimeoutMs) {
    throw runCodeFailure("invalid_arg", `timeout_ms=${raw} exceeds the run_code maximum ${config.maxTimeoutMs}ms`);
  }
  return raw;
}
