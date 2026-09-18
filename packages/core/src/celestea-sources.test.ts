/**
 * W882 acceptance — the two-layer source model: roots, priority order, and the
 * four tier combinations (global only / project only / both / neither).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CelesteaHomeInput } from "./celestea-home.js";
import { globalSourceRoot, projectSourceRoot, readLayers, type SourceLayer } from "./celestea-sources.js";
import { listSkills, type SkillListing } from "./skills.js";

let root: string;
let ws: string;
let home: string;
let input: CelesteaHomeInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w882-sources-"));
  ws = join(root, "sample-ws");
  home = join(root, "data");
  mkdirSync(ws, { recursive: true });
  input = { env: { CELESTEA_HOME: home } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function plantSkill(base: string, name: string, description: string): void {
  const dir = join(base, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", "name: " + name, "description: " + description, "---", "body of " + name].join("\n"));
}

function find(listing: SkillListing, name: string) {
  return listing.skills.find((s) => s.name === name);
}

describe("W882 · source roots and priority order", () => {
  it("project = <ws>/.celestea, global = <home>/workspaces/<ws>, order [project, global]", () => {
    expect(projectSourceRoot(ws)).toBe(join(ws, ".celestea"));
    expect(globalSourceRoot(ws, input)).toBe(join(home, "workspaces", "sample-ws"));
    expect(readLayers(ws, input).map((l) => l.source)).toEqual(["project", "global"]);
    expect(readLayers(ws, input).map((l) => l.root)).toEqual([projectSourceRoot(ws), globalSourceRoot(ws, input)]);
  });

  it("is platform-deterministic for the project root", () => {
    expect(projectSourceRoot("C:\\ws", "win32")).toBe("C:\\ws\\.celestea");
    expect(projectSourceRoot("/src/ws", "linux")).toBe("/src/ws/.celestea");
  });
});

describe("W882 · four tier combinations", () => {
  it("1) global only", () => {
    plantSkill(globalSourceRoot(ws, input), "pdf", "global pdf");
    const listing = listSkills(readLayers(ws, input));
    expect(listing.skills.map((s) => s.name)).toEqual(["pdf"]);
    expect(find(listing, "pdf")?.source).toBe("global");
    expect(listing.rejected).toEqual([]);
  });

  it("2) project only", () => {
    plantSkill(projectSourceRoot(ws), "pdf", "project pdf");
    const listing = listSkills(readLayers(ws, input));
    expect(listing.rejected).toEqual([]);
    expect(find(listing, "pdf")?.source).toBe("project");
    expect(find(listing, "pdf")?.dir).toBe(join(ws, ".celestea", "skills", "pdf"));
  });

  it("3) both: project WINS the same name, distinct names coexist", () => {
    plantSkill(projectSourceRoot(ws), "pdf", "project wins");
    plantSkill(globalSourceRoot(ws, input), "pdf", "global loses");
    plantSkill(projectSourceRoot(ws), "alpha", "project alpha");
    plantSkill(globalSourceRoot(ws, input), "beta", "global beta");
    const listing = listSkills(readLayers(ws, input));
    expect(listing.skills.map((s) => s.name)).toEqual(["alpha", "beta", "pdf"]);
    expect(find(listing, "pdf")?.description).toBe("project wins");
    expect(find(listing, "pdf")?.source).toBe("project");
    expect(find(listing, "alpha")?.source).toBe("project");
    expect(find(listing, "beta")?.source).toBe("global");
  });

  it("4) neither: empty listing, no throw, and discovery never creates the project root", () => {
    const layers: SourceLayer[] = readLayers(ws, input);
    expect(listSkills(layers)).toEqual({ skills: [], rejected: [] });
    expect(existsSync(projectSourceRoot(ws))).toBe(false);
  });
});
