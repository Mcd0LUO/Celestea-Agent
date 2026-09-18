/**
 * W882 — skill discovery over the two-layer source model (celestea-sources.ts).
 *
 * A "skill" is a directory skills/<name>/SKILL.md. The file starts with YAML
 * frontmatter; the rest is the BODY. Discovery is a pure walk over the layers
 * [project, global] (project WINS on a name collision). Parsing is a pure
 * function; the filesystem lives behind the tiny SkillIo seam so the parser and
 * the precedence rules are unit-testable without touching disk.
 *
 * Frontmatter contract (mirrors anthropics/skills):
 *   - whitelist: name / description / license / allowed-tools / compatibility /
 *     metadata. ANY unknown key REJECTS the skill with a readable reason.
 *   - name must equal the directory name, match ^[a-z0-9-]+$ and be <= 64 chars.
 *   - description is REQUIRED, <= 1024 chars, and must not contain < or >.
 *     Write it as a TRIGGER sentence ("Use this skill whenever ...").
 *   - compatibility <= 500 chars.
 *
 * Progressive disclosure: loadSkillBody() returns the SKILL.md BODY ONLY. A
 * skill's child resources (references/, scripts/) are NEVER auto-loaded; the
 * model must explicitly read them. W882 adds NO tool and does NOT inject any
 * skill text into a prompt — this module is discovery + lookup only.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SKILL_FILE_NAME, SKILLS_SUBDIR, type SourceLayer, type SourceName } from "./celestea-sources.js";

/** Allowed name shape. */
export const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
/** name <= 64 chars. */
export const SKILL_NAME_MAX = 64;
/** description <= 1024 chars. */
export const SKILL_DESCRIPTION_MAX = 1024;
/** compatibility <= 500 chars. */
export const SKILL_COMPATIBILITY_MAX = 500;
/** The ONLY frontmatter keys a skill may declare. */
export const SKILL_FRONTMATTER_KEYS = ["name", "description", "license", "allowed-tools", "compatibility", "metadata"] as const;

export type SkillMetadata = Record<string, string>;

export interface ParsedSkillFrontmatter {
  name: string | null;
  description: string | null;
  license: string | null;
  allowedTools: string[];
  compatibility: string | null;
  metadata: SkillMetadata;
}

export interface SkillDefinition extends ParsedSkillFrontmatter {
  name: string;
  description: string;
  source: SourceName;
  dir: string;
  file: string;
}

export interface SkillLocation {
  name: string;
  dir: string;
  file: string;
  source: SourceName;
}

export interface SkillRejection extends SkillLocation {
  reason: string;
}

export interface SkillListing {
  skills: SkillDefinition[];
  rejected: SkillRejection[];
}

export type FrontmatterParse =
  | { ok: true; data: ParsedSkillFrontmatter; body: string }
  | { ok: false; error: string };

export type SkillValidation = { ok: true; skill: SkillDefinition } | { ok: false; reason: SkillRejection };

export type SkillLoad = { ok: true; skill: SkillDefinition; body: string } | { ok: false; error: string };

/** The thin filesystem seam: the only impure surface of this module. */
export interface SkillIo {
  listDirectories(dir: string): string[];
  readText(file: string): string | null;
}

/** Real filesystem; every error (missing root, missing file) reads as "absent". */
export const nodeSkillIo: SkillIo = {
  listDirectories(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  },
  readText(file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
};

const ALLOWED_KEYS: ReadonlySet<string> = new Set<string>(SKILL_FRONTMATTER_KEYS);
const FRONTMATTER_DELIMITER = "---";

interface MutableFrontmatter {
  scalars: Record<string, string>;
  allowedTools: string[];
  metadata: SkillMetadata;
  unknown: string[];
}

function newFrontmatter(): MutableFrontmatter {
  return { scalars: {}, allowedTools: [], metadata: {}, unknown: [] };
}

function unquote(value: string): string {
  const t = value.trim();
  const first = t.charAt(0);
  const last = t.charAt(t.length - 1);
  if (t.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitListValue(value: string): string[] {
  const t = value.trim();
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  return inner.split(/[,\s]+/).map(unquote).filter((s) => s !== "");
}

function applyTopLevel(fm: MutableFrontmatter, key: string, value: string): string | null {
  if (key === "metadata") return null;
  if (key === "allowed-tools") {
    if (value !== "") fm.allowedTools = splitListValue(value);
    return null;
  }
  if (value !== "") fm.scalars[key] = unquote(value);
  return null;
}

function applyIndented(fm: MutableFrontmatter, currentKey: string | null, trimmed: string): string | null {
  if (currentKey === null) return null;
  if (trimmed.startsWith("- ")) {
    if (currentKey === "allowed-tools") fm.allowedTools.push(unquote(trimmed.slice(2)));
    return null;
  }
  if (currentKey === "metadata") {
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return "invalid metadata line '" + trimmed + "'";
    fm.metadata[trimmed.slice(0, colon).trim()] = unquote(trimmed.slice(colon + 1));
    return null;
  }
  return "unsupported frontmatter block under '" + currentKey + "'";
}

function parseBlock(block: string): { fm: MutableFrontmatter } | { error: string } {
  const fm = newFrontmatter();
  let currentKey: string | null = null;
  for (const rawLine of block.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent > 0) {
      const err = applyIndented(fm, currentKey, trimmed);
      if (err !== null) return { error: err };
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return { error: "invalid frontmatter line '" + trimmed + "'" };
    const key = trimmed.slice(0, colon).trim();
    if (!ALLOWED_KEYS.has(key)) {
      fm.unknown.push(key);
      currentKey = null;
      continue;
    }
    currentKey = key;
    const err = applyTopLevel(fm, key, trimmed.slice(colon + 1).trim());
    if (err !== null) return { error: err };
  }
  return { fm };
}

function toParsed(fm: MutableFrontmatter): ParsedSkillFrontmatter {
  return {
    name: fm.scalars["name"] ?? null,
    description: fm.scalars["description"] ?? null,
    license: fm.scalars["license"] ?? null,
    allowedTools: fm.allowedTools,
    compatibility: fm.scalars["compatibility"] ?? null,
    metadata: fm.metadata,
  };
}

/**
 * Parse the leading YAML frontmatter of a SKILL.md. PURE. Returns the parsed
 * whitelist fields plus the body (everything after the closing delimiter). An
 * unknown key is an ERROR, never silently ignored.
 */
export function parseSkillFrontmatter(text: string): FrontmatterParse {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== FRONTMATTER_DELIMITER) {
    return { ok: false, error: "missing YAML frontmatter: file must start with '---'" };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === FRONTMATTER_DELIMITER) {
      close = i;
      break;
    }
  }
  if (close === -1) return { ok: false, error: "missing closing '---' frontmatter delimiter" };
  const block = parseBlock(lines.slice(1, close).join("\n"));
  if ("error" in block) return { ok: false, error: block.error };
  const { fm } = block;
  if (fm.unknown.length > 0) {
    return {
      ok: false,
      error: "unknown frontmatter key(s): " + fm.unknown.join(", ") + " (allowed: " + SKILL_FRONTMATTER_KEYS.join(", ") + ")",
    };
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n/, "");
  return { ok: true, data: toParsed(fm), body };
}

function reject(location: SkillLocation, reason: string): SkillValidation {
  return { ok: false, reason: { ...location, reason } };
}

/**
 * Validate the parsed frontmatter against the anthropics/skills contract.
 * location.name is the DIRECTORY name; the frontmatter name must equal it.
 */
export function validateSkill(data: ParsedSkillFrontmatter, location: SkillLocation): SkillValidation {
  const name = data.name;
  if (name === null || name === "") return reject(location, "missing required frontmatter key 'name'");
  if (name !== location.name) {
    return reject(location, "frontmatter name '" + name + "' does not match directory name '" + location.name + "'");
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return reject(location, "name '" + name + "' must match " + String(SKILL_NAME_PATTERN) + " (lowercase letters, digits, hyphens)");
  }
  if (name.length > SKILL_NAME_MAX) return reject(location, "name is " + name.length + " chars; max " + SKILL_NAME_MAX);
  const description = data.description;
  if (description === null || description === "") return reject(location, "missing required frontmatter key 'description'");
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return reject(location, "description is " + description.length + " chars; max " + SKILL_DESCRIPTION_MAX);
  }
  if (/[<>]/.test(description)) return reject(location, "description must not contain angle brackets '<' or '>'");
  const compatibility = data.compatibility;
  if (compatibility !== null && compatibility.length > SKILL_COMPATIBILITY_MAX) {
    return reject(location, "compatibility is " + compatibility.length + " chars; max " + SKILL_COMPATIBILITY_MAX);
  }
  return { ok: true, skill: { ...data, name, description, source: location.source, dir: location.dir, file: location.file } };
}

function candidateOf(layer: SourceLayer, name: string): SkillLocation {
  const dir = join(layer.root, SKILLS_SUBDIR, name);
  return { name, dir, file: join(dir, SKILL_FILE_NAME), source: layer.source };
}

function acceptCandidate(location: SkillLocation, text: string): { skill: SkillDefinition; body: string } | { reason: string } {
  const parsed = parseSkillFrontmatter(text);
  if (!parsed.ok) return { reason: parsed.error };
  const valid = validateSkill(parsed.data, location);
  if (!valid.ok) return { reason: valid.reason.reason };
  return { skill: valid.skill, body: parsed.body };
}

/**
 * Discover every skill in the layers, HIGHEST PRIORITY FIRST. The first layer to
 * define a name wins; a lower layer is not even parsed for that name. A rejected
 * project skill therefore shadows (and does not fall back to) a global one, so a
 * broken override is visible instead of silent. Absent roots are not an error.
 */
export function listSkills(layers: readonly SourceLayer[], io: SkillIo = nodeSkillIo): SkillListing {
  const winners = new Map<string, SkillDefinition>();
  const rejected: SkillRejection[] = [];
  const claimed = new Set<string>();
  for (const layer of layers) {
    const names = io.listDirectories(join(layer.root, SKILLS_SUBDIR)).slice().sort();
    for (const name of names) {
      if (claimed.has(name)) continue;
      const location = candidateOf(layer, name);
      const text = io.readText(location.file);
      if (text === null) continue;
      claimed.add(name);
      const outcome = acceptCandidate(location, text);
      if ("skill" in outcome) winners.set(name, outcome.skill);
      else rejected.push({ ...location, reason: outcome.reason });
    }
  }
  const skills = [...winners.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills, rejected };
}

/**
 * The BODY of one named skill, from the first layer that defines it. Returns the
 * SKILL.md body only — child resources are never auto-loaded (progressive
 * disclosure). The name must already be a valid skill name (no path traversal).
 */
export function loadSkillBody(layers: readonly SourceLayer[], name: string, io: SkillIo = nodeSkillIo): SkillLoad {
  if (!SKILL_NAME_PATTERN.test(name)) return { ok: false, error: "invalid skill name '" + name + "'" };
  for (const layer of layers) {
    const location = candidateOf(layer, name);
    const text = io.readText(location.file);
    if (text === null) continue;
    const outcome = acceptCandidate(location, text);
    if ("skill" in outcome) return { ok: true, skill: outcome.skill, body: outcome.body };
    return { ok: false, error: "skill '" + name + "' rejected: " + outcome.reason };
  }
  return { ok: false, error: "unknown skill '" + name + "'" };
}
