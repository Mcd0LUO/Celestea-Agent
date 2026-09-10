/**
 * OpenAI-compatible request wire mapping (P2a).
 *
 * Mirrors `crates/llm/src/client.rs::{build_request, request_body, map_message,
 * map_tool, collect_text}`:
 *
 *   POST {base_url}/chat/completions
 *   { model, messages, tools?, reasoning_effort?, max_tokens?, temperature?,
 *     stream: true }
 *
 * The output cap is the request's explicit max_tokens, else the configured
 * max_output_tokens. `reasoning_effort` is injected verbatim as a free-form
 * string — never folded onto an enum, never renamed ("max" stays "max").
 */

import {
  collectMessageText,
  type Message,
  type ModelRequest,
  type ToolSpec,
} from "./seam.js";

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: string;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export interface WireTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** The chat-completions request body (field presence mirrors serde skip_if). */
export interface ChatCompletionsBody {
  model: string;
  messages: WireMessage[];
  stream: true;
  tools?: WireTool[];
  reasoning_effort?: string;
  max_tokens?: number;
  temperature?: number;
}

/** Map one seam Message onto an OpenAI-compatible chat message. */
export function mapMessage(msg: Message): WireMessage {
  switch (msg.role) {
    case "system":
      return { role: "system", content: collectMessageText(msg.content) };
    case "user":
      return { role: "user", content: collectMessageText(msg.content) };
    case "tool":
      return {
        role: "tool",
        content: collectMessageText(msg.content),
        tool_call_id: msg.tool_call_id ?? "",
      };
    case "assistant": {
      const text = collectMessageText(msg.content);
      const toolCalls: WireToolCall[] = msg.content
        .filter((part) => part.type === "tool_call")
        .map((part) => ({
          id: part.content.id,
          type: "function" as const,
          function: {
            name: part.content.name,
            arguments: JSON.stringify(part.content.args ?? null),
          },
        }));
      const out: WireMessage = { role: "assistant", content: text === "" ? null : text };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      return out;
    }
  }
}

/** Map a seam ToolSpec onto an OpenAI-compatible function tool. */
export function mapTool(spec: ToolSpec): WireTool {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

export interface BuildBodyOptions {
  /** Effective model (the request's model wins over the configured one). */
  model: string;
  /** Free-form tier string injected verbatim; null/undefined = omit. */
  reasoningEffort?: string | null;
  /** Configured output cap used when the request leaves max_tokens empty. */
  maxOutputTokens?: number | null;
}

/** Build the serialized chat-completions body for one ModelRequest. */
export function buildRequestBody(req: ModelRequest, opts: BuildBodyOptions): ChatCompletionsBody {
  const messages: WireMessage[] = [];
  if (req.system !== null && req.system !== undefined && req.system !== "") {
    messages.push({ role: "system", content: req.system });
  }
  for (const message of req.messages ?? []) messages.push(mapMessage(message));

  const tools = (req.tools ?? []).map(mapTool);
  const maxTokens = req.max_tokens ?? opts.maxOutputTokens ?? null;

  const body: ChatCompletionsBody = { model: opts.model, messages, stream: true };
  if (tools.length > 0) body.tools = tools;
  if (maxTokens !== null) body.max_tokens = maxTokens;
  if (req.temperature !== null && req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  if (opts.reasoningEffort !== null && opts.reasoningEffort !== undefined) {
    body.reasoning_effort = opts.reasoningEffort;
  }
  return body;
}

/** chat-completions endpoint for a base URL (trailing slashes tolerated). */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trimEnd().replace(/\/+$/, "")}/chat/completions`;
}
