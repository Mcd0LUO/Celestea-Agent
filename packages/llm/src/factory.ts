/**
 * Production provider factory (W511).
 *
 * The one place a resolved runtime profile becomes a NETWORK-backed `Llm`:
 *
 *   base_url          profile.base_url > CELESTEA_BASE_URL > DEEPSEEK_BASE_URL
 *                     > https://api.deepseek.com
 *   api key           env[profile.api_key_env] ONLY (default DEEPSEEK_API_KEY):
 *                     never a file, never written back, never echoed
 *   reasoning_effort  profile value, verbatim (free string, never folded)
 *   max_output_tokens profile value
 *   timeouts          CELESTEA_LLM_{CONNECT,RESPONSE,STREAM_IDLE}_TIMEOUT_MS
 *                     > profile key > built-in default (0 disables a stage)
 *
 * `context_window_tokens` is not a request field (the engine trims with it); it
 * is surfaced in `liveLlmView()` so a startup log can report the live window
 * next to the model.
 *
 * `CELESTEA_LLM_MODE` picks live vs offline. This package is network-only, so it
 * only REPORTS the mode (the deterministic offline seam is host-side, an
 * injected test seam in apps/studio).
 */

import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import { resolveClientConfig, type LlmProfile } from "./profile.js";
import { resolveTimeoutTiers, type EnvLike, type TimeoutTiers } from "./timeouts.js";

/** `live` = the real provider; `offline` = the host's deterministic seam. */
export const LLM_MODE_ENV = "CELESTEA_LLM_MODE";
/** Base-URL fallback used by the host (wins over DEEPSEEK_BASE_URL). */
export const LLM_BASE_URL_ENV = "CELESTEA_BASE_URL";

export type LlmMode = "live" | "offline";

/** The profile subset the live factory consumes. */
export interface LiveLlmProfile extends LlmProfile {
  context_window_tokens?: number | null;
}

/** Secret-free view of a live adapter (safe to log / serialize). */
export interface LiveLlmView {
  mode: LlmMode;
  model: string;
  baseUrl: string;
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  contextWindow: number | null;
  timeouts: TimeoutTiers;
  hasApiKey: boolean;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Read the mode. Absent/blank or "live" = live (the deployment default); only
 * an explicit "offline" turns the network off. Anything else is a config typo
 * and fails fast instead of silently reaching (or not reaching) a provider.
 */
export function resolveLlmMode(env: EnvLike = process.env): LlmMode {
  const raw = (env[LLM_MODE_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "live") return "live";
  if (raw === "offline") return "offline";
  throw new LlmError(`${LLM_MODE_ENV} must be 'live' or 'offline', got '${raw}'`, "generate");
}

/** Fill `base_url` from CELESTEA_BASE_URL when the profile leaves it empty. */
export function withBaseUrlFallback(profile?: LiveLlmProfile | null, env: EnvLike = process.env): LiveLlmProfile {
  const base = profile ?? {};
  if (nonEmpty(base.base_url) !== undefined) return base;
  const fromEnv = nonEmpty(env[LLM_BASE_URL_ENV]);
  return fromEnv === undefined ? base : { ...base, base_url: fromEnv };
}

/** Build the live OpenAI-compatible client behind the `Llm` seam. */
export function createLiveLlm(profile?: LiveLlmProfile | null, env: EnvLike = process.env): OpenAiCompatClient {
  return OpenAiCompatClient.fromProfile(withBaseUrlFallback(profile, env), env);
}

/** Secret-free view of the live configuration (never carries the key). */
export function liveLlmView(
  profile?: LiveLlmProfile | null,
  env: EnvLike = process.env,
  mode: LlmMode = resolveLlmMode(env),
): LiveLlmView {
  const effective = withBaseUrlFallback(profile, env);
  const config = resolveClientConfig(effective, env);
  const window = effective.context_window_tokens;
  return {
    mode,
    model: config.model,
    baseUrl: config.baseUrl,
    reasoningEffort: config.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    contextWindow: typeof window === "number" && window > 0 ? window : null,
    timeouts: resolveTimeoutTiers(effective, env),
    hasApiKey: config.apiKey !== "",
  };
}
