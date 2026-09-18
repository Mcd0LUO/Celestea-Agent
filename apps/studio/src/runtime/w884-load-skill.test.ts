/**
 * W884 — end-to-end skill progressive disclosure over the REAL engine.
 *
 * A throwaway CELESTEA_HOME + throwaway workspace (never production :3777):
 *   1. a project-level SKILL.md is announced in the per-turn catalog (durable
 *      user-role history, name + description only — no body);
 *   2. `load_skill('demo')` runs through the real registry/guard and returns the
 *      SKILL.md BODY plus its directory, never the referenced child file;
 *   3. the project layer wins over the global one;
 *   4. an invalid frontmatter surfaces the readable structured error;
 *   5. a workspace without skills injects NOTHING (zero cost).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { StudioHarness } from "../harness.test-util.js";
import { activate, makeEngineHarness, readSessionLog, runTurnWithFrames } from "./test-util.js";

const WORKSPACE = "sample-ws";
const SESSION = WORKSPACE + "/s1";
const CATALOG_MARK = "Skills available in this workspace";

interface Row {
  type?: string;
  id?: string;
  text?: string;
  value?: unknown;
  error?: string | null;
}

const homes: string[] = [];
const harnesses: StudioHarness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A fresh temp CELESTEA_HOME (outside the harness root, so cleanup is explicit). */
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "w884-home-"));
  homes.push(home);
  return home;
}

/** Plant `<layerRoot>/skills/<name>/SKILL.md`; returns the skill directory. */
function plantSkill(layerRoot: string, name: string, frontmatter: string[], body: string): string {
  const dir = join(layerRoot, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
  return dir;
}

function engine(home: string, script: unknown[]): StudioHarness {
  const h = makeEngineHarness({
    sessions: { s1: [] },
    env: { CELESTEA_HOME: home },
    // structuredClone: the offline LLM CONSUMES its script array (shift), so a
    // shared literal would leak between tests.
    llm: { script: structuredClone(script) as never },
  });
  harnesses.push(h);
  return h;
}

function rowsOf(h: StudioHarness): Row[] {
  return readSessionLog(h, "s1")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
}

const userTexts = (rows: Row[]): string[] => rows.filter((r) => r.type === "user_message").map((r) => String(r.text));
const catalog = (rows: Row[]): string => userTexts(rows).find((t) => t.includes(CATALOG_MARK)) ?? "";
const loadResult = (rows: Row[]): { name: string; source: string; dir: string; body: string } =>
  rows.find((r) => r.type === "tool_result" && r.id === "c1")?.value as { name: string; source: string; dir: string; body: string };

const CALL_DEMO = [{ tool_calls: [{ id: "c1", name: "load_skill", args: { name: "demo" } }] }, { text: "done" }];

describe("W884 · skill catalog + load_skill over the real engine", () => {
  it("announces the catalog and loads the body without inlining the child file", async () => {
    const home = newHome();
    const h = engine(home, CALL_DEMO);
    // read-only permission baseline: it only denies write_file, so load_skill
    // (a pure read) must stay available.
    mkdirSync(join(h.workspace, "s1"), { recursive: true });
    writeFileSync(join(h.workspace, "s1", "permission.json"), JSON.stringify({ version: 1, session: SESSION, preset: "read-only", updated_at: 0 }));
    const dir = plantSkill(
      join(h.workspace, ".celestea"),
      "demo",
      ["name: demo", "description: Use this skill whenever the user asks for a demo."],
      "DEMO BODY LINE\nread reference.md",
    );
    writeFileSync(join(dir, "reference.md"), "SECRET CHILD CONTENT");

    await activate(h, SESSION);
    await runTurnWithFrames(h, "please do the demo task");
    const rows = rowsOf(h);

    const text = catalog(rows);
    expect(text).toContain("- demo: Use this skill whenever the user asks for a demo.");
    expect(text).toContain("load_skill");
    expect(text).not.toContain("DEMO BODY LINE");
    expect(text).not.toContain("SECRET CHILD CONTENT");

    const value = loadResult(rows);
    expect(value.source).toBe("project");
    expect(value.dir).toBe(join(h.workspace, ".celestea", "skills", "demo"));
    expect(value.body).toContain("DEMO BODY LINE");
    expect(value.body).toContain("read reference.md");
    expect(JSON.stringify(value)).not.toContain("SECRET CHILD CONTENT");
  });

  it("lets the project layer win over the global layer", async () => {
    const home = newHome();
    const h = engine(home, CALL_DEMO);
    plantSkill(join(home, "workspaces", WORKSPACE), "demo", ["name: demo", "description: GLOBAL description"], "GLOBAL BODY");
    plantSkill(join(h.workspace, ".celestea"), "demo", ["name: demo", "description: PROJECT description"], "PROJECT BODY");

    await activate(h, SESSION);
    await runTurnWithFrames(h, "demo please");
    const rows = rowsOf(h);

    const text = catalog(rows);
    expect(text).toContain("PROJECT description");
    expect(text).not.toContain("GLOBAL description");
    expect(loadResult(rows).source).toBe("project");
    expect(loadResult(rows).body).toBe("PROJECT BODY");
  });

  it("surfaces an invalid frontmatter as a readable structured error", async () => {
    const home = newHome();
    const h = engine(home, [{ tool_calls: [{ id: "c1", name: "load_skill", args: { name: "broken" } }] }, { text: "done" }]);
    plantSkill(join(h.workspace, ".celestea"), "broken", ["name: broken", "description: ok", "version: 1.0"], "BODY");

    await activate(h, SESSION);
    await runTurnWithFrames(h, "load broken");
    const rows = rowsOf(h);

    expect(catalog(rows)).not.toContain("broken");
    const result = rows.find((r) => r.type === "tool_result" && r.id === "c1");
    expect(String(result?.error)).toContain("load_skill: code=invalid_skill");
    expect(String(result?.error)).toContain("unknown frontmatter key");
  });

  it("injects nothing at all when the workspace has no skill", async () => {
    const home = newHome();
    const h = engine(home, [{ text: "hi" }]);
    await activate(h, SESSION);
    await runTurnWithFrames(h, "hello");
    const rows = rowsOf(h);
    expect(userTexts(rows).some((t) => t.includes(CATALOG_MARK))).toBe(false);
    expect(userTexts(rows)).toContain("hello");
  });
});
