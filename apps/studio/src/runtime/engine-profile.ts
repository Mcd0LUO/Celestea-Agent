/**
 * `EngineProfile` (the HTTP-facing host view) <-> `Profile` (the runtime's
 * frozen 12-key compose config).
 *
 * The two shapes differ on purpose: the host view uses the contract names of
 * `GET /api/config` (`context_window`, no key source), while the engine profile
 * carries the key RESOLUTION (env var name + optional file) and the request
 * format. This module is the only translation point, so a new profile key can
 * never be added on one side only.
 */

import { defaultAgentConfig } from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import { CONTEXT_WINDOW, MIN_STEPS } from "../config.js";
import type { EngineProfile, ProfilePatch } from "../runtime-adapter.js";

/** The only request format the TS engine composes today (OpenAI-compatible). */
export const ENGINE_REQUEST_FORMAT: Profile["request_format"] = "chat_completions";

/** Host view of a composed profile. */
export function engineProfileOf(profile: Profile): EngineProfile {
  return {
    model: profile.model,
    base_url: profile.base_url,
    reasoning_effort: profile.reasoning_effort,
    max_steps: profile.max_steps,
    max_parallel_tool_calls: profile.max_parallel_tool_calls,
    max_output_tokens: profile.max_output_tokens,
    context_window: profile.context_window_tokens,
    api_key_env: profile.api_key_env,
    system_prompt: profile.system_prompt,
  };
}

/** Compose profile from the host view (extra keys inherit from `base`). */
export function profileFromEngine(engine: EngineProfile, base?: Partial<Profile>): Profile {
  return {
    model: engine.model,
    base_url: engine.base_url,
    api_key_env: engine.api_key_env,
    api_key_file: base?.api_key_file ?? null,
    max_steps: engine.max_steps,
    max_parallel_tool_calls: engine.max_parallel_tool_calls,
    reasoning_effort: engine.reasoning_effort,
    max_output_tokens: engine.max_output_tokens,
    context_window_tokens: engine.context_window,
    system_prompt: engine.system_prompt,
    request_format: base?.request_format ?? ENGINE_REQUEST_FORMAT,
    temperature: base?.temperature ?? null,
  };
}

/** Apply an accepted `POST /api/config` patch (the host already validated it). */
export function applyProfilePatch(profile: Profile, patch: ProfilePatch): Profile {
  const next = { ...profile };
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.reasoning_effort !== undefined) next.reasoning_effort = patch.reasoning_effort;
  if (patch.base_url !== undefined) next.base_url = patch.base_url;
  if (patch.max_steps !== undefined) next.max_steps = Math.max(MIN_STEPS, Math.trunc(patch.max_steps));
  if (patch.max_output_tokens !== undefined) {
    next.max_output_tokens = patch.max_output_tokens === null ? null : Math.trunc(patch.max_output_tokens);
  }
  if (patch.context_window !== undefined) next.context_window_tokens = Math.trunc(patch.context_window);
  if (patch.system_prompt !== undefined) next.system_prompt = patch.system_prompt;
  return next;
}

/**
 * The startup profile: the host's frozen constants (`MIN_STEPS`,
 * `CONTEXT_WINDOW`, both read off the Rust `/api/config` snapshot) plus the env
 * overrides the host honors. The loop budget derives from this profile
 * (`agentConfigFromProfile`), so the statusline window and the trim budget can
 * never disagree.
 */
export function defaultEngineProfile(env: NodeJS.ProcessEnv, apiKeyEnv: string): EngineProfile {
  const base = defaultAgentConfig();
  const maxSteps = env["CELESTEA_MAX_STEPS"];
  const contextWindow = env["CELESTEA_CONTEXT_WINDOW"];
  return {
    model: env["CELESTEA_MODEL"] ?? "unknown",
    base_url: env["CELESTEA_BASE_URL"] ?? "http://127.0.0.1:3001/v1",
    reasoning_effort: env["CELESTEA_REASONING_EFFORT"] ?? null,
    max_steps: maxSteps === undefined ? MIN_STEPS : Math.max(MIN_STEPS, Number(maxSteps) || MIN_STEPS),
    max_parallel_tool_calls: base.max_parallel_tool_calls,
    max_output_tokens: null,
    context_window: contextWindow === undefined ? CONTEXT_WINDOW : Number(contextWindow) || CONTEXT_WINDOW,
    api_key_env: apiKeyEnv,
    system_prompt: base.system_prompt,
  };
}
