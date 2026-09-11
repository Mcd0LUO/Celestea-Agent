/**
 * Engine request -> host view (W725): the projection behind
 * `GET /api/sessions/{id}/context`.
 *
 * The projection is deliberately thin and lossless in the direction that
 * matters: everything the model sees comes from the agent loop's own
 * `contextSnapshot()` (system prompt, post-trim derived history, tool schemas).
 * This module never trims, filters or re-derives a single message — it only
 * flattens the engine's `Message[]` into one display row per message, because
 * the wire contract carries `content` as a string.
 *
 * Flattening rules (frozen; the frontend renders them verbatim):
 *   - a message's content blocks are joined with "\n";
 *   - a `tool_call` block contributes `[tool_call] <name> <compact JSON args>`;
 *   - an assistant tool-call row carries the FIRST call's `tool_name` +
 *     `tool_call_id` (`tool_name` = what it called, id = the call it made);
 *   - a `tool` result row carries its own `tool_call_id`, resolved back to the
 *     call's `tool_name` while the messages are walked in order.
 */

import type { Content, Message, ToolCall, ToolSpec } from "@celestea/core";
import type { Runtime } from "@celestea/runtime";
import type { ContextMessageView, ContextToolView, SessionContextView } from "../runtime-adapter.js";

/** What to report when the mounted loop has no snapshot capability. */
export interface ContextFallback {
  model: string;
  system: string;
  tools: readonly ToolSpec[];
}

/** One message's content blocks as a single display string. */
export function renderContent(content: readonly Content[]): string {
  return content.map((block) => (block.type === "text" ? block.content : callText(block.content))).join("\n");
}

/** `Message[]` -> one view row each, resolving tool names in message order. */
export function messageViews(messages: readonly Message[]): ContextMessageView[] {
  const names = new Map<string, string>();
  const rows: ContextMessageView[] = [];
  for (const message of messages) {
    const call = firstCall(message);
    if (call !== null) names.set(call.id, call.name);
    rows.push(rowOf(message, names));
  }
  return rows;
}

/**
 * The session's context as the engine assembled it. `runtime.contextSnapshot()`
 * is the ONLY source; the fallback (a loop without the capability) reports the
 * profile's system prompt and the composed tool schemas with no history.
 */
export function contextViewOf(runtime: Runtime, fallback: ContextFallback): SessionContextView {
  const request = runtime.contextSnapshot();
  if (request === null) {
    return { model: fallback.model, system: fallback.system, tools: toolViews(fallback.tools), messages: [] };
  }
  return {
    model: request.model,
    system: request.system ?? "",
    tools: toolViews(request.tools),
    messages: messageViews(request.messages),
  };
}

/** Tool schemas pass through verbatim (name / description / parameters). */
export function toolViews(specs: readonly ToolSpec[]): ContextToolView[] {
  return specs.map((spec) => ({ name: spec.name, description: spec.description, parameters: spec.parameters }));
}

function rowOf(message: Message, names: Map<string, string>): ContextMessageView {
  const row: ContextMessageView = { role: message.role, content: renderContent(message.content) };
  const call = firstCall(message);
  if (call !== null) {
    row.tool_name = call.name;
    row.tool_call_id = call.id;
  }
  const answered = message.tool_call_id;
  if (answered !== null) {
    row.tool_call_id = answered;
    const name = names.get(answered);
    if (name !== undefined) row.tool_name = name;
  }
  return row;
}

function firstCall(message: Message): ToolCall | null {
  for (const block of message.content) if (block.type === "tool_call") return block.content;
  return null;
}

function callText(call: ToolCall): string {
  return `[tool_call] ${call.name} ${argsText(call.args)}`;
}

function argsText(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "null";
  } catch {
    return "<unserializable args>";
  }
}
