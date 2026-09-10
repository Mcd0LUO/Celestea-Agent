/**
 * Engine LLM assembly (W511): profile -> `Llm`, live by default.
 *
 * Two seams, one switch:
 *   - LIVE     `@celestea/llm`'s OpenAI-compatible client, assembled from the
 *              engine profile (model / base_url / reasoning_effort /
 *              max_output_tokens) + the environment (api key, the three
 *              CELESTEA_LLM_* timeouts);
 *   - OFFLINE  the deterministic in-process seam (`createOfflineLlm`), still
 *              available for tests and replay via `CELESTEA_LLM_MODE=offline`
 *              or an injected `llm` factory on the adapter.
 *
 * `@celestea/llm` speaks its own (parity) seam types; core owns the seam the
 * engine consumes. `liveEngineLlm` is the ONE adapter between them: requests
 * pass through unchanged (identical shapes), stream events are copied field by
 * field, and a provider stream-idle failure (`kindOf: "timeout"`) is reported
 * as core's `"stream"` terminal — the message keeps the `llm timeout:` prefix,
 * so the distinction survives in the transcript.
 */

import {
  createLiveLlm,
  liveLlmView,
  resolveLlmMode,
  type LiveLlmView,
  type LlmMode,
} from "@celestea/llm";
import type {
  Llm,
  LlmStream,
  ModelRequest,
  StreamEvent,
} from "@celestea/core";
import type { Profile } from "@celestea/runtime";
import type { EngineProfile } from "../runtime-adapter.js";
import { defaultEngineProfile } from "./engine-profile.js";
import { createOfflineLlm } from "./offline-llm.js";
import {
  applyProviderTarget,
  resolveProviderTarget,
  type ProviderLookup,
  type ProviderTarget,
} from "./provider-target.js";
import type { LlmStream as ProviderStream, StreamEvent as ProviderEvent } from "@celestea/llm";

/**
 * The profile fields a live client needs, from either profile shape (`Profile`
 * carries `context_window_tokens`, the host view `context_window`).
 */
export function llmProfileOf(profile: Profile | EngineProfile): {
  model: string;
  base_url: string;
  api_key_env: string;
  reasoning_effort: string | null;
  max_output_tokens: number | null;
  context_window_tokens: number;
} {
  return {
    model: profile.model,
    base_url: profile.base_url,
    api_key_env: profile.api_key_env,
    reasoning_effort: profile.reasoning_effort,
    max_output_tokens: profile.max_output_tokens,
    context_window_tokens:
      "context_window_tokens" in profile ? profile.context_window_tokens : profile.context_window,
  };
}

/** One provider stream event -> the core event the engine consumes. */
function coreEvent(event: ProviderEvent): StreamEvent {
  switch (event.kind) {
    case "text":
      return { kind: "text", text: event.text };
    case "thinking":
      return { kind: "thinking", text: event.text };
    case "usage":
      return { kind: "usage", usage: event.usage };
    case "done":
      return { kind: "done", message: event.message };
    case "interrupted":
      return { kind: "interrupted" };
    case "failed":
      return {
        kind: "failed",
        // core's union has no "timeout" member: an SSE idle guard is a broken
        // stream there, and the "llm timeout:" prefix keeps the detail.
        kindOf: event.kindOf === "generate" ? "generate" : "stream",
        message: event.message,
      };
  }
}

/** Re-yield a provider stream as a core stream. */
async function* coreStream(stream: ProviderStream): LlmStream {
  for await (const event of stream) yield coreEvent(event);
}

/** The live provider behind the core `Llm` seam. */
export function liveEngineLlm(profile: Profile, env: NodeJS.ProcessEnv): Llm {
  const client = createLiveLlm(llmProfileOf(profile), env);
  return {
    async generate(req: ModelRequest): Promise<LlmStream> {
      return coreStream(await client.generate(req));
    },
  };
}

/** The engine's `Llm` for this generation: live, or the offline test seam. */
export function createEngineLlm(
  profile: Profile,
  env: NodeJS.ProcessEnv,
  mode: LlmMode = resolveLlmMode(env),
): Llm {
  return mode === "offline" ? createOfflineLlm() : liveEngineLlm(profile, env);
}

/** Secret-free description of the live adapter (startup logging / diagnostics). */
export function engineLlmView(
  profile: Profile | EngineProfile,
  env: NodeJS.ProcessEnv,
  mode?: LlmMode,
): LiveLlmView {
  return liveLlmView(llmProfileOf(profile), env, mode);
}

/**
 * The startup profile: the host constants + env overrides ([defaultEngineProfile])
 * with providers.json applied on top (model, base_url, and the api key into the
 * process env — in memory only).
 */
export function startupEngineProfile(
  lookup: ProviderLookup,
  env: NodeJS.ProcessEnv,
  apiKeyEnv: string,
): { profile: EngineProfile; target: ProviderTarget } {
  const base = defaultEngineProfile(env, apiKeyEnv);
  const target = resolveProviderTarget(lookup, env, base);
  return applyProviderTarget(base, target, lookup, env);
}
