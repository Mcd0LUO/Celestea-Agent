/**
 * W895-C1 — the server-side display-component enabled table (pure store).
 *
 * Semantics under test: the stored value is the DISABLED id list (so a newly
 * added component defaults to ON); a missing file is the empty list; a corrupt /
 * foreign file degrades to "nothing disabled" with ONE warning — never a repair,
 * never a throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPLAY_PLUGINS_FILE,
  normalizeDisabledPlugins,
  readDisplayPlugins,
  writeDisplayPlugins,
} from "./display-plugins.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "w895-display-"));
  dirs.push(dir);
  return dir;
}

function writeRaw(dir: string, body: string): void {
  writeFileSync(join(dir, DISPLAY_PLUGINS_FILE), body, "utf8");
}

describe("W895-C1 display-plugins store", () => {
  it("a missing file reads as the empty disabled list, with no warning", () => {
    expect(readDisplayPlugins(tempDir())).toEqual({ disabled: [], warnings: [] });
  });

  it("round-trips a normalized disabled list through the atomic write", () => {
    const dir = tempDir();
    const saved = writeDisplayPlugins(dir, ["  hint-text-card ", "hint-text-card", "", "rail-preview"], 1_700_000_000);
    expect(saved).toEqual(["hint-text-card", "rail-preview"]);
    expect(readDisplayPlugins(dir)).toEqual({ disabled: ["hint-text-card", "rail-preview"], warnings: [] });
    // Unknown ids are strings too: the server never invents or drops one.
    writeDisplayPlugins(dir, ["ghost-plugin"], 1_700_000_001);
    expect(readDisplayPlugins(dir).disabled).toEqual(["ghost-plugin"]);
  });

  it("normalize trims, drops blanks and dedupes keeping first-occurrence order", () => {
    expect(normalizeDisabledPlugins([" a ", "b", "a", "", "  "])).toEqual(["a", "b"]);
  });

  it("broken JSON / wrong shape / wrong version degrade to all-ON with ONE warning", () => {
    const cases = ['{ 这不是 JSON', '"x"', '["a",3,null,"b"]', '{"version":2,"disabled":["a"]}', '{}'];
    for (const body of cases) {
      const dir = tempDir();
      writeRaw(dir, body);
      const read = readDisplayPlugins(dir);
      expect(read.disabled, body).toEqual([]);
      expect(read.warnings, body).toHaveLength(1);
      expect(read.warnings[0]).toContain("every display component is enabled");
    }
  });
});
