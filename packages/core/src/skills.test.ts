/**
 * W882 acceptance — the SKILL.md frontmatter contract (whitelist + limits) and
 * progressive disclosure (body only, no child resources).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CelesteaHomeInput } from "./celestea-home.js";
import { readLayers } from "./celestea-sources.js";
import { loadSkillBody, listSkills, parseSkillFrontmatter, type SkillIo } from "./skills.js";

const PDF_DESCRIPTION =
  "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text or tables from PDFs, combining or merging them, splitting them apart, rotating pages, adding watermarks, creating new PDFs, filling in forms, and encrypting or decrypting PDFs. If the user mentions a .pdf file or asks to produce one, use this skill.";

const PDF_FRONTMATTER = [
  "name: pdf",
  "description: " + PDF_DESCRIPTION,
  "license: Complete terms in LICENSE.txt",
  "allowed-tools: Read Write",
  "compatibility: Works with Node 18+",
  "metadata:",
  "  author: anthropics",
];

let root: string;
let ws: string;
let home: string;
let input: CelesteaHomeInput;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w882-skills-"));
  ws = join(root, "sample-ws");
  home = join(root, "data");
  mkdirSync(ws, { recursive: true });
  input = { env: { CELESTEA_HOME: home } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function skillText(frontmatter: string[], body = "BODY LINE"): string {
  return ["---", ...frontmatter, "---", body].join("\n");
}

function plant(name: string, frontmatter: string[], body = "BODY LINE"): string {
  const dir = join(ws, ".celestea", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillText(frontmatter, body));
  return dir;
}

function rejectReason(name: string, frontmatter: string[]): string {
  plant(name, frontmatter);
  const listing = listSkills(readLayers(ws, input));
  const hit = listing.rejected.find((r) => r.name === name);
  expect(hit).toBeDefined();
  expect(listing.skills.find((s) => s.name === name)).toBeUndefined();
  return hit?.reason ?? "";
}

describe("W882 · frontmatter positive (anthropics/skills pdf shape)", () => {
  it("parses the whitelist fields and returns the body", () => {
    const parsed = parseSkillFrontmatter(skillText(PDF_FRONTMATTER));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.name).toBe("pdf");
    expect(parsed.data.description).toBe(PDF_DESCRIPTION);
    expect(parsed.data.license).toBe("Complete terms in LICENSE.txt");
    expect(parsed.data.allowedTools).toEqual(["Read", "Write"]);
    expect(parsed.data.compatibility).toBe("Works with Node 18+");
    expect(parsed.data.metadata).toEqual({ author: "anthropics" });
    expect(parsed.body.trim()).toBe("BODY LINE");
  });

  it("lists a valid project skill with source=project", () => {
    plant("pdf", PDF_FRONTMATTER);
    const listing = listSkills(readLayers(ws, input));
    expect(listing.rejected).toEqual([]);
    expect(listing.skills).toHaveLength(1);
    expect(listing.skills[0]?.source).toBe("project");
    expect(listing.skills[0]?.file).toBe(join(ws, ".celestea", "skills", "pdf", "SKILL.md"));
  });
});

describe("W882 · progressive disclosure", () => {
  it("loadSkillBody returns the body only — child resources are never inlined", () => {
    const dir = plant("pdf", PDF_FRONTMATTER, "Read references/pdf.md before editing.");
    writeFileSync(join(dir, "reference.md"), "SECRET CHILD CONTENT");
    const loaded = loadSkillBody(readLayers(ws, input), "pdf");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.body).not.toContain("name: pdf");
    expect(loaded.body).not.toContain("SECRET CHILD CONTENT");
    expect(loaded.body).toContain("Read references/pdf.md");
  });

  it("loadSkillBody refuses a path-traversal name and reports unknown names", () => {
    expect(loadSkillBody(readLayers(ws, input), "../pdf")).toMatchObject({ ok: false });
    expect(loadSkillBody(readLayers(ws, input), "nope")).toEqual({ ok: false, error: "unknown skill 'nope'" });
  });
});

describe("W882 · frontmatter negatives (each REJECTED with a readable reason)", () => {
  it("unknown key", () => {
    const reason = rejectReason("pdf", ["name: pdf", "description: " + PDF_DESCRIPTION, "version: 1.0"]);
    expect(reason).toMatch(/unknown frontmatter key/);
    expect(reason).toContain("version");
    expect(reason).toContain("allowed:");
  });

  it("name does not match the directory name", () => {
    const reason = rejectReason("pdf", ["name: pdfs", "description: " + PDF_DESCRIPTION]);
    expect(reason).toContain("does not match directory name 'pdf'");
  });

  it("missing description", () => {
    const reason = rejectReason("pdf", ["name: pdf"]);
    expect(reason).toMatch(/missing required frontmatter key 'description'/);
  });

  it("description longer than 1024 chars", () => {
    const reason = rejectReason("pdf", ["name: pdf", "description: " + "x".repeat(1025)]);
    expect(reason).toContain("description is 1025 chars; max 1024");
  });

  it("description containing angle brackets", () => {
    const reason = rejectReason("pdf", ["name: pdf", "description: Use <pdf> files"]);
    expect(reason).toMatch(/angle brackets/);
  });

  it("name outside ^[a-z0-9-]+$ and longer than 64 chars", () => {
    expect(rejectReason("PDF", ["name: PDF", "description: ok"])).toMatch(/must match/);
    const longName = "a".repeat(65);
    expect(rejectReason(longName, ["name: " + longName, "description: ok"])).toContain("max 64");
  });

  it("compatibility longer than 500 chars", () => {
    const reason = rejectReason("pdf", ["name: pdf", "description: ok", "compatibility: " + "c".repeat(501)]);
    expect(reason).toContain("compatibility is 501 chars; max 500");
  });
});

describe("W882 · structural parse errors", () => {
  it("rejects a file without frontmatter or without a closing delimiter", () => {
    expect(parseSkillFrontmatter("no frontmatter")).toMatchObject({ ok: false });
    const torn = parseSkillFrontmatter("---\nname: pdf\n");
    expect(torn.ok).toBe(false);
    if (torn.ok) return;
    expect(torn.error).toContain("closing");
  });

  it("listSkills works over the injected SkillIo (no filesystem)", () => {
    const files = new Map<string, string>();
    // W892: the product joins with the HOST separator, so the fixture must too.
    const skillsDir = join("/proj", "skills");
    files.set(join(skillsDir, "pdf", "SKILL.md"), skillText(PDF_FRONTMATTER));
    const io: SkillIo = {
      listDirectories: (dir) => (dir === skillsDir ? ["pdf"] : []),
      readText: (file) => files.get(file) ?? null,
    };
    const listing = listSkills([{ source: "project", root: "/proj" }], io);
    expect(listing.skills.map((s) => s.name)).toEqual(["pdf"]);
    expect(listing.skills[0]?.source).toBe("project");
  });
});
