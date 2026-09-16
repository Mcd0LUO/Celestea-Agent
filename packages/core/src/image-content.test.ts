/**
 * W804 (multimodal P0, stage 1): the ImageContent content variant.
 *
 * Pins the byte shape of a reference (never bytes), the helpers, and the
 * additive-only rule: a message with no images must be byte-identical to the
 * pre-W804 constructors.
 */

import { describe, expect, it } from "vitest";
import {
  imageContent,
  isImageContent,
  isImageMediaType,
  isTextContent,
  messageImages,
  messageText,
  toolResultMessage,
  toolResultWithImages,
  userMessage,
  userMessageWithImages,
  type ImageRef,
} from "./message.js";

const REF: ImageRef = {
  attachment_id: "a".repeat(64),
  media_type: "image/png",
  width: 512,
  height: 256,
  name: "shot.png",
};

describe("ImageContent variant", () => {
  it("tags the block with type=image and the reference as content", () => {
    const block = imageContent(REF);
    expect(block).toEqual({ type: "image", content: REF });
    expect(JSON.stringify(block)).toBe(
      '{"type":"image","content":{"attachment_id":"' + "a".repeat(64) + '","media_type":"image/png","width":512,"height":256,"name":"shot.png"}}',
    );
  });

  it("narrows content variants and never mistakes an image for text", () => {
    const block = imageContent(REF);
    expect(isImageContent(block)).toBe(true);
    expect(isTextContent(block)).toBe(false);
    expect(isImageContent({ type: "text", content: "hi" })).toBe(false);
  });

  it("accepts exactly the four sniffed media types", () => {
    expect(isImageMediaType("image/png")).toBe(true);
    expect(isImageMediaType("image/jpeg")).toBe(true);
    expect(isImageMediaType("image/webp")).toBe(true);
    expect(isImageMediaType("image/gif")).toBe(true);
    expect(isImageMediaType("image/svg+xml")).toBe(false);
    expect(isImageMediaType("text/plain")).toBe(false);
    expect(isImageMediaType(undefined)).toBe(false);
  });

  it("userMessageWithImages keeps text first, then the references in order", () => {
    const m = userMessageWithImages("look", [REF, { ...REF, attachment_id: "b".repeat(64) }]);
    expect(m.role).toBe("user");
    expect(m.tool_call_id).toBeNull();
    expect(m.content.map((c) => c.type)).toEqual(["text", "image", "image"]);
    expect(m.content[0]).toEqual({ type: "text", content: "look" });
    expect(messageImages(m).map((r) => r.attachment_id)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(messageText(m)).toBe("look");
  });

  it("toolResultWithImages keeps the JSON text plus the images", () => {
    const m = toolResultWithImages("c1", '{"ok":true}', [REF]);
    expect(m.role).toBe("tool");
    expect(m.tool_call_id).toBe("c1");
    expect(m.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(messageImages(m)).toEqual([REF]);
  });

  it("stays byte-identical to the pre-W804 constructs when no image is present", () => {
    expect(userMessageWithImages("hi", [])).toEqual(userMessage("hi"));
    expect(toolResultWithImages("c1", "ok", [])).toEqual(toolResultMessage("c1", "ok"));
    expect(JSON.stringify(userMessageWithImages("hi", []))).toBe(JSON.stringify(userMessage("hi")));
  });

  it("messageImages reports [] for text/tool_call-only messages", () => {
    expect(messageImages(userMessage("x"))).toEqual([]);
  });
});
