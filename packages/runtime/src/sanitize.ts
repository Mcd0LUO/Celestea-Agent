/**
 * Generation-level config sanitization.
 *
 * `GET/POST /api/config` hands the current generation's configuration to the
 * client, so the projection is a whitelist: only the twelve frozen profile keys
 * (minus the two key-bearing ones, which become existence flags) plus the
 * derived loop budget. The result is then run through core's redactor before it
 * is ever serialized, so a credential that sneaks into `base_url` cannot leave
 * the process (ARCHITECTURE.md §6.3).
 */

import { createRedactor, stableStringify } from "@celestea/core";
import type { Profile } from "./profile.js";

/** Client-facing projection of a [Profile]: no secret value, ever. */
export interface SanitizedConfig {
  model: string;
  base_url: string;
  request_format: Profile["request_format"];
  reasoning_effort: string | null;
  max_steps: number;
  max_parallel_tool_calls: number;
  max_output_tokens: number | null;
  context_window_tokens: number;
  temperature: number | null;
  system_prompt: string;
  /** Env var NAME the key is read from — a name is not a secret. */
  api_key_env: string;
  has_api_key_file: boolean;
}

/** Whitelist projection of a profile (`api_key_file` becomes a boolean). */
export function sanitizeProfile(profile: Profile): SanitizedConfig {
  return {
    model: profile.model,
    base_url: profile.base_url,
    request_format: profile.request_format,
    reasoning_effort: profile.reasoning_effort,
    max_steps: profile.max_steps,
    max_parallel_tool_calls: profile.max_parallel_tool_calls,
    max_output_tokens: profile.max_output_tokens,
    context_window_tokens: profile.context_window_tokens,
    temperature: profile.temperature,
    system_prompt: profile.system_prompt,
    api_key_env: profile.api_key_env,
    has_api_key_file: profile.api_key_file !== null,
  };
}

/**
 * The sanitized config as stable, redaction-clean JSON text. Redaction runs on
 * every serialization (not once at compose), so the export can never carry a
 * secret even if a future profile key smuggles one in.
 */
export function sanitizeConfigJson(config: SanitizedConfig): string {
  return createRedactor([]).redact(stableStringify(config));
}
