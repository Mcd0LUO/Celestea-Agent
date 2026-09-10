/**
 * Provider registration (P2a).
 *
 * Mirrors `crates/llm/src/registry.rs` (+ `DeepSeekLlm::from_env`): the
 * DeepSeek adapter is registered under the canonical name "deepseek", and the
 * from-env path requires a non-empty API key.
 *
 * TODO(core-seam): `LlmRegistry` lives in core in Rust; once `@celestea/core`
 * exports the seam this local registry is replaced by the core one (README
 * §"core seam adapter").
 */

import { OpenAiCompatClient } from "./client.js";
import { LlmError } from "./errors.js";
import { resolveApiKey, type LlmProfile } from "./profile.js";
import { resolveClientConfig } from "./profile.js";
import type { Llm } from "./seam.js";
import type { EnvLike } from "./timeouts.js";

/** Canonical provider name (mirrors `deepseek_registry`). */
export const DEEPSEEK_PROVIDER_NAME = "deepseek";

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

/** Name -> adapter registry (a later registration of a name shadows earlier). */
export class LlmRegistry {
  readonly #adapters = new Map<string, Llm>();

  register(name: string, llm: Llm): void {
    this.#adapters.set(name, llm);
  }

  resolve(name: string): Llm | undefined {
    return this.#adapters.get(name);
  }

  list(): string[] {
    return [...this.#adapters.keys()];
  }
}

/** A registry holding `llm` under the canonical "deepseek" name. */
export function createDeepSeekRegistry(llm: Llm): LlmRegistry {
  const registry = new LlmRegistry();
  registry.register(DEEPSEEK_PROVIDER_NAME, llm);
  return registry;
}
