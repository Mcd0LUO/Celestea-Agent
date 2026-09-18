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
import { isImageUnsupportedError, isTimeoutError } from "./errors.js";
import { messagesHaveImages } from "./wire.js";

/**
 * W855: WHY an image downgrade fired. The three causes reuse the ONE downgrade
 * path (placeholder rewrite -> same-request retry -> onDowngrade); only the
 * trigger and the user-facing copy differ.
 *   - upstream_rejected     the upstream answered 4xx "image unsupported" (W804);
 *   - timeout               response headers never arrived (suspected image
 *                           rejection: the upstream may be slow to REJECT);
 *   - configured_text_only  input_modalities explicitly excludes "image", so no
 *                           image-bearing request is ever sent.
 */
export type ImageDowngradeCause = "upstream_rejected" | "timeout" | "configured_text_only";

/** What the host renders/persists when a downgrade happens. */
export interface ImageDowngradeInfo {
  /** Effective model that triggered the downgrade (the model selector's value). */
  model: string;
  /** Machine-readable classification. NEVER changes: the contract/consumers key on this. */
  reason: "IMAGE_UNSUPPORTED";
  /**
   * W855: the trigger discriminator. OPTIONAL on purpose - an older producer
   * (or an embedded host) that predates this field stays valid and every
   * consumer tolerates its absence (defaults to upstream_rejected).
   */
  cause?: ImageDowngradeCause;
  /** The upstream HTTP status (400 on the reject path); null on the other two. */
  httpStatus: number | null;
  /**
   * The error text, verbatim: the upstream body on the reject path, the timeout
   * message ("llm timeout: response headers ...", threshold included) on the
   * timeout path, and the configured-exclusion fact locally.
   */
  message: string;
  /** The placeholder that replaced the images in the retried request. */
  placeholder: string;
}

export interface ImageDowngradeLlmOptions {
  inner: Llm;
  /** Called exactly once per downgraded request, before the retry. */
  onDowngrade?: (info: ImageDowngradeInfo) => void;
  /**
   * W855: true = the target model is EXPLICITLY configured as text-only
   * (input_modalities without "image"). Evaluated against the request's OWN
   * req.model at call time, so a model switch is never stale. Absent = the
   * optimistic default (images allowed), i.e. the pre-W855 behaviour.
   */
  isTextOnly?: (model: string) => boolean;
}

/**
 * W855: ONLY a RESPONSE-HEADER timeout - not one byte ever arrived, so the
 * request may simply be slow to be rejected - is treated as a suspected image
 * rejection. A connect timeout, a mid-stream stall, a 401, etc. are rethrown
 * unchanged: resending text cannot save them, and a second attempt would only
 * waste a round-trip while swallowing the user's image.
 */
function isResponseHeaderTimeout(e: unknown): boolean {
  return isTimeoutError(e) && (e as { timeoutStage?: unknown }).timeoutStage === "response";
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
      const model = req.model ?? "";
      // Text-only requests pass through untouched: no rewrite, no extra call.
      if (!hasImages(req)) return options.inner.generate(req);
      const placeholder = firstPlaceholder(req.messages ?? [], model);
      // W855 path 1: explicitly configured text-only -> never send the image
      // request; go straight to the placeholder request. No upstream call
      // carries the image; exactly one upstream call happens in total.
      if (options.isTextOnly?.(model) === true) {
        options.onDowngrade?.({
          model,
          reason: "IMAGE_UNSUPPORTED",
          cause: "configured_text_only",
          httpStatus: null,
          message:
            '模型 "' + model + '" 的 input_modalities 不含 "image"（按配置显式排除），本次带图请求未发送。',
          placeholder,
        });
        return await options.inner.generate(withImagePlaceholders(req, model));
      }
      try {
        return await options.inner.generate(req);
      } catch (error) {
        // W855 paths 2/3: a classified upstream 4xx image report, OR a
        // response-header timeout (the suspected-slow-rejection case). Both
        // reuse the SAME downgrade; every other failure propagates unchanged.
        let cause: ImageDowngradeCause | null = null;
        let httpStatus: number | null = null;
        if (isImageUnsupportedError(error)) {
          cause = "upstream_rejected";
          httpStatus = error.httpStatus;
        } else if (isResponseHeaderTimeout(error)) {
          cause = "timeout";
        }
        if (cause === null) throw error;
        options.onDowngrade?.({
          model,
          reason: "IMAGE_UNSUPPORTED",
          cause,
          httpStatus,
          message: error instanceof Error ? error.message : String(error),
          placeholder,
        });
        return await options.inner.generate(withImagePlaceholders(req, model));
      }
    },
  };
}
