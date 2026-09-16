/**
 * W804 (multimodal P0 section 7.6): the ONE automatic downgrade for the
 * optimistic-default bet.
 *
 * Default `input_modalities = ["text","image"]` means we ASSUME every model
 * accepts images. When that assumption is wrong the upstream answers 4xx with a
 * known "image unsupported" report; the client classifies it as an
 * [ImageUnsupportedError]. This decorator then:
 *   1. replaces every ImageContent block with a visible placeholder text,
 *   2. retries the SAME request ONCE,
 *   3. reports the downgrade through `onDowngrade` (the host's three visible
 *      channels: info block / statusline / audit).
 *
 * It never swallows the failure silently: the placeholder is in the retried
 * request, and an unrecognised failure propagates unchanged. If the retry fails
 * too, that failure propagates as an ordinary turn failure.
 */

import type { Content, ImageRef, Llm, LlmStream, Message, ModelRequestDraft } from "./seam.js";
import { isImageUnsupportedError } from "./errors.js";
import { messagesHaveImages } from "./wire.js";

/** What the host renders/persists when a downgrade happens. */
export interface ImageDowngradeInfo {
  /** Effective model that rejected the image (the model selector's value). */
  model: string;
  /** Machine-readable classification (only one cause today). */
  reason: "IMAGE_UNSUPPORTED";
  /** The upstream HTTP status (400 in every observed report). */
  httpStatus: number | null;
  /** The upstream error text, verbatim. */
  message: string;
  /** The placeholder that replaced the images in the retried request. */
  placeholder: string;
}

export interface ImageDowngradeLlmOptions {
  inner: Llm;
  /** Called exactly once per downgraded request, before the retry. */
  onDowngrade?: (info: ImageDowngradeInfo) => void;
}

/** The placeholder text (section 7.6 wording, one per image block). */
export function imagePlaceholderText(ref: ImageRef, model: string): string {
  const label = ref.name !== undefined ? `${ref.attachment_id}（${ref.name}）` : ref.attachment_id;
  return `[图片已省略：模型 "${model}" 未接受图像输入（上游 400）；attachment ${label}]`;
}

/**
 * A copy of the request with every image block replaced by its placeholder and
 * the request-scoped image table removed. Non-image content, tool calls and text
 * are byte-for-byte unchanged.
 */
export function withImagePlaceholders(req: ModelRequestDraft, model: string): ModelRequestDraft {
  const messages: Message[] = [];
  for (const msg of req.messages ?? []) {
    let changed = false;
    const content: Content[] = [];
    for (const part of msg.content) {
      if (part.type === "image") {
        content.push({ type: "text", content: imagePlaceholderText(part.content, model) });
        changed = true;
      } else {
        content.push(part);
      }
    }
    messages.push(changed ? { ...msg, content } : msg);
  }
  const { images: _images, ...rest } = req as ModelRequestDraft & { images?: unknown };
  void _images;
  return { ...rest, messages };
}

/** True when the request carries at least one image content block. */
function hasImages(req: ModelRequestDraft): boolean {
  return messagesHaveImages(req.messages ?? []);
}

function firstPlaceholder(messages: readonly Message[], model: string): string {
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === "image") return imagePlaceholderText(part.content, model);
    }
  }
  return "";
}

/**
 * Wrap an `Llm` with the one-shot image downgrade. Text-only requests pass
 * through untouched (no image scan cost beyond the check).
 */
export function createImageDowngradeLlm(options: ImageDowngradeLlmOptions): Llm {
  return {
    async generate(req: ModelRequestDraft): Promise<LlmStream> {
      if (!hasImages(req)) return options.inner.generate(req);
      const model = req.model ?? "";
      try {
        return await options.inner.generate(req);
      } catch (error) {
        if (!isImageUnsupportedError(error)) throw error;
        options.onDowngrade?.({
          model,
          reason: "IMAGE_UNSUPPORTED",
          httpStatus: error.httpStatus,
          message: error.message,
          placeholder: firstPlaceholder(req.messages ?? [], model),
        });
        return await options.inner.generate(withImagePlaceholders(req, model));
      }
    },
  };
}
