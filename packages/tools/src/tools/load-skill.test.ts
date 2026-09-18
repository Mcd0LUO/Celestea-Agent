/**
 * W884 — `load_skill` unit tests.
 *
 * The tool is the on-demand half of progressive disclosure: it returns the
 * SKILL.md BODY ONLY (never references/scripts), resolves the two W882 layers
 * with the project layer winning, and answers unknown / invalid / traversing
 * names with a structured error instead of an empty result.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathGuard } from "../guard/path-guard.js";
import { createToolRegistry } from "../registry.js";
import { loadSkillSpec, loadSkillTool, type LoadSkillToolOptions } from "./load-skill.js";

interface LoadedSkill {
  name: string;
  source: string;
  dir: string;
  body: string;
}

let root: string;
let ws: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w884-load-skill-"));
  ws = join(root, "ws");
  home = join(root, "home");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function options(): LoadSkillToolOptions {
  return { workspace: ws, env: { CELESTEA_HOME: home } };
}

/** Plant one skill under a layer root (`<root>/skills/<name>/SKILL.md`). */
function plant(layerRoot: string, name: string, frontmatter: string[], body = "BODY LINE"): string {
  const dir = join(layerRoot, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
  return dir;
}

const project = (name: string, frontmatter: string[], body?: string): string => plant(join(ws, ".celestea"), name, frontmatter, body);
const global = (name: string, frontmatter: string[], body?: string): string => plant(join(home, "workspaces", "ws"), name, frontmatter, body);

async function load(name: string, opts: LoadSkillToolOptions = options()): Promise<LoadedSkill> {
  return (await loadSkillTool(opts).execute({ name })) as LoadedSkill;
}

describe("W884 · load_skill spec", () => {
  it("declares the frozen parameter shape (name required, desc optional)", () => {
    const spec = loadSkillSpec();
    expect(spec.name).toBe("load_skill");
    expect(spec.parameters["type"]).toBe("object");
    expect(spec.parameters["required"]).toEqual(["name"]);
    expect(spec.parameters["additionalProperties"]).toBe(false);
    const properties = spec.parameters["properties"] as Record<string, { type?: string }>;
    expect(properties["name"]?.type).toBe("string");
    expect(properties["desc"]?.type).toBe("string");
    expect(spec.description).toContain("SKILL.md");
    expect(spec.description).toContain("read_file");
  });
});

describe("W884 · load_skill resolution", () => {
  it("returns the SKILL.md body and the winning layer (project beats global)", async () => {
    project("demo", ["name: demo", "description: project"], "PROJECT BODY");
    global("demo", ["name: demo", "description: global"], "GLOBAL BODY");
    const loaded = await load("demo");
    expect(loaded.source).toBe("project");
    expect(loaded.body).toBe("PROJECT BODY");
    expect(loaded.dir).toBe(join(ws, ".celestea", "skills", "demo"));
  });

  it("falls back to the global layer when the project layer has no such skill", async () => {
    global("demo", ["name: demo", "description: global"], "GLOBAL BODY");
    const loaded = await load("demo");
    expect(loaded.source).toBe("global");
    expect(loaded.body).toBe("GLOBAL BODY");
  });

  it("returns the BODY only — references/scripts are never inlined", async () => {
    const dir = project("demo", ["name: demo", "description: project"], "Read reference.md before editing.");
    writeFileSync(join(dir, "reference.md"), "SECRET CHILD CONTENT");
    const loaded = await load("demo");
    expect(loaded.body).toContain("Read reference.md");
    expect(loaded.body).not.toContain("name: demo");
    expect(JSON.stringify(loaded)).not.toContain("SECRET CHILD CONTENT");
  });
});

describe("W884 · load_skill structured errors", () => {
  it("reports an unknown name", async () => {
    await expect(load("nope")).rejects.toThrow(/code=unknown_skill/);
    await expect(load("nope")).rejects.toThrow(/unknown skill 'nope'/);
  });

  it("reports invalid frontmatter with the readable reason (unknown key, name mismatch)", async () => {
    project("demo", ["name: demo", "description: ok", "version: 1.0"]);
    await expect(load("demo")).rejects.toThrow(/code=invalid_skill/);
    await expect(load("demo")).rejects.toThrow(/unknown frontmatter key/);
    rmSync(join(ws, ".celestea", "skills", "demo"), { recursive: true, force: true });

    project("demo", ["name: other", "description: ok"]);
    await expect(load("demo")).rejects.toThrow(/does not match directory name/);
  });

  it("refuses path traversal and other illegal names before touching the disk", async () => {
    for (const name of ["../demo", "a/b", "Demo", "demo.md", ""]) {
      await expect(load(name)).rejects.toThrow(/code=invalid_name/);
    }
  });

  it("refuses a generation without a workspace instead of guessing a path", async () => {
    project("demo", ["name: demo", "description: ok"]);
    await expect(load("demo", { workspace: null, env: { CELESTEA_HOME: home } })).rejects.toThrow(/code=no_workspace/);
  });
});

describe("W884 · load_skill through the pipeline", () => {
  it("passes the schema stage and a read-only path guard (pure read)", async () => {
    project("demo", ["name: demo", "description: ok"], "PIPELINE BODY");
    const registry = createToolRegistry(
      [loadSkillTool(options())],
      [PathGuard.fromEnv({ CELESTEA_HOME: home }, { workspaceWritable: false }, undefined, { workspace: ws })],
    );
    const out = await registry.dispatch({ call_id: "c1", name: "load_skill", args: { name: "demo" } });
    expect(out.error).toBeNull();
    expect(out.decision?.kind).toBe("allow");
    expect((out.value as LoadedSkill).body).toBe("PIPELINE BODY");
  });

  it("keeps the structured error text on the output row", async () => {
    const registry = createToolRegistry([loadSkillTool(options())]);
    const out = await registry.dispatch({ call_id: "c2", name: "load_skill", args: { name: "ghost" } });
    expect(out.value).toBeNull();
    expect(out.error).toContain("load_skill: code=unknown_skill");
  });
});
