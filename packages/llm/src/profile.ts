/**
 * Provider profile -> client configuration (P2a).
 *
 * Mirrors `crates/runtime/src/compose.rs` (the DeepSeekConfig assembly):
 * base_url = profile > DEEPSEEK_BASE_URL env > default; model from the profile;
 * reasoning_effort passed through verbatim; timeouts resolved from the profile
 * keys with the CELESTEA_LLM_* env vars taking precedence.
 *
 * The API key is read from the runtime configuration / environment ONLY. It is
 * never written to disk, never logged, and never echoed into an error message
 * or a serialized view (see OpenAiCompatClient.describe()).
 */

import { LlmError } from "./errors.js";
import {
  resolveTimeoutTiers,
  type EnvLike,
  type TimeoutProfile,
  type TimeoutTiers,
} from "./timeouts.js";

/** Environment variable holding the provider API key. */
export const API_KEY_ENV = "DEEPSEEK_API_KEY";
/** Environment variable overriding the provider base URL. */
export const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-chat";

/** The runtime profile subset this package consumes. */
export interface LlmProfile extends TimeoutProfile {
  model?: string | null;
  base_url?: string | null;
  /** Free-form tier string, injected into the request body verbatim. */
  reasoning_effort?: string | null;
  max_output_tokens?: number | null;
  /** Name of the env var holding the API key (default DEEPSEEK_API_KEY). */
  api_key_env?: string | null;
}

/** Fully resolved client configuration (carries the key; never logged). */
export interface ResolvedClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Free-form tier string, passed through verbatim (never folded/renamed). */
  reasoningEffort: string | null;
  maxOutputTokens: number | null;
  /** 0 = that stage is disabled (same convention as the profile/env keys). */
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

/** The tiers as configured (null = disabled), derived from resolved ms values. */
export function tiersFromConfig(config: ResolvedClientConfig): TimeoutTiers {
  return {
    connectMs: config.connectTimeoutMs === 0 ? null : config.connectTimeoutMs,
    responseMs: config.responseTimeoutMs === 0 ? null : config.responseTimeoutMs,
    idleMs: config.streamIdleTimeoutMs === 0 ? null : config.streamIdleTimeoutMs,
  };
}

function nonEmpty(v: string | null | undefined): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Resolve the API key from the environment ONLY (`api_key_env` names the var).
 * Returns null when unset/blank. This package never reads key files: that is
 * the runtime's job (`resolve_api_key` in crates/runtime).
 */
export function resolveApiKey(profile?: LlmProfile | null, env: EnvLike = process.env): string | null {
  const name = nonEmpty(profile?.api_key_env) ?? API_KEY_ENV;
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Compose the effective client config from a runtime profile + environment. */
export function resolveClientConfig(
  profile?: LlmProfile | null,
  env: EnvLike = process.env,
): ResolvedClientConfig {
  const tiers = resolveTimeoutTiers(profile, env);
  const maxOut = profile?.max_output_tokens;
  return {
    baseUrl: nonEmpty(profile?.base_url) ?? nonEmpty(env[BASE_URL_ENV]) ?? DEFAULT_BASE_URL,
    apiKey: resolveApiKey(profile, env) ?? "",
    model: nonEmpty(profile?.model) ?? DEFAULT_MODEL,
    reasoningEffort:
      typeof profile?.reasoning_effort === "string" ? profile.reasoning_effort : null,
    maxOutputTokens:
      typeof maxOut === "number" && Number.isInteger(maxOut) && maxOut >= 0 ? maxOut : null,
    connectTimeoutMs: tiers.connectMs ?? 0,
    responseTimeoutMs: tiers.responseMs ?? 0,
    streamIdleTimeoutMs: tiers.idleMs ?? 0,
  };
}

/**
 * reasoning_effort is a FREE STRING: user-defined tiers ("max",
 * "xhigh-custom", provider-specific labels) reach the upstream exactly as
 * written. Only null/undefined means "not configured" — no trimming, no
 * folding onto an enum, no renaming.
 */
export function normalizeReasoningEffort(v: string | null | undefined): string | null {
  return v === null || v === undefined ? null : v;
}

/**
 * Model names are free-form: the OpenAI-compatible endpoint decides its own
 * catalog (a local shim may expose deepseek-v4-flash), so the only hard rule is
 * that a model must be supplied.
 */
export function validateModel(model: string): void {
  if (model.trim() === "") {
    throw new LlmError("model must not be empty", "generate");
  }
}
