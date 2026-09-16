/** W804 (stage 3): an image block MUST count toward the context estimate (R8). */

import { describe, expect, it } from "vitest";
import { estimateImageTokens, estimateMessageTokens, IMAGE_BASE_TOKENS, IMAGE_PIXEL_DIVISOR } from "./context-trim.js";

const IMAGE = { attachment_id: "a".repeat(64), media_type: "image/png" as const, width: 1000, height: 1000 };

describe("W804 image token estimate", () => {
  it("never estimates an image as free", () => {
    const withImage = { role: "user" as const, content: [{ type: "text" as const, content: "x" }, { type: "image" as const, content: IMAGE }], tool_call_id: null };
    const textOnly = { role: "user" as const, content: [{ type: "text" as const, content: "x" }], tool_call_id: null };
    expect(estimateMessageTokens(withImage)).toBeGreaterThan(estimateMessageTokens(textOnly));
  });

  it("is fixed overhead plus a coarse area term", () => {
    expect(estimateImageTokens(1000, 1000)).toBe(IMAGE_BASE_TOKENS + Math.ceil(1_000_000 / IMAGE_PIXEL_DIVISOR));
    expect(estimateImageTokens(0, 0)).toBe(IMAGE_BASE_TOKENS);
  });
});
