/**
 * `run_code` hard limits + tuning knobs (W255 parity:
 * `crates/tools/src/run_code.rs:39-153`).
 *
 * The limits are parent-side and non-negotiable: the child program cannot talk
 * its way past them, because the broker never dispatches what they forbid.
 * - ≤[`MAX_SUB_CALLS`] sub-calls (the next one is refused, not dispatched);
 * - wall clock ≤[`MAX_TIMEOUT_MS`] (per-call `timeout_ms` may only lower it;
 *   [`ENV_RUN_CODE_TIMEOUT_MS`] tunes the *default*, never the cap);
 * - sub-call output ledger ≤[`MAX_SUB_OUTPUT_BYTES`] (truncate + warning);
 * - program stdout/stderr logs ≤[`MAX_LOG_BYTES`] (render only).
 */

import { envInt } from "../env.js";
import { contractError } from "../errors.js";
import { ToolFailure } from "../tool-failure.js";

/** Stable prefix of every structured `run_code` infrastructure error. */
export const RUN_CODE_ERROR_PREFIX = "run_code";

/**
 * The SDK whitelist — the only tool names the parent dispatches for a sub-call.
 * `spawn_worker` / `session_send_message` / `process_control` / `http_request` /
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
/** Hard cap for `timeout_ms`: 120s. */
export const MAX_TIMEOUT_MS = 120_000;
/** Grace period for the child to exit after its final/error line. */
export const EXIT_GRACE_MS = 2_000;
/** Env var: default whole-run wall clock in ms (clamped to [1, 120000]). */
export const ENV_RUN_CODE_TIMEOUT_MS = "CELAESTEA_RUN_CODE_TIMEOUT_MS";

/** Tuning knobs for the broker (Rust `RunCodeConfig`). */
export interface RunCodeConfig {
  /** Default wall clock; a per-call `timeout_ms` is bounded by [`MAX_TIMEOUT_MS`]. */
  timeoutMs: number;
  /** Sub-call budget; the next call is refused. */
  maxSubCalls: number;
  /** Sub-call output ledger in bytes. */
  maxSubOutputBytes: number;
  /** Program stdout/stderr log budget in bytes. */
  maxLogBytes: number;
}

/** Defaults: 120s wall clock, 20 sub-calls, 256KiB sub-call output, 64KiB logs. */
export function runCodeConfig(overrides: Partial<RunCodeConfig> = {}): RunCodeConfig {
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxSubCalls: overrides.maxSubCalls ?? MAX_SUB_CALLS,
    maxSubOutputBytes: overrides.maxSubOutputBytes ?? MAX_SUB_OUTPUT_BYTES,
    maxLogBytes: overrides.maxLogBytes ?? MAX_LOG_BYTES,
  };
}

/** [`runCodeConfig`] after applying `CELAESTEA_RUN_CODE_TIMEOUT_MS` (clamped). */
export function runCodeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RunCodeConfig {
  const ms = envInt(env, ENV_RUN_CODE_TIMEOUT_MS);
  return runCodeConfig(ms === undefined ? {} : { timeoutMs: clampTimeoutMs(ms) });
}

/** Clamp a wall clock to [1ms, 120000ms] — the cap is hard. */
export function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(ms), 1), MAX_TIMEOUT_MS);
}

/** Structured infrastructure error (`run_code: code=<code> msg="<quoted>"`). */
export function runCodeFailure(code: string, message: string): ToolFailure {
  return new ToolFailure(code, contractError(RUN_CODE_ERROR_PREFIX, code, message));
}

/**
 * The effective wall clock: `config.timeoutMs` unless the call passes
 * `timeout_ms`, which must be an integer in [1, 120000] (Rust `invalid_arg`).
 */
export function resolveTimeoutMs(raw: unknown, config: RunCodeConfig): number {
  if (raw === undefined || raw === null) return config.timeoutMs;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw runCodeFailure("invalid_arg", "timeout_ms must be an integer");
  }
  if (raw < 1) throw runCodeFailure("invalid_arg", `timeout_ms must be >= 1, got ${raw}`);
  if (raw > MAX_TIMEOUT_MS) {
    throw runCodeFailure("invalid_arg", `timeout_ms=${raw} exceeds the run_code maximum ${MAX_TIMEOUT_MS}ms`);
  }
  return raw;
}
