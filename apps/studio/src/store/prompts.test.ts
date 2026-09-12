import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_SECTIONS, TOOL_ACCESS_VARIANTS, builtinRowsFor } from "./builtin-sections.js";
import { SESSION_MODES } from "./mode.js";
import { assembleSystemPrompt, resolveActivePrompt, toPromptVars } from "./prompts-compose.js";
import { PromptsStore } from "./prompts.js";
import { PROMPT_MAX_LEN, renderTemplate, validateTemplate } from "./prompts-template.js";

let root: string;
let globalFile: string;
let wsPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prompts-"));
  globalFile = join(root, "prompts.json");
  wsPath = join(root, "ws");
  mkdirSync(wsPath);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function store(): PromptsStore {
  return new PromptsStore(globalFile);
}

const VARS = toPromptVars({
  model: "m-1",
  provider: "Gateway",
  base_url: "http://x/v1",
  workspace: "ws",
  workspace_dir: "/tmp/ws",
  session: "ws/s1",
  tools: "read_file, write_file",
  context_window: 1_000_000,
  max_output_tokens: null,
  date: "2026-09-10",
});

describe("prompt templates", () => {
  it("accepts the 10 frozen builtin sections", () => {
    expect(BUILTIN_SECTIONS).toHaveLength(10);
    for (const s of BUILTIN_SECTIONS) expect(validateTemplate(s.template), s.id).toBeNull();
    expect(BUILTIN_SECTIONS.map((s) => s.order)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  it("reports the three frozen template errors", () => {
    expect(validateTemplate("ok {{model}}")).toBeNull();
    expect(validateTemplate("{{nope}}")).toEqual({ error: "undefined prompt variable '{{nope}}'" });
    expect(validateTemplate("half {{model")).toEqual({ error: "unclosed '{{' in template" });
    expect(validateTemplate("x".repeat(PROMPT_MAX_LEN + 1))).toEqual({ error: `template exceeds the ${PROMPT_MAX_LEN} byte cap (${PROMPT_MAX_LEN + 1} bytes)` });
  });

  it("interpolates {{var}} and renders a missing value as empty", () => {
    expect(renderTemplate("m={{model}} w={{workspace}} x={{max_output_tokens}}", VARS)).toBe("m=m-1 w=ws x=");
  });
});

describe("prompts registry", () => {
  it("round-trips an upsert to disk and back", () => {
    const s = store();
    expect(s.upsert(s.scopeGlobal(), { id: "p-1", name: "P1", section_overrides: { identity: "custom {{model}}" }, is_default: true })).toEqual({
      ok: true,
      value: { id: "p-1", scope: "global", hot_applied: true },
    });
    const raw = JSON.parse(readFileSync(globalFile, "utf8")) as { prompts: unknown[]; default_prompt: unknown };
    expect(raw.prompts).toHaveLength(1);
    const reread = store().read(store().scopeGlobal());
    expect(reread.prompts[0]).toEqual({ id: "p-1", name: "P1", section_overrides: { identity: "custom {{model}}" }, is_default: true });
  });

  it("lists builtin + overridden sections with their source and the default chain", () => {
    // Both registry files hand-written, the way production files look: a
    // SECTION row carries the template, a PROMPT row carries the overrides.
    writeFileSync(
      globalFile,
      JSON.stringify({
        sections: [{ id: "identity", name: "Identity", template: "global identity", order: 100 }],
        prompts: [{ id: "p-1", name: "P1", section_overrides: {}, is_default: true }],
        default_prompt: "p-1",
      }),
    );
    writeFileSync(
      join(wsPath, ".celestea-prompts.json"),
      JSON.stringify({
        sections: [{ id: "environment", name: "Environment", template: "ws env", order: 200 }],
        prompts: [{ id: "p-1", name: "WS P1", section_overrides: {}, is_default: true }],
        default_prompt: "p-1",
      }),
    );
    const s = store();
    const globalList = s.list(s.scopeGlobal(), null);
    expect(globalList.scope).toBe("global");
    expect(globalList.global_file).toBe(globalFile);
    expect(globalList.sections).toHaveLength(10);
    expect(globalList.sections[0]).toMatchObject({ id: "identity", source: "global", template: "global identity" });
    expect(globalList.sections[1]).toMatchObject({ id: "environment", source: "builtin" });
    expect(globalList.prompts.map((p) => [p.id, p.scope, p.shadowed])).toEqual([["p-1", "global", false]]);
    expect(globalList.default_prompt).toEqual({ id: "p-1", scope: "global" });

    const wsList = s.list(s.scopeWorkspace("ws", wsPath), null);
    expect(wsList.scope).toBe("workspace");
    expect(wsList.workspace).toBe("ws");
    expect(wsList.sections.find((x) => x.id === "environment")).toMatchObject({ source: "workspace", template: "ws env" });
    expect(wsList.prompts.map((p) => [p.id, p.scope, p.shadowed])).toEqual([
      ["p-1", "global", true],
      ["p-1", "workspace", false],
    ]);
    expect(wsList.default_prompt).toEqual({ id: "p-1", scope: "workspace" });
  });

  it("validates the id and every override template before writing", () => {
    const s = store();
    expect(s.upsert(s.scopeGlobal(), { id: "bad id", name: "x" })).toEqual({ ok: false, status: 400, error: "prompt id must be 1-128 chars of [A-Za-z0-9._-]" });
    expect(s.upsert(s.scopeGlobal(), { id: "p", name: "x", section_overrides: { identity: "{{nope}}" } })).toEqual({
      ok: false,
      status: 400,
      error: "section 'identity': undefined prompt variable '{{nope}}'",
    });
    expect(existsSync(globalFile)).toBe(false);
  });

  it("clears the other is_default flags inside the same scope", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "a", name: "A", is_default: true });
    s.upsert(s.scopeGlobal(), { id: "b", name: "B", is_default: true });
    expect(s.read(s.scopeGlobal()).prompts.map((p) => [p.id, p.is_default])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("deletes a prompt and clears the default pointer", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "a", name: "A", is_default: true });
    s.setDefault(s.scopeGlobal(), "a");
    expect(s.remove(s.scopeGlobal(), "ghost")).toEqual({ ok: false, status: 404, error: "unknown prompt 'ghost'" });
    expect(s.remove(s.scopeGlobal(), "a")).toEqual({ ok: true, value: { scope: "global", hot_applied: true } });
    expect(s.read(s.scopeGlobal()).default_prompt).toBeNull();
  });

  it("degrades a malformed registry file to an empty one instead of throwing", () => {
    writeFileSync(globalFile, "{broken");
    expect(store().read(store().scopeGlobal())).toEqual({ sections: [], prompts: [], default_prompt: null });
  });
});

describe("build_gen assembly", () => {
  it("joins sections with a blank line in (order,id) order and drops empty ones", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "p-extra", name: "Extra", section_overrides: { extra: "APPENDED {{model}}", blank: "   " } });
    const out = assembleSystemPrompt(s, s.scopeGlobal(), "p-extra", VARS);
    for (const section of BUILTIN_SECTIONS) {
      if (section.template.trim() === "") continue;
      expect(out, section.id).toContain(renderTemplate(section.template, VARS).trim().slice(0, 40));
    }
    expect(out).toContain("APPENDED m-1");
    expect(out).not.toContain("Blank");
    expect(out.indexOf("APPENDED m-1")).toBeGreaterThan(out.indexOf("Celestea engine"));
  });

  it("applies the bound prompt's overrides last and truncates to the byte cap", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "p", name: "P", section_overrides: { identity: "BOUND" } });
    const out = assembleSystemPrompt(s, s.scopeGlobal(), "p", VARS);
    expect(out.startsWith("BOUND")).toBe(true);
    const huge = store();
    huge.upsert(huge.scopeGlobal(), { id: "big", name: "Big", section_overrides: { big: "x".repeat(9000) } });
    expect(Buffer.byteLength(assembleSystemPrompt(huge, huge.scopeGlobal(), "big", VARS), "utf8")).toBeLessThanOrEqual(PROMPT_MAX_LEN);
  });

  it("resolves active_prompt through the session binding and the scope default", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "bound", name: "B" });
    s.upsert(s.scopeGlobal(), { id: "fallback", name: "F", is_default: true });
    s.setDefault(s.scopeGlobal(), "fallback");
    expect(resolveActivePrompt(s, s.scopeGlobal(), "bound")).toBe("bound");
    expect(resolveActivePrompt(s, s.scopeGlobal(), "gone")).toBeNull();
    expect(resolveActivePrompt(s, s.scopeGlobal(), null)).toBe("fallback");
  });
});

describe("W729 tool_access variants (P0, §1.3)", () => {
  it("M4: picks variant A for standard and variant B for execution, both with {{tools}}", () => {
    const s = store();
    const standard = assembleSystemPrompt(s, s.scopeGlobal(), null, VARS, "standard");
    const execution = assembleSystemPrompt(s, s.scopeGlobal(), null, VARS, "execution");

    expect(standard).toContain("stepping through the tools one at a time is the normal path here");
    expect(standard).not.toContain("Execution mode");
    expect(standard).not.toContain("ToolCallError");

    expect(execution).toContain("Execution mode — prefer one program over many round trips");
    expect(execution).toContain("ToolCallError");
    expect(execution).toContain("≤20 sub-calls");
    expect(execution).not.toBe(standard);

    // Both expand the SAME variable with the tools the caller passed in (S2).
    for (const out of [standard, execution]) expect(out).toContain(`call tools directly (${VARS.tools})`);
    // The hardcoded name list is gone: the list can only come from {{tools}}.
    expect(execution).not.toContain("(read_file / write_file / list_dir");
  });

  it("M13/K6: the registry stays 10 rows in both modes and every variant validates", () => {
    expect(BUILTIN_SECTIONS).toHaveLength(10);
    expect(BUILTIN_SECTIONS.map((s) => s.order)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    for (const mode of SESSION_MODES) {
      const rows = builtinRowsFor(mode);
      expect(rows).toHaveLength(10);
      expect(rows.map((r) => r.order)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
      for (const row of rows) expect(validateTemplate(row.template), `${mode}:${row.id}`).toBeNull();
    }
    // Only `tool_access` differs between the two modes.
    const diff = builtinRowsFor("standard").filter((row, i) => row.template !== builtinRowsFor("execution")[i]?.template);
    expect(diff.map((r) => r.id)).toEqual(["tool_access"]);
  });

  it("M6: both variants fit the byte budget (cap and the ~1 KB soft guard)", () => {
    const s = store();
    for (const mode of SESSION_MODES) {
      const out = assembleSystemPrompt(s, s.scopeGlobal(), null, VARS, mode);
      expect(Buffer.byteLength(out, "utf8"), mode).toBeLessThanOrEqual(PROMPT_MAX_LEN);
    }
    // Frozen byte sizes: A shrinks the old text by ~264 B, B grows it by ~451 B.
    expect(Buffer.byteLength(TOOL_ACCESS_VARIANTS.standard, "utf8")).toBe(353);
    expect(Buffer.byteLength(TOOL_ACCESS_VARIANTS.execution, "utf8")).toBe(1068);
  });

  it("R4: a user override of tool_access still wins over the mode variant", () => {
    const s = store();
    s.upsert(s.scopeGlobal(), { id: "fixed", name: "Fixed", section_overrides: { tool_access: "OVERRIDDEN {{tools}}" } });
    const out = assembleSystemPrompt(s, s.scopeGlobal(), "fixed", VARS, "execution");
    expect(out).toContain("OVERRIDDEN read_file, write_file");
    expect(out).not.toContain("Execution mode");
  });

  it("spells the mode vocabulary exactly once (parseMode/effectiveMode)", () => {
    expect(SESSION_MODES).toEqual(["standard", "execution"]);
    expect(assembleSystemPrompt(store(), store().scopeGlobal(), null, VARS, "execution")).toContain("Execution mode");
    expect(assembleSystemPrompt(store(), store().scopeGlobal(), null, VARS)).toContain("the normal path here");
  });
});
