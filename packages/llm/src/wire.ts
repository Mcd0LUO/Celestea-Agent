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
 *
 * W804 (multimodal P0 section 3): an image-bearing message becomes an OpenAI
 * content array, `content: [{type:"text",text}, {type:"image_url",image_url:{url:DATA}}]`.
 * The bytes are a REQUEST-TIME projection: the host resolves them into the
 * `images` table carried on the request (attachment_id -> data URL); they NEVER
 * live in a Message or the session log. A tool message with images is split into
 * the tool text message followed by a user message carrying the images (shape B,
 * section 3.3), because some providers silently drop tool-role images.
 */

import { LlmError } from "./errors.js";
import {
  collectMessageText,
  isImageContent,
  type Content,
  type ImageRef,
  type Message,
  type ModelRequestDraft,
  type ToolSpec,
} from "./seam.js";

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** One text part of an OpenAI content array. */
export interface WireTextPart {
  type: "text";
  text: string;
}

/** One image part; the url is always a `data:` URL (section 3.1: remote URLs denied). */
export interface WireImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type WireContentPart = WireTextPart | WireImagePart;

/** Request-scoped resolution table: attachment_id -> data URL. */
export type ResolvedImages = Readonly<Record<string, string>>;

export interface WireMessage {
  role: string;
  /** A plain string for text-only messages; an array ONLY when it carries images. */
  content: string | WireContentPart[] | null;
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

/** Read the host-resolved image table off a request (absent = empty). */
export function resolvedImagesOf(req: unknown): ResolvedImages {
  if (typeof req !== "object" || req === null) return {};
  const table = (req as Record<string, unknown>)["images"];
  if (typeof table !== "object" || table === null || Array.isArray(table)) return {};
  return table as ResolvedImages;
}

/** `data:<mime>;base64,<...>` for one attachment's bytes. */
export function dataUrlFor(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function imageBytesUnavailable(id: string): LlmError {
  return new LlmError(`attachment ${id} has no resolvable bytes for this request`, "generate", { retryable: false });
}

/** The image references one message carries (its image content blocks). */
export function messageImageRefs(msg: Message): ImageRef[] {
  const out: ImageRef[] = [];
  for (const part of msg.content) if (isImageContent(part)) out.push(part.content);
  return out;
}

/** True when ANY message of the request carries an image block. */
export function messagesHaveImages(messages: readonly Message[]): boolean {
  for (const msg of messages) if (msg.content.some(isImageContent)) return true;
  return false;
}

/** Content parts of ONE message; every image must resolve or this throws. */
export function collectMessageParts(content: readonly Content[], images: ResolvedImages): WireContentPart[] {
  const parts: WireContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.content !== "") parts.push({ type: "text", text: part.content });
    } else if (part.type === "image") {
      const url = images[part.content.attachment_id];
      if (url === undefined) throw imageBytesUnavailable(part.content.attachment_id);
      parts.push({ type: "image_url", image_url: { url } });
    }
  }
  return parts;
}

/** A system/assistant image block is a wiring bug: report it, never drop it. */
function assertNoImages(msg: Message): void {
  if (messageImageRefs(msg).length === 0) return;
  throw new LlmError(`W804: a ${msg.role} message must not carry an image block`, "generate", { retryable: false });
}

function userWire(msg: Message, images: ResolvedImages): WireMessage {
  if (messageImageRefs(msg).length === 0) return { role: "user", content: collectMessageText(msg.content) };
  return { role: "user", content: collectMessageParts(msg.content, images) };
}

function assistantWire(msg: Message): WireMessage {
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

/**
 * Wire messages for ONE seam message (section 3.3): a tool message with images
 * expands to [tool text, user images]. The split lives HERE and nowhere else, so
 * a future provider that accepts tool-role images changes one branch.
 */
export function wireMessagesFor(msg: Message, images: ResolvedImages = {}): WireMessage[] {
  switch (msg.role) {
    case "system":
      assertNoImages(msg);
      return [{ role: "system", content: collectMessageText(msg.content) }];
    case "user":
      return [userWire(msg, images)];
    case "tool": {
      const tool: WireMessage = {
        role: "tool",
        content: collectMessageText(msg.content),
        tool_call_id: msg.tool_call_id ?? "",
      };
      const refs = messageImageRefs(msg);
      if (refs.length === 0) return [tool];
      const parts: WireContentPart[] = [];
      for (const ref of refs) {
        const url = images[ref.attachment_id];
        if (url === undefined) throw imageBytesUnavailable(ref.attachment_id);
        parts.push({ type: "image_url", image_url: { url } });
      }
      return [tool, { role: "user", content: parts }];
    }
    case "assistant":
      assertNoImages(msg);
      return [assistantWire(msg)];
  }
}

/** Map one seam Message onto an OpenAI-compatible chat message. */
export function mapMessage(msg: Message, images: ResolvedImages = {}): WireMessage {
  const out = wireMessagesFor(msg, images);
  const first = out[0];
  if (out.length !== 1 || first === undefined) {
    throw new LlmError("W804: a tool message with images must be split by buildRequestBody", "generate", { retryable: false });
  }
  return first;
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

/** Build the serialized chat-completions body for one request draft. */
export function buildRequestBody(req: ModelRequestDraft, opts: BuildBodyOptions): ChatCompletionsBody {
  const images = resolvedImagesOf(req);
  const messages: WireMessage[] = [];
  if (req.system !== null && req.system !== undefined && req.system !== "") {
    messages.push({ role: "system", content: req.system });
  }
  for (const message of req.messages ?? []) messages.push(...wireMessagesFor(message, images));

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
