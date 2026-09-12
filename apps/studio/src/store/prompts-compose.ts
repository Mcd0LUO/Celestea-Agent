/**
 * `build_gen` — assembling the system prompt from the section registry
 * (`src/prompts.rs:108-130,472-500`).
 *
 * The composed prompt is a DERIVED value: sections are rendered in `(order, id)`
 * order, empty/whitespace templates are dropped, the survivors are joined with
 * a blank line, and the result is truncated to `PROMPT_MAX_LEN` bytes on a char
 * boundary. A `USER_OVERRIDE` (POST /api/config `system_prompt`) bypasses this
 * assembly entirely — it is never a section.
 */

import { DEFAULT_SESSION_MODE, type SessionMode } from "./mode.js";
import type { PromptScope, PromptsStore } from "./prompts.js";
import { renderTemplate, truncateToCap, type PromptVars } from "./prompts-template.js";

export interface PromptVarInput {
  model: string;
  provider: string;
  base_url: string;
  /** W768: the workspace NAME (`CelesteaTeamAPI`). */
  workspace: string;
  /** W768: the workspace ROOT PATH — the same value the tools run in. */
  workspace_dir: string;
  session: string;
  tools: string;
  context_window: number;
  max_output_tokens: number | null;
  date: string;
}

/** Interpolation values; every whitelisted variable gets a string. */
export function toPromptVars(input: PromptVarInput): PromptVars {
  return {
    model: input.model,
    provider: input.provider,
    base_url: input.base_url,
    workspace: input.workspace,
    workspace_dir: input.workspace_dir,
    session: input.session,
    tools: input.tools,
    context_window: String(input.context_window),
    max_output_tokens: input.max_output_tokens === null ? "" : String(input.max_output_tokens),
    date: input.date,
  };
}

/**
 * Assemble the registry-resolved system prompt for one scope.
 *
 * W729: `mode` selects the `tool_access` VARIANT (K6 — the registry stays 10
 * rows); everything else is mode-independent, and a scope/bound override of
 * `tool_access` still replaces the variant (R4). The default keeps every
 * existing caller on the `standard` text.
 */
export function assembleSystemPrompt(
  store: PromptsStore,
  scope: PromptScope,
  boundId: string | null,
  vars: PromptVars,
  mode: SessionMode = DEFAULT_SESSION_MODE,
): string {
  const parts: string[] = [];
  for (const row of store.sections(scope, boundId, mode)) {
    const rendered = renderTemplate(row.template, vars).trim();
    if (rendered === "") continue;
    parts.push(rendered);
  }
  return truncateToCap(parts.join("\n\n"));
}

/**
 * `active_prompt` resolution chain: the active session's bound prompt id wins;
 * a bound id that no longer exists resolves to null (there is NO fallback for a
 * bound-but-missing prompt); otherwise scope default -> global default.
 */
export function resolveActivePrompt(store: PromptsStore, scope: PromptScope, sessionPromptId: string | null): string | null {
  if (sessionPromptId !== null && sessionPromptId !== "") {
    return store.find(scope, sessionPromptId) === undefined ? null : sessionPromptId;
  }
  return store.defaultFor(scope)?.id ?? null;
}
