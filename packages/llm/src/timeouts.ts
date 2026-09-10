/**
 * The three LLM timeout tiers (P2a).
 *
 * Mirrors `crates/llm/src/config.rs` +
 * `crates/runtime/src/config.rs::resolve_llm_timeout_ms`:
 *
 *   * connect timeout      — TCP/TLS handshake only (15s default);
 *   * response-header time — send() -> response headers (60s default);
 *   * stream idle time     — gap between any two SSE data chunks (90s default).
 *
 * There is deliberately NO total-request timeout: a long generation streams
 * tokens continuously and must never be killed by a response-idle guard.
 *
 * Precedence per tier: CELESTEA_LLM_* env var > profile key > built-in default;
 * 0 disables that stage; blank/unparseable env values are ignored (lenient).
 */

export type EnvLike = Record<string, string | undefined>;

/** Env overrides for the three timeout tiers (milliseconds). */
export const CONNECT_TIMEOUT_ENV = "CELESTEA_LLM_CONNECT_TIMEOUT_MS";
export const RESPONSE_TIMEOUT_ENV = "CELESTEA_LLM_RESPONSE_TIMEOUT_MS";
export const STREAM_IDLE_TIMEOUT_ENV = "CELESTEA_LLM_STREAM_IDLE_TIMEOUT_MS";

/** Default TCP/TLS connect timeout (connects are fast when healthy). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Default send() -> response-headers timeout. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;
/** Default SSE inter-chunk idle timeout. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

/** Profile JSON keys for the three tiers. */
export const PROFILE_TIMEOUT_KEYS = {
  connect: "llm_connect_timeout_ms",
  response: "llm_response_timeout_ms",
  idle: "llm_stream_idle_timeout_ms",
} as const;

/** The three timeout tiers as configured in a runtime profile (all optional). */
export interface TimeoutProfile {
  llm_connect_timeout_ms?: number | null;
  llm_response_timeout_ms?: number | null;
  llm_stream_idle_timeout_ms?: number | null;
}

/** Effective timeouts; null means "this stage is disabled" (configured 0). */
export interface TimeoutTiers {
  connectMs: number | null;
  responseMs: number | null;
  idleMs: number | null;
}

/** Built-in defaults (nothing configured). */
export const DEFAULT_TIMEOUTS: TimeoutTiers = {
  connectMs: DEFAULT_CONNECT_TIMEOUT_MS,
  responseMs: DEFAULT_RESPONSE_TIMEOUT_MS,
  idleMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
};

/** Milliseconds -> tier value; 0 disables (null); absent/invalid -> fallback. */
export function msToDuration(
  ms: number | null | undefined,
  fallbackMs: number | null,
): number | null {
  if (ms === null || ms === undefined) return fallbackMs;
  if (!Number.isFinite(ms) || ms < 0) return fallbackMs;
  return ms === 0 ? null : Math.floor(ms);
}

/** Parse an env value as a non-negative integer of milliseconds. */
function parseEnvMs(envValue: string | undefined): number | undefined {
  if (envValue === undefined) return undefined;
  const trimmed = envValue.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Is this a usable profile/env value (non-negative integer of ms)? */
export function isTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Resolve one tier: env (set, trimmed, parseable) > profile value > default.
 */
export function resolveTimeoutMs(
  profileValue: number | null | undefined,
  envValue: string | undefined,
  defaultMs: number,
): number {
  const fromEnv = parseEnvMs(envValue);
  if (fromEnv !== undefined) return fromEnv;
  if (isTimeoutMs(profileValue)) return profileValue;
  return defaultMs;
}

/** Resolve all three tiers (profile keys + CELESTEA_LLM_* env overrides). */
export function resolveTimeoutTiers(
  profile?: TimeoutProfile | null,
  env: EnvLike = process.env,
): TimeoutTiers {
  return {
    connectMs: resolveTimeoutMs(
      profile?.llm_connect_timeout_ms,
      env[CONNECT_TIMEOUT_ENV],
      DEFAULT_CONNECT_TIMEOUT_MS,
    ),
    responseMs: resolveTimeoutMs(
      profile?.llm_response_timeout_ms,
      env[RESPONSE_TIMEOUT_ENV],
      DEFAULT_RESPONSE_TIMEOUT_MS,
    ),
    idleMs: resolveTimeoutMs(
      profile?.llm_stream_idle_timeout_ms,
      env[STREAM_IDLE_TIMEOUT_ENV],
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ),
  };
}

/**
 * Lenient profile reader: non-negative integers pass through, everything else
 * is reported (never fatal) — mirrors the strict parse in
 * `crates/runtime/src/config.rs`.
 */
export function readTimeoutProfile(raw: unknown): { profile: TimeoutProfile; errors: string[] } {
  const profile: TimeoutProfile = {};
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { profile, errors };
  }
  const obj = raw as Record<string, unknown>;
  const fields: Array<[keyof TimeoutProfile, string]> = [
    ["llm_connect_timeout_ms", PROFILE_TIMEOUT_KEYS.connect],
    ["llm_response_timeout_ms", PROFILE_TIMEOUT_KEYS.response],
    ["llm_stream_idle_timeout_ms", PROFILE_TIMEOUT_KEYS.idle],
  ];
  for (const [field, key] of fields) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (isTimeoutMs(value)) profile[field] = value;
    else errors.push(`profile field '${key}' must be a non-negative integer (ms), got ${jsonKind(value)}`);
  }
  return { profile, errors };
}

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
