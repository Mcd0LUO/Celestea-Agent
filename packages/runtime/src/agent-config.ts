/**
 * Profile -> `AgentConfig` projection (Rust `runtime/src/compose.rs:196-204`).
 *
 * The step cap is floored at [MIN_STEPS]: the engine loop runs
 * `for step in 0..max_steps`, so `max_steps = 0` means ZERO steps (not
 * unlimited). A profile that leaves the cap unset therefore gets a high cap
 * instead of an engine that cannot take a single step (studio W218).
 */

import { defaultAgentConfig, type AgentConfig } from "@celestea/core";
import type { Profile } from "./profile.js";

/** Step-cap floor: covers realistic long turns while still bounding runaway loops. */
export const MIN_STEPS = 4096;
/** Trim factor of the window that triggers old-message trimming. */
export const CONTEXT_TRIM_THRESHOLD = 0.8;
/** How many most-recent messages survive a trim (plus the system message). */
export const CONTEXT_KEEP_RECENT = 10;

/** Derive the loop configuration from a profile (identity prompt included). */
export function agentConfigFromProfile(profile: Profile, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base = defaultAgentConfig();
  const steps = profile.max_steps > 0 ? profile.max_steps : MIN_STEPS;
  return {
    ...base,
    model: profile.model,
    system_prompt: profile.system_prompt,
    max_steps: steps,
    max_parallel_tool_calls: profile.max_parallel_tool_calls,
    context_window_tokens: profile.context_window_tokens,
    context_trim_threshold: CONTEXT_TRIM_THRESHOLD,
    context_keep_recent: CONTEXT_KEEP_RECENT,
    ...overrides,
  };
}
