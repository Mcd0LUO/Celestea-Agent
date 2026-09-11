/**
 * `GET /api/sessions/{id}/context` response shaping (W725).
 *
 * The only transformation applied here is the wire-size guard the contract
 * freezes: a single entry longer than [MAX_ENTRY_CHARS] is cut and MARKED, and
 * the top-level `truncated` reports whether anything was cut — a silently
 * shortened prompt would make the viewer lie about what the model saw.
 *
 * `context` reuses the statusline's existing口径 (`context_usage`): the REAL
 * prompt-token count once a usage frame has been seen (`estimated:false`), else
 * the session log's character estimate (`estimated:true`). There is no second
 * accounting path for this endpoint.
 */

import type { ContextMessageView, SessionContextView } from "../runtime-adapter.js";

/** Per-entry character cap (contract): one entry never travels longer. */
export const MAX_ENTRY_CHARS = 20_000;

/** The four fields of the statusline's `context_usage` this endpoint reports. */
export interface ContextUsage {
  used: number;
  window: number;
  ratio: number;
  estimated: boolean;
}

export interface ContextPayloadInput {
  session: string;
  view: SessionContextView;
  usage: ContextUsage;
}

interface Cut {
  text: string;
  truncated: boolean;
}

/** Cut one entry to the cap; `truncated` says whether anything was dropped. */
function cut(text: string): Cut {
  if (text.length <= MAX_ENTRY_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_ENTRY_CHARS), truncated: true };
}

function messageJson(message: ContextMessageView): Record<string, unknown> {
  const body = cut(message.content);
  return {
    role: message.role,
    content: body.text,
    ...(message.tool_name === undefined ? {} : { tool_name: message.tool_name }),
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(body.truncated ? { truncated: true } : {}),
  };
}

/**
 * The frozen 200 body. `counts` describes the payload as SENT (post-cut), so a
 * client can reconcile every number with what it received.
 */
export function contextPayload(input: ContextPayloadInput): Record<string, unknown> {
  const system = cut(input.view.system);
  const messages = input.view.messages.map(messageJson);
  return {
    ok: true,
    session: input.session,
    model: input.view.model,
    system: system.text,
    tools: input.view.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    messages,
    counts: {
      system_chars: system.text.length,
      tool_count: input.view.tools.length,
      message_count: messages.length,
    },
    context: {
      used: input.usage.used,
      window: input.usage.window,
      ratio: input.usage.ratio,
      estimated: input.usage.estimated,
    },
    truncated: system.truncated || messages.some((message) => message["truncated"] === true),
  };
}
