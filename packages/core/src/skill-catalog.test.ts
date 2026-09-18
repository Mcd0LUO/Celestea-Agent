/**
 * W884 — the skill catalog: the resident half of progressive disclosure.
 *
 * Pins the three cost rules the injection depends on: no skills => no text at
 * all; a long description is clipped at 200 characters; more than 32 skills are
 * listed name-sorted with the omitted count stated.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_CATALOG_DESCRIPTION_MAX, SKILL_CATALOG_MAX, renderSkillCatalog, skillCatalogOf } from "./skill-catalog.js";
import type { SkillDefinition, SkillListing } from "./skills.js";

function skill(name: string, description: string): SkillDefinition {
  const dir = "/ws/.celestea/skills/" + name;
  return { name, description, license: null, allowedTools: [], compatibility: null, metadata: {}, source: "project", dir, file: join(dir, "SKILL.md") };
}

function listing(skills: SkillDefinition[]): SkillListing {
  return { skills, rejected: [] };
}

function plant(root: string, name: string, description: string): void {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", "name: " + name, "description: " + description, "---", "BODY"].join("\n"));
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w884-catalog-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("W884 · skill catalog text", () => {
  it("injects NOTHING when there is no skill (zero cost)", () => {
    expect(renderSkillCatalog(listing([]))).toBeNull();
  });

  it("lists name + description only, with the load_skill instruction", () => {
    const text = renderSkillCatalog(listing([skill("alpha", "First skill."), skill("beta", "Second skill.")]));
    expect(text).not.toBeNull();
    expect(text).toContain("- alpha: First skill.");
    expect(text).toContain("- beta: Second skill.");
    expect(text).toContain("load_skill");
    expect(text).toContain("read_file");
    expect(text).not.toContain("BODY");
  });

  it("clips a description at exactly 200 characters and marks the cut", () => {
    const long = "x".repeat(SKILL_CATALOG_DESCRIPTION_MAX + 40);
    const text = renderSkillCatalog(listing([skill("long", long)])) ?? "";
    expect(text).toContain("- long: " + "x".repeat(SKILL_CATALOG_DESCRIPTION_MAX) + "…");
    expect(text).not.toContain(long);
  });

  it("caps the listing at 32 name-sorted entries and states the omission", () => {
    const skills = Array.from({ length: SKILL_CATALOG_MAX + 3 }, (_, i) => skill("s" + String(i).padStart(2, "0"), "d" + i));
    const text = renderSkillCatalog(listing(skills)) ?? "";
    expect(text).toContain("- s00: d0");
    expect(text).toContain("- s31: d31");
    expect(text).not.toContain("- s32: d32");
    expect(text).toContain("(+3 more skills not listed");
  });

  it("resolves the two layers, project wins (skillCatalogOf)", () => {
    const ws = join(root, "ws");
    const home = join(root, "home");
    mkdirSync(ws, { recursive: true });
    plant(join(ws, ".celestea"), "demo", "PROJECT description");
    plant(join(home, "workspaces", "ws"), "demo", "GLOBAL description");
    const text = skillCatalogOf(ws, { env: { CELESTEA_HOME: home } });
    expect(text).toContain("PROJECT description");
    expect(text).not.toContain("GLOBAL description");
  });
});
