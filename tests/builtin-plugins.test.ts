/**
 * W855 #5: the built-in plugin inventory must match the source exactly.
 *
 * The scanner re-derives, with the TypeScript parser:
 *   - every production `definePlugin(...)` call, with the tokens its body
 *     provides; and
 *   - every production `.provide(...)` call that is NOT inside such a body.
 * `tests/lib/builtin-plugins.ts` must agree in BOTH directions.
 *
 * Teeth: adding an unrecorded mount, or removing a recorded one, turns this
 * red (see the W855 report for the raw before/after output).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_MOUNTS, layerOf, type MountRow } from "./lib/builtin-plugins.js";

// typescript ships CommonJS; `createRequire` avoids the esModuleInterop question.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");

const REPO = process.cwd();
const ROOTS = ["packages", "apps/studio/src"];
/** The `definePlugin` declaration (not a mount site). */
const DEFINITION_FILE = "packages/core/src/plugin.ts";

function isExcluded(rel: string): boolean {
  if (rel === DEFINITION_FILE) return true;
  if (!rel.includes("/src/")) return true;
  return /\.test\.ts$/.test(rel) || /test-util\.ts$/.test(rel) || /(^|\/)fakes[^/]*\.ts$/.test(rel);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  for (const root of ROOTS) walk(join(REPO, root));
  return out
    .map((file) => relative(REPO, file).split("\\").join("/"))
    .filter((rel) => !isExcluded(rel))
    .sort();
}

interface DefineSite { nameArg: string; start: number; end: number; provides: string[] }
interface ProvideSite { token: string; start: number; end: number }

function scanFile(file: string): { defines: DefineSite[]; direct: ProvideSite[] } {
  const text = readFileSync(join(REPO, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const defines: DefineSite[] = [];
  const provides: ProvideSite[] = [];
  const firstArg = (node: import("typescript").CallExpression): string => {
    const arg = node.arguments[0];
    if (arg === undefined) return "<none>";
    return ts.isStringLiteral(arg) ? arg.text : arg.getText(sf);
  };
  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "definePlugin") {
        defines.push({ nameArg: firstArg(node), start: node.getStart(sf), end: node.getEnd(), provides: [] });
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "provide") {
        provides.push({ token: firstArg(node), start: node.getStart(sf), end: node.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Attribute every provide to the INNERMOST definePlugin call containing it.
  const direct: ProvideSite[] = [];
  for (const site of provides) {
    const owner = defines
      .filter((d) => d.start <= site.start && site.end <= d.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (owner === undefined) direct.push(site);
    else owner.provides.push(site.token);
  }
  return { defines, direct };
}

interface PluginAgg { count: number; provides: string[] }

function scanRepo(): { plugins: Map<string, PluginAgg>; direct: Map<string, number> } {
  const plugins = new Map<string, PluginAgg>();
  const direct = new Map<string, number>();
  for (const file of sourceFiles()) {
    const scanned = scanFile(file);
    for (const d of scanned.defines) {
      const key = file + "::" + d.nameArg;
      const cur = plugins.get(key) ?? { count: 0, provides: [] };
      cur.count += 1;
      cur.provides.push(...d.provides);
      plugins.set(key, cur);
    }
    for (const p of scanned.direct) {
      const key = file + "::" + p.token;
      direct.set(key, (direct.get(key) ?? 0) + 1);
    }
  }
  for (const value of plugins.values()) value.provides.sort();
  return { plugins, direct };
}

function inventoryView(rows: readonly MountRow[]): { plugins: Map<string, PluginAgg>; direct: Map<string, number> } {
  const plugins = new Map<string, PluginAgg>();
  const direct = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "plugin") {
      const key = row.file + "::" + row.nameArg;
      const cur = plugins.get(key) ?? { count: 0, provides: [] };
      cur.count += 1;
      cur.provides.push(...row.provides);
      plugins.set(key, cur);
    } else {
      const key = row.file + "::" + row.token;
      direct.set(key, (direct.get(key) ?? 0) + 1);
    }
  }
  for (const value of plugins.values()) value.provides.sort();
  return { plugins, direct };
}

const entries = <T>(map: Map<string, T>): [string, T][] => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const scan = scanRepo();
const inventory = inventoryView(BUILTIN_MOUNTS);

describe("W855 #5 built-in plugin inventory", () => {
  it("is a non-trivial inventory (the check has teeth)", () => {
    expect(scan.plugins.size).toBeGreaterThanOrEqual(10);
    expect(scan.direct.size).toBeGreaterThanOrEqual(5);
  });

  /** Keys present on one side only, so a failure names the offender. */
  const keyDiff = <T>(a: Map<string, T>, b: Map<string, T>): { onlyInSource: string[]; onlyInInventory: string[] } => ({
    onlyInSource: [...a.keys()].filter((k) => !b.has(k)).sort(),
    onlyInInventory: [...b.keys()].filter((k) => !a.has(k)).sort(),
  });

  it("agrees on every definePlugin mount and its provided tokens, both directions", () => {
    expect(keyDiff(scan.plugins, inventory.plugins)).toEqual({ onlyInSource: [], onlyInInventory: [] });
    expect(entries(scan.plugins)).toEqual(entries(inventory.plugins));
  });

  it("agrees on every direct compose-root provide, both directions", () => {
    expect(keyDiff(scan.direct, inventory.direct)).toEqual({ onlyInSource: [], onlyInInventory: [] });
    expect(entries(scan.direct)).toEqual(entries(inventory.direct));
  });

  it("records the correct tier and viaDefinePlugin for every row", () => {
    for (const row of BUILTIN_MOUNTS) {
      expect(layerOf(row.file)).toBe(row.layer);
      expect(row.viaDefinePlugin).toBe(row.kind === "plugin");
    }
  });
});
