/**
 * The `/api/config` response shape, assembled from live stores.
 *
 * `available.models` is rebuilt on EVERY read from the providers store
 * (`src/api.rs:61-68`): one row per (provider, model) pair — de-dup is per
 * provider since W750 — carrying the display name (`provider`), the stable id
 * (`provider_id`), whether that exact pair is the composed one (`active`) and
 * `reasoning` = the model row declares at least one effort. `system_prompt` is
 * either the host override (POST /api/config) or the registry assembly
 * (`build_gen`).
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
import { sessionWorkspaceOf, type ResolvedSession } from "../store/sessions.js";
import type { ToolInfo } from "../runtime-adapter.js";
import type { Deps, JsonObject } from "./common.js";
import { activeSession } from "./common.js";

export const EFFORTS: readonly string[] = ["low", "high", "max"];

export interface AvailableModel {
  id: string;
  name: string;
  /** Provider DISPLAY name (grouping header); `provider_id` is the stable id. */
  provider: string;
  /** W750: the provider's stable id — what a switch must send back. */
  provider_id: string;
  /** W750: this exact (provider, model) pair is the one the engine routes to. */
  active: boolean;
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

/**
 * Provider display name that lists `model`, else "" (static rows).
 *
 * W750: the same model id can live under several providers, so the provider the
 * engine actually routes to — the one whose `base_url` is the active one — wins;
 * only when no provider matches the active endpoint does the first lister win
 * (the historical reading, kept for custom endpoints).
 */
function providerOf(deps: Deps, model: string): string {
  const rows = deps.providers.rows();
  const listed = rows.filter((p) => p.models.some((m) => m.id === model));
  if (listed.length === 0) return "";
  const activeBase = trimSlash(baseUrlOf(deps));
  const exact = listed.find((p) => trimSlash(p.base_url) === activeBase);
  return (exact ?? listed[0]!).name;
}

/** Trailing-slash-insensitive compare (providers.json and the profile differ). */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The model picker's catalogue, rebuilt from the live providers store.
 *
 * W750 (bug fix): de-duplication is PER PROVIDER, never global. The same model
 * id under two providers is two different choices — the provider is what decides
 * the endpoint the request goes to — so a global `seen` set silently swallowed
 * every provider after the first one that shared an id (production: provider
 * 「基元」 vanished because it also lists `deepseek-flash`). Identical ids
 * repeated INSIDE one provider are still dropped (a store typo, not a choice).
 *
 * `active` marks the single (provider, model) pair the engine would use right
 * now: same model id AND same endpoint as the composed profile. When nothing
 * matches the endpoint — a custom base_url override, or a non
 * `chat_completions` provider whose switch never rewrites the endpoint — the
 * model id alone is enough ONLY if it is unambiguous; an ambiguous id is left
 * unmarked rather than marked wrong.
 */
export function availableModels(deps: Deps): AvailableModel[] {
  const activeModel = deps.runtime.profile().model;
  const activeBase = trimSlash(baseUrlOf(deps));
  const out: AvailableModel[] = [];
  for (const p of deps.providers.rows()) {
    const seen = new Set<string>();
    const base = trimSlash(p.base_url);
    for (const m of p.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        name: m.name === "" ? m.id : m.name,
        provider: p.name,
        provider_id: p.id,
        active: m.id === activeModel && base === activeBase,
        reasoning: m.reasoning_efforts.length > 0,
      });
    }
  }
  if (!out.some((e) => e.active)) {
    const same = out.filter((e) => e.id === activeModel);
    if (same.length === 1) same[0]!.active = true;
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
  // TS 6.0 (TS2871, new syntactic nullish check): the inner `?? null` was
  // redundant anyway — `meta?.model` is `string | undefined` and the outer `??`
  // already covers both nullish cases, so the result type and behaviour are
  // unchanged while the `?? null ?? x` pattern the new check rejects is gone.
  const model = (scoped === null ? null : meta?.model) ?? profile.model;
  const scope = scopeOf(deps, resolved);
  // W768: the prompt's workspace NAME and ROOT PATH come from the ONE projector
  // the composer also uses for the sandbox cwd (`sessionWorkspaceOf`) — a prompt
  // naming one workspace while the shell starts in another is impossible now.
  const workspace = sessionWorkspaceOf(resolved);
  const vars = toPromptVars({
    model,
    provider: providerOf(deps, model),
    base_url: baseUrlOf(deps),
    workspace: workspace?.name ?? "",
    workspace_dir: workspace?.path ?? "",
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
