import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createToolResultRetention, retentionSettingsFromEnv } from "./retention.js";

describe("W855 runtime spill writer", () => {
  it("persists the full text and the locator reads back byte-for-byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w855-spill-"));
    const policy = createToolResultRetention(retentionSettingsFromEnv(dir, {}));
    const text = "line\n".repeat(500) + "é";
    const spilled = await policy.spill(text, { callId: "c1" });
    expect(spilled).not.toBeNull();
    const bytes = readFileSync(spilled!.locator);
    expect(bytes.length).toBe(Buffer.byteLength(text, "utf8"));
    expect(bytes.toString("utf8")).toBe(text);
    expect(spilled!.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(spilled!.retrievalHint).toContain('read_file path="');
    expect(spilled!.locator).toContain(join(dir, "spills"));
  });

  it("is inert (returns null) with no session dir", async () => {
    const policy = createToolResultRetention(retentionSettingsFromEnv(null, {}));
    expect(await policy.spill("x", { callId: "c1" })).toBeNull();
  });

  it("fail-soft: an unwritable location returns null instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w855-spill-"));
    writeFileSync(join(dir, "spills"), "a file blocks the spills/ directory");
    const policy = createToolResultRetention(retentionSettingsFromEnv(dir, {}));
    expect(await policy.spill("x", { callId: "c1" })).toBeNull();
  });

  it("reads thresholds from the environment, with the defaults otherwise", () => {
    const custom = retentionSettingsFromEnv("/s", {
      CELESTEA_TOOL_RESULT_MAX_BYTES: "1234",
      CELESTEA_STEP_TOOL_RESULT_MAX_BYTES: "5678",
    });
    expect(custom.singleResultBytes).toBe(1234);
    expect(custom.stepResultBytes).toBe(5678);
    const defaults = retentionSettingsFromEnv("/s", {});
    expect(defaults.singleResultBytes).toBe(64 * 1024);
    expect(defaults.stepResultBytes).toBe(128 * 1024);
  });
});
