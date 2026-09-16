/**
 * The model-visible message model — a 1:1 port of
 * `celestea_harness/crates/core/src/message.rs`.
 *
 * Shapes ported here:
 *   Role      enum { System, User, Assistant, Tool }      (serde lowercase)
 *   ToolCall  { id, name, args: Value }
 *   Content   enum { Text(String), ToolCall(ToolCall) }   (tag="type", content="content")
 *   Message   { role, content: Vec<Content>, tool_call_id: Option<String> }
 *   ToolSpec  { name, description, parameters }           (declared in ./types.ts)
 *   Usage     { prompt_tokens, completion_tokens, total_tokens,
 *               cache_read, reasoning_tokens }             (flat counters)
 *
 * Field names and content-tag names are contract, not style: the LLM request
 * builder and every engine projection depend on them. Do not rename anything.
 */

// ---------------------------------------------------------------------------
// Role / Content / ToolCall / Message
// ---------------------------------------------------------------------------

/** `Role` — serde `rename_all = "lowercase"`. */
export const ROLES = ["system", "user", "assistant", "tool"] as const;
export type Role = (typeof ROLES)[number];

/** `ToolCall` — the id is the provider call id, `args` is the raw JSON value. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** `Content::Text` — `{"type":"text","content":"…"}`. */
export interface TextContent {
  type: "text";
  content: string;
}

/** `Content::ToolCall` — `{"type":"tool_call","content":{…}}`. */
export interface ToolCallContent {
  type: "tool_call";
  content: ToolCall;
}

/** The four media types the attachment pipeline accepts (section 5.4 magic-byte whitelist). */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** True for one of the four accepted normalized media types. */
export function isImageMediaType(v: unknown): v is ImageMediaType {
  return typeof v === "string" && (IMAGE_MEDIA_TYPES as readonly string[]).includes(v);
}

/**
 * W804 (multimodal P0 4.1): a content-addressed REFERENCE to an attachment
 * object, never the bytes. The object itself lives at
 * <session-dir>/attachments/<attachment_id>.<ext> (section 5); the session log
 * and every projected event carry only this shape — base64 in the log is a red line.
 *
 * original records the pre-normalization dimensions of an image that was
 * re-encoded/downscaled (DSH originalDimensions semantics); P0 never writes it
 * (no re-encode), but the type is frozen here so P1 is purely additive.
 */
export interface ImageRef {
  /** Content-addressing id: sha256(original bytes) in lowercase hex. */
  attachment_id: string;
  /** Normalized media type (magic-byte sniffed, never trusted from a name). */
  media_type: ImageMediaType;
  /** Normalized pixel width. */
  width: number;
  /** Normalized pixel height. */
  height: number;
  /** Original upload/file name, for the UI and model-readable labels only. */
  name?: string;
  /** Set when the stored bytes are a downscaled/re-encoded variant. */
  original?: { width: number; height: number; bytes: number; media_type: string };
}

/**
 * W804: the log/event spelling of ImageRef (section 4.3). Structurally identical —
 * the alias exists so the event codec and the content model can each use the
 * vocabulary of their own layer without drifting apart.
 */
export type AttachmentRef = ImageRef;

/** Content::Image — {"type":"image","content":{...ImageRef}} (section 4.1). */
export interface ImageContent {
  type: "image";
  content: ImageRef;
}

export type Content = TextContent | ToolCallContent | ImageContent;

/**
 * `Message` — one entry of the model-visible history.
 *
 * `content` is always a list (an assistant turn that calls tools carries one
 * `tool_call` item per call in a SINGLE message); `tool_call_id` is set only for
 * `role = "tool"`, so a result can be matched to its call.
 */
export interface Message {
  role: Role;
  content: Content[];
  tool_call_id: string | null;
}

// Constructors mirror the engine's `impl Message` (same names, camelCase).

/** `Message::user`. */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::system`. */
export function systemMessage(text: string): Message {
  return { role: "system", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::assistant_text`. */
export function assistantText(text: string): Message {
  return { role: "assistant", content: [{ type: "text", content: text }], tool_call_id: null };
}

/** `Message::assistant_tool_call`. */
export function assistantToolCall(call: ToolCall): Message {
  return { role: "assistant", content: [{ type: "tool_call", content: call }], tool_call_id: null };
}

/** `Message::tool_result`. */
export function toolResultMessage(id: string, text: string): Message {
  return { role: "tool", content: [{ type: "text", content: text }], tool_call_id: id };
}

/**
 * W804: a user message that carries text plus image references. The text block
 * stays FIRST and the images follow (section 3.5 ordering rule); no-image callers
 * keep using userMessage so the wire shape is byte-identical when there is
 * nothing to attach.
 */
export function userMessageWithImages(text: string, images: readonly ImageRef[]): Message {
  const content: Content[] = [{ type: "text", content: text }];
  for (const ref of images) content.push(imageContent(ref));
  return { role: "user", content, tool_call_id: null };
}

/**
 * W804: a tool result that carries the canonical JSON text plus image
 * references (the read_image case, section 6.3). The TEXT remains the value's
 * serde JSON — the model must still see path/dimensions — and the images are
 * separate content blocks.
 */
export function toolResultWithImages(id: string, text: string, images: readonly ImageRef[]): Message {
  const content: Content[] = [{ type: "text", content: text }];
  for (const ref of images) content.push(imageContent(ref));
  return { role: "tool", content, tool_call_id: id };
}

/** Static namespace facade: `Message::user(…)` → `Message.user(…)`. */
export const Message = {
  user: userMessage,
  system: systemMessage,
  assistantText,
  assistantToolCall,
  toolResult: toolResultMessage,
  userWithImages: userMessageWithImages,
  toolResultWithImages,
} as const;

// ---------------------------------------------------------------------------
// Content helpers (the engine pattern-matches; these are the TS equivalents)
// ---------------------------------------------------------------------------

export function isTextContent(c: Content): c is TextContent {
  return c.type === "text";
}

export function isToolCallContent(c: Content): c is ToolCallContent {
  return c.type === "tool_call";
}

export function isImageContent(c: Content): c is ImageContent {
  return c.type === "image";
}

/** Wrap one already-content-addressed reference as a model-visible image block. */
export function imageContent(ref: ImageRef): ImageContent {
  return { type: "image", content: ref };
}

/** The image blocks of a message, in order (references only, never bytes). */
export function messageImages(m: Message): ImageRef[] {
  const out: ImageRef[] = [];
  for (const c of m.content) if (isImageContent(c)) out.push(c.content);
  return out;
}

/** The tool calls carried by a message (empty for a text-only message). */
export function messageToolCalls(m: Message): ToolCall[] {
  const out: ToolCall[] = [];
  for (const c of m.content) if (isToolCallContent(c)) out.push(c.content);
  return out;
}

/** The ids of the tool calls carried by a message. */
export function toolCallIds(m: Message): string[] {
  return messageToolCalls(m).map((tc) => tc.id);
}

/**
 * The text blocks of a message, in order. W804: image blocks are deliberately
 * NOT text — they are never concatenated here (and never stringified into a
 * prompt); a consumer that needs the images reads messageImages.
 */
export function messageTexts(m: Message): string[] {
  const out: string[] = [];
  for (const c of m.content) if (isTextContent(c)) out.push(c.content);
  return out;
}

/** The single text block of a text-only message, or null. */
export function messageText(m: Message): string | null {
  const texts = messageTexts(m);
  return texts.length === 1 ? (texts[0] ?? null) : null;
}

/** True when the message carries at least one tool call. */
export function hasToolCalls(m: Message): boolean {
  return m.content.some(isToolCallContent);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Attachment reference helpers (W804: the log/event side of ImageRef)
// ---------------------------------------------------------------------------

/**
 * True when v has the ImageRef shape the event codec and projection accept.
 * name and original are optional and their absence is the normal case.
 */
export function isImageRef(v: unknown): v is ImageRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["attachment_id"] === "string" &&
    isImageMediaType(r["media_type"]) &&
    typeof r["width"] === "number" &&
    Number.isFinite(r["width"]) &&
    typeof r["height"] === "number" &&
    Number.isFinite(r["height"]) &&
    (r["name"] === undefined || typeof r["name"] === "string")
  );
}

/**
 * Field-whitelist normalization of one decoded attachment reference: unknown
 * fields are dropped and absent optionals stay omitted (serde style). Returns
 * null when the value is not an ImageRef at all.
 */
export function normalizeImageRef(v: unknown): ImageRef | null {
  if (!isImageRef(v)) return null;
  const out: ImageRef = {
    attachment_id: v.attachment_id,
    media_type: v.media_type,
    width: v.width,
    height: v.height,
  };
  if (typeof v.name === "string") out.name = v.name;
  if (typeof v.original === "object" && v.original !== null) {
    const o = v.original as Record<string, unknown>;
    if (
      typeof o["width"] === "number" &&
      typeof o["height"] === "number" &&
      typeof o["bytes"] === "number" &&
      typeof o["media_type"] === "string"
    ) {
      out.original = { width: o["width"], height: o["height"], bytes: o["bytes"], media_type: o["media_type"] };
    }
  }
  return out;
}

/**
 * The image references carried by a tool_result value (its attachments field,
 * section 6.3). Anything that is not a valid reference is ignored, so a
 * malformed tool value can never smuggle a bogus image into the prompt.
 */
export function attachmentRefsOfValue(value: unknown): ImageRef[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)["attachments"];
  if (!Array.isArray(raw)) return [];
  const out: ImageRef[] = [];
  for (const item of raw) {
    const ref = normalizeImageRef(item);
    if (ref !== null) out.push(ref);
  }
  return out;
}

// Usage (message.rs:81-108)
// ---------------------------------------------------------------------------

/** Provider-reported token usage for one LLM response (`Usage`). */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read: number;
  reasoning_tokens: number;
}

/** All-zero usage (`Usage::default`). */
export function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, reasoning_tokens: 0 };
}

/** `Usage::is_empty` — true when every counter is zero. */
export function usageIsEmpty(u: Usage): boolean {
  return (
    u.prompt_tokens === 0 &&
    u.completion_tokens === 0 &&
    u.total_tokens === 0 &&
    u.cache_read === 0 &&
    u.reasoning_tokens === 0
  );
}

/** `Usage::add` — per-field sum, returning a new value. */
export function usageAdd(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cache_read: a.cache_read + b.cache_read,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
  };
}

/** Sum a list of usages (`Usage +=` in a loop). */
export function usageSum(usages: readonly Usage[]): Usage {
  let total = zeroUsage();
  for (const u of usages) total = usageAdd(total, u);
  return total;
}

/** Cache-hit ratio as reported by the statusline (`cache_read / prompt_tokens`). */
export function cacheHitRatio(u: Usage): number {
  return u.prompt_tokens === 0 ? 0 : u.cache_read / u.prompt_tokens;
}
