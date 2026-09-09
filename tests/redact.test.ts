import { describe, expect, it } from "vitest";
import { collectKnownSecrets, createRedactor } from "@celestea/core";

describe("redaction", () => {
  it("redacts registered secrets and generic token shapes", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const r = createRedactor([secret]);
    const out = r.redact(`key=${secret} bearer=Bearer ${secret} npm=npm_${"a".repeat(36)}`);
    expect(out).not.toContain(secret);
    expect(out).toContain("<REDACTED>");
    expect(r.report().replacements).toBeGreaterThanOrEqual(3);
  });

  it("redacts JSON header values but keeps the key name", () => {
    const r = createRedactor([]);
    const out = r.redact('{"Authorization":"Bearer abcdefghijklmnop","api_key":"sk-1234567890abcdefgh"}');
    expect(out).toContain('"Authorization":"<REDACTED>"');
    expect(out).not.toContain("abcdefghijklmnop");
  });

  it("assertClean throws when a secret survives", () => {
    const secret = "sk-zzzzzzzzzzzzzzzzzzzzzzzz";
    const r = createRedactor([secret]);
    expect(() => r.assertClean(`leak ${secret}`, "test")).toThrow(/secret leak/);
  });

  it("collects secrets from providers.json, npmrc and env", () => {
    const found = collectKnownSecrets({
      providersJson: { providers: [{ api_key: "sk-providerkey0123456789" }, { api_key: "" }] },
      npmrc: "_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
      env: { CELESTEA_API_KEY: "sk-fromenv0123456789abcdef" },
    });
    expect(found).toHaveLength(3);
  });
});
