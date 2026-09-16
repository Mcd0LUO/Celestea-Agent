/**
 * W824 F01 probe — JSON-quoted credential values must be redacted.
 *
 * Source: R2 report W821 (section E1): createRedactor([]).redact returned
 * {"token":"..."} / "password" / "secret" / "access_token" JSON values
 * verbatim and assertClean still passed. Root cause: the key's CLOSING quote
 * sits between the credential word and the colon, so name...\s*[=:]\s*value
 * never matches. This test fails on HEAD and passes after the fix.
 */

import { describe, expect, it } from "vitest";
import { createRedactor } from "@celestea/core";

describe("W824 F01: JSON-quoted credential values", () => {
  it("redacts token/password/secret/access_token JSON values", () => {
    const cases: Array<[string, string]> = [
      ["token", "abcdef1234567890"],
      ["access_token", "abcdef1234567890"],
      ["password", "abcdef1234567890"],
      ["secret", "abcdef1234567890"],
      ["refresh_token", "a".repeat(100)],
      ["client_secret", "ya29." + "A".repeat(80)],
    ];
    for (const [key, value] of cases) {
      const json = JSON.stringify({ [key]: value });
      const redactor = createRedactor([]);
      const out = redactor.redact(json);
      expect(out, key).not.toContain(value);
      expect(out, key).toContain('"<REDACTED>"');
      expect(() => redactor.assertClean(out, key), key).not.toThrow();
    }
  });

  it("keeps short (non-credential) and non-credential JSON values intact", () => {
    const redactor = createRedactor([]);
    expect(redactor.redact('{"token":"short12345"}')).toBe('{"token":"short12345"}');
    expect(redactor.redact('{"message":"hello world","count":12}')).toBe('{"message":"hello world","count":12}');
  });
});
