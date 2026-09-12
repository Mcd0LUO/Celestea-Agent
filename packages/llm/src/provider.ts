/**
 * Provider registration (P2a).
 *
 * Mirrors `crates/llm/src/registry.rs` (+ `DeepSeekLlm::from_env`): the
 * DeepSeek adapter is registered under the canonical name "deepseek", and the
 * from-env path requires a non-empty API key.
 *
 * A1 (W746): the registry is CORE's `LlmRegistry` (the `llm.rs` port) — the
 * local `Map`-based copy is deleted, so registration/resolution semantics are
 * the seam's, not a second implementation's.
 */

import { LlmRegistry } from "@celestea/core";

import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import { resolveApiKey, type LlmProfile } from "./profile.js";
import { resolveClientConfig } from "./profile.js";
import type { Llm } from "./seam.js";
import type { EnvLike } from "./timeouts.js";

/** Canonical provider name (mirrors `deepseek_registry`). */
export const DEEPSEEK_PROVIDER_NAME = "deepseek";

export { LlmRegistry };

/**
 * Build the DeepSeek provider from a runtime profile + environment. The API key
 * is read from the environment only; a missing key is an error, never a silent
 * unauthenticated request.
 */
export function createDeepSeekLlm(
  profile?: LlmProfile | null,
  env: EnvLike = process.env,
): OpenAiCompatClient {
  if (resolveApiKey(profile, env) === null) {
    const name = profile?.api_key_env ?? "DEEPSEEK_API_KEY";
    throw new LlmError(`${name} is not set`, "generate");
  }
  return OpenAiCompatClient.fromConfig(resolveClientConfig(profile, env));
}

/** A registry holding `llm` under the canonical "deepseek" name. */
export function createDeepSeekRegistry(llm: Llm): LlmRegistry<Llm> {
  const registry = new LlmRegistry<Llm>();
  registry.register(DEEPSEEK_PROVIDER_NAME, llm);
  return registry;
}
