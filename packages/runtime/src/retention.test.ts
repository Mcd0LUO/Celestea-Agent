import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createToolResultRetention,
  DEFAULT_SPILL_TTL_MS,
  retentionSettingsFromEnv,
  sweepSpills,
} from "./retention.js";

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
  it("W855 #8a: reaps spills older than the TTL at writer creation, keeps fresh ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "w855-sweep-"));
    const spills = join(dir, "spills");
    mkdirSync(spills, { recursive: true });
    const stale = join(spills, "old-1.txt");
    const fresh = join(spills, "fresh-2.txt");
    const other = join(spills, "keep.md");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "fresh");
    writeFileSync(other, "not a spill");
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1_000) / 1_000;
    utimesSync(stale, tenDaysAgo, tenDaysAgo);

    // The sweep runs when the writer is created (the compose-time hook).
    createToolResultRetention(retentionSettingsFromEnv(dir, {}));

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true); // only *.txt spill files are reaped
  });

  it("W855 #8a: sweepSpills is a fail-soft no-op when disabled or absent", () => {
    expect(sweepSpills(null, DEFAULT_SPILL_TTL_MS)).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "w855-sweep-"));
    expect(sweepSpills(dir, DEFAULT_SPILL_TTL_MS)).toBe(0); // no spills/ yet
    expect(sweepSpills(dir, 0)).toBe(0); // TTL 0 = disabled
    mkdirSync(join(dir, "spills"), { recursive: true });
    writeFileSync(join(dir, "spills", "a-1.txt"), "x");
    const longAgo = 1;
    utimesSync(join(dir, "spills", "a-1.txt"), longAgo, longAgo);
    expect(sweepSpills(dir, 1_000, Date.now())).toBe(1);
    expect(existsSync(join(dir, "spills", "a-1.txt"))).toBe(false);
  });

  it("W855 #8a: reports the spill TTL and reads its env override", () => {
    expect(retentionSettingsFromEnv("/s", {}).spillTtlMs).toBe(DEFAULT_SPILL_TTL_MS);
    expect(DEFAULT_SPILL_TTL_MS).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(retentionSettingsFromEnv("/s", { CELESTEA_SPILL_TTL_MS: "1200" }).spillTtlMs).toBe(1200);
  });
});
