/**
 * W824 W811-P0-1 + N2 probe — transport.redact must survive the shapes that
 * actually reach a status error.
 *
 * Source: R2 report W821 (section E10): redact("Invalid Authorization: Bearer
 * abcdef123456") was returned verbatim, lowercase bearer did not match, and an
 * arbitrary provider key (invalid api key: 9f8e...) had no literal fallback.
 * Fails on HEAD, passes after the fix.
 */

import { describe, expect, it } from "vitest";
import { redact } from "./transport.js";

describe("W824 W811-P0-1/N2: llm transport.redact", () => {
  it("redacts Bearer tokens with whitespace and in any case", () => {
    expect(redact("Invalid Authorization: Bearer abcdef123456")).not.toContain("abcdef123456");
    expect(redact("Invalid Authorization: bearer abcdef123456")).not.toContain("abcdef123456");
    expect(redact("Invalid Authorization: Bearer    abcdef123456")).not.toContain("abcdef123456");
    expect(redact("Invalid Authorization:BEARER abcdef123456")).not.toContain("abcdef123456");
  });

  it("redacts the client's own key by literal replacement (N2 fallback)", () => {
    const key = "9f8e7d6c5b4a3210";
    const out = redact("invalid api key: " + key, [key]);
    expect(out).not.toContain(key);
    expect(out).toContain("<redacted>");
    // No literal registered = shape rules only; the arbitrary key is not a shape.
    expect(redact("invalid api key: " + key)).toContain(key);
  });

  it("still redacts sk- shaped keys", () => {
    expect(redact("bad key sk-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });
});
