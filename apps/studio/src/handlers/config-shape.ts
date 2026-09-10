/**
 * The `/api/config` response shape, assembled from live stores.
 *
 * `available.models` is rebuilt on EVERY read from the providers store
 * (`src/api.rs:61-68`): a provider-backed row (`provider: "<display name>"`)
 * wins over the id-dedup fallback, and `reasoning` is true when the model row
 * declares at least one reasoning effort. `system_prompt` is either the host
 * override (POST /api/config) or the registry assembly (`build_gen`).
 */

import type { PromptScope } from "../store/prompts.js";
import { assembleSystemPrompt, resolveActivePrompt, toPromptVars } from "../store/prompts-compose.js";
import { readSessionMeta } from "../store/session-meta.js";
import type { ResolvedSession } from "../store/sessions.js";
import type { Deps, JsonObject } from "./common.js";
import { activeSession } from "./common.js";

export const EFFORTS: readonly string[] = ["low", "high", "max"];

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

/** Resolve the active session's directory (null when nothing is active). */
export function activeResolved(deps: Deps): ResolvedSession | null {
  const id = activeSession(deps);
  if (id === null) return null;
  const res = deps.sessions.resolve(id);
  return res.ok ? res.value : null;
}

/** Prompt scope of the active session's workspace (global when unknown). */
export function activeScope(deps: Deps): PromptScope {
  const resolved = activeResolved(deps);
  if (resolved === null) return deps.prompts.scopeGlobal();
  return deps.prompts.scopeWorkspace(resolved.workspace, resolved.wsPath);
}

/** `prompt` binding of the active session, if it has one. */
export function activePromptBinding(deps: Deps): string | null {
  const resolved = activeResolved(deps);
  if (resolved === null) return null;
  return readSessionMeta(resolved.dir)?.prompt ?? null;
}

/** Provider display name that lists `model`, else "" (static rows). */
function providerOf(deps: Deps, model: string): string {
  for (const p of deps.providers.rows()) {
    if (p.models.some((m) => m.id === model)) return p.name;
  }
  return "";
}

export function availableModels(deps: Deps): AvailableModel[] {
  const out: AvailableModel[] = [];
  const seen = new Set<string>();
  for (const p of deps.providers.rows()) {
    for (const m of p.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ id: m.id, name: m.name === "" ? m.id : m.name, provider: p.name, reasoning: m.reasoning_efforts.length > 0 });
    }
  }
  return out;
}

/** Registry-assembled (or overridden) system prompt. */
export function assembleSystemPromptFor(deps: Deps): string {
  const override = deps.settings.systemPromptOverride();
  if (override !== null) return override;
  const profile = deps.runtime.profile();
  const scope = activeScope(deps);
  const resolved = activeResolved(deps);
  const vars = toPromptVars({
    model: profile.model,
    provider: providerOf(deps, profile.model),
    base_url: baseUrlOf(deps),
    workspace: resolved?.workspace ?? "",
    session: resolved?.id ?? "",
    tools: deps.runtime.tools().map((t) => t.name).join(", "),
    context_window: profile.context_window,
    max_output_tokens: profile.max_output_tokens,
    date: new Date().toISOString().slice(0, 10),
  });
  return assembleSystemPrompt(deps.prompts, scope, resolveActivePrompt(deps.prompts, scope, activePromptBinding(deps)), vars);
}

/** Effective base_url: host override wins over the engine profile. */
export function baseUrlOf(deps: Deps): string {
  return deps.settings.baseUrlOverride() ?? deps.runtime.profile().base_url;
}

/** GET /api/config body (also the POST /api/config response). */
export function configView(deps: Deps): JsonObject {
  const profile = deps.runtime.profile();
  return {
    model: profile.model,
    base_url: baseUrlOf(deps),
    max_steps: profile.max_steps,
    max_parallel_tool_calls: profile.max_parallel_tool_calls,
    reasoning_effort: profile.reasoning_effort,
    max_output_tokens: profile.max_output_tokens,
    context_window: profile.context_window,
    system_prompt: assembleSystemPromptFor(deps),
    api_key_env: deps.config.apiKeyEnv,
    available: { models: availableModels(deps), efforts: [...EFFORTS] },
  };
}
