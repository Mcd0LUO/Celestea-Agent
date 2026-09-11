/**
 * The `/api/config` response shape, assembled from live stores.
 *
 * `available.models` is rebuilt on EVERY read from the providers store
 * (`src/api.rs:61-68`): a provider-backed row (`provider: "<display name>"`)
 * wins over the id-dedup fallback, and `reasoning` is true when the model row
 * declares at least one reasoning effort. `system_prompt` is either the host
 * override (POST /api/config) or the registry assembly (`build_gen`).
 *
 * S1 (W729): `system_prompt` is the FOCUSED (active) session's assembly. The
 * engine's own per-session prompt comes from the same function with an explicit
 * session id, injected into the composer by `app.ts` — one assembly path, two
 * callers, so the UI and the engine can never disagree about a session's mode.
 */

import { DEFAULT_SESSION_MODE, type SessionMode } from "../store/mode.js";
import type { PromptScope } from "../store/prompts.js";
import { assembleSystemPrompt, resolveActivePrompt, toPromptVars } from "../store/prompts-compose.js";
import { readSessionMeta } from "../store/session-meta.js";
import type { ResolvedSession } from "../store/sessions.js";
import type { ToolInfo } from "../runtime-adapter.js";
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
  return scopeOf(deps, activeResolved(deps));
}

/** Prompt scope of one session (global when the session cannot be resolved). */
export function scopeOf(deps: Deps, resolved: ResolvedSession | null): PromptScope {
  if (resolved === null) return deps.prompts.scopeGlobal();
  return deps.prompts.scopeWorkspace(resolved.workspace, resolved.wsPath);
}

/** The session's directory, or null when the id does not resolve here. */
export function resolveIfKnown(deps: Deps, sessionId: string | null): ResolvedSession | null {
  if (sessionId === null || sessionId === "") return null;
  const res = deps.sessions.resolve(sessionId);
  return res.ok ? res.value : null;
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

/**
 * Registry-assembled (or overridden) system prompt.
 *
 * W729 (§5.1 #4/#5, S1/S2): with an explicit `sessionId` the WHOLE assembly is
 * resolved against THAT session — its workspace scope, its bound prompt, its
 * `session.json` model, its own tool face and its own mode. That is what makes
 * "one mode per session" true for a BACKGROUND session and not only for the focused one
 * (R3); `null` keeps the historical reading (the ACTIVE session's scope, the
 * process model, the default generation's tools), which is what the startup
 * priming and `GET /api/config` use.
 */
export function assembleSystemPromptFor(deps: Deps, sessionId: string | null = null, mode?: SessionMode): string {
  const override = deps.settings.systemPromptOverride();
  if (override !== null) return override;
  const profile = deps.runtime.profile();
  const scoped = sessionId === null ? null : resolveIfKnown(deps, sessionId);
  const resolved = sessionId === null ? activeResolved(deps) : scoped;
  const meta = resolved === null ? null : readSessionMeta(resolved.dir);
  // The session's own model wins for a scoped assembly; the process model stays
  // the source for the legacy (null) reading, so a no-mode session's prompt is
  // byte-for-byte what it was before W729 (K8).
  const model = (scoped === null ? null : meta?.model ?? null) ?? profile.model;
  const scope = scopeOf(deps, resolved);
  const vars = toPromptVars({
    model,
    provider: providerOf(deps, model),
    base_url: baseUrlOf(deps),
    workspace: resolved?.workspace ?? "",
    session: resolved?.id ?? "",
    tools: toolsOf(deps, sessionId).map((t) => t.name).join(", "),
    context_window: profile.context_window,
    max_output_tokens: profile.max_output_tokens,
    date: new Date().toISOString().slice(0, 10),
  });
  const binding = scoped === null ? activePromptBinding(deps) : (meta?.prompt ?? null);
  // `mode` (explicit) wins over the session's own: the BASE generation is primed
  // with the DEFAULT mode on purpose, so one execution session can never leak
  // its variant into the prompt every session without a mode inherits (R3).
  return assembleSystemPrompt(deps.prompts, scope, resolveActivePrompt(deps.prompts, scope, binding), vars, mode ?? meta?.mode ?? DEFAULT_SESSION_MODE);
}

/**
 * The tool face the `{{tools}}` variable renders: the session's own generation
 * when it has one, else the default generation (identical in P0 — §1.2 — and
 * the seam `GET /api/tools?session=` will read in P1).
 */
function toolsOf(deps: Deps, sessionId: string | null): ToolInfo[] {
  const sessionTools = deps.runtime.sessionTools;
  if (sessionId === null || sessionTools === undefined) return deps.runtime.tools();
  return sessionTools.call(deps.runtime, sessionId);
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
