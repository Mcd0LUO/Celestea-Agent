/**
 * W895-C1 / W9108 — the server-side display-component table (pure store).
 *
 * Semantics under test: the stored value is the DISABLED id list (so a newly
 * added component defaults to ON); a missing file is the empty list; a corrupt /
 * foreign file degrades to "nothing disabled" with ONE warning — never a repair,
 * never a throw.
 *
 * W9108 adds the per-plugin settings map, stored OPAQUELY: the server normalizes
 * keys/values to non-empty strings and never invents a plugin id or item key.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPLAY_PLUGINS_FILE,
  normalizeDisabledPlugins,
  normalizePluginConfig,
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
  it("a missing file reads as the empty table, with no warning", () => {
    expect(readDisplayPlugins(tempDir())).toEqual({ disabled: [], config: {}, warnings: [] });
  });

  it("round-trips a normalized disabled list through the atomic write", () => {
    const dir = tempDir();
    const saved = writeDisplayPlugins(dir, ["  hint-text-card ", "hint-text-card", "", "rail-preview"], {}, 1_700_000_000);
    expect(saved.disabled).toEqual(["hint-text-card", "rail-preview"]);
    expect(readDisplayPlugins(dir)).toEqual({ disabled: ["hint-text-card", "rail-preview"], config: {}, warnings: [] });
    // Unknown ids are strings too: the server never invents or drops one.
    writeDisplayPlugins(dir, ["ghost-plugin"], {}, 1_700_000_001);
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
      expect(read.config, body).toEqual({});
      expect(read.warnings, body).toHaveLength(1);
      expect(read.warnings[0]).toContain("every display component is enabled");
    }
  });
});

describe("W9108 display-plugins store · per-plugin settings", () => {
  it("round-trips the settings map and keeps it OUT of the disabled list", () => {
    const dir = tempDir();
    writeDisplayPlugins(dir, ["display.codeCopy"], { "display.codeExtras": { foldLines: "60" } }, 1_700_000_000);
    const read = readDisplayPlugins(dir);
    expect(read.disabled).toEqual(["display.codeCopy"]);
    expect(read.config).toEqual({ "display.codeExtras": { foldLines: "60" } });
    // The file itself carries the third field (hand-inspectable).
    const raw = JSON.parse(readFileSync(join(dir, DISPLAY_PLUGINS_FILE), "utf8")) as Record<string, unknown>;
    expect(raw["config"]).toEqual({ "display.codeExtras": { foldLines: "60" } });
  });

  it("a v1 file WITHOUT `config` reads back as no settings and NO warning (back-compat)", () => {
    const dir = tempDir();
    writeRaw(dir, JSON.stringify({ version: 1, disabled: ["rail-preview"] }));
    const read = readDisplayPlugins(dir);
    expect(read.disabled).toEqual(["rail-preview"]);
    expect(read.config).toEqual({});
    expect(read.warnings).toEqual([]);
  });

  it("normalizePluginConfig drops blanks/non-objects and never invents ids or keys", () => {
    expect(normalizePluginConfig({ "a": { k: "v", " ": "x", e: "" }, "": { k: "v" }, b: 3, c: ["x"], d: null }))
      .toEqual({ a: { k: "v" } });
    expect(normalizePluginConfig(null)).toEqual({});
    expect(normalizePluginConfig([{ a: { k: "v" } }])).toEqual({});
  });

  it("a hand-written file with a broken `config` shape degrades that field only", () => {
    const dir = tempDir();
    // A non-string value is DROPPED, never coerced. The server stores `config`
    // OPAQUELY (it does not know which plugin/item a key belongs to), so it cannot
    // pick the right spelling for a JSON number: the frontend's convention is
    // 'on'/'off' for booleans and decimal TEXT for numbers, and String(12) would
    // invent a value the item's own normalizer may then reject. Every layer already
    // agrees on "drop": this store's normalizePluginConfig doc, the frontend's
    // parseConfigValues (typeof value !== 'string' => continue), and the PUT
    // validator (non-string => 422). Dropping also keeps the whole map intact:
    // only the offending VALUE is lost, not the plugin's other keys.
    writeRaw(dir, JSON.stringify({ version: 1, disabled: ["rail-preview"], config: { "display.codeExtras": { foldLines: 12, other: "keep" } } }));
    expect(readDisplayPlugins(dir).config).toEqual({ "display.codeExtras": { other: "keep" } });
    writeRaw(dir, JSON.stringify({ version: 1, disabled: [], config: "nope" }));
    const read = readDisplayPlugins(dir);
    expect(read.config).toEqual({});
    expect(read.warnings).toEqual([]); // 坏 config 不拖垮整表：只有它自己退化成「没配过」
  });
});
