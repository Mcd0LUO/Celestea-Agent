/**
 * Prompt registry store — global `prompts.json` + per-workspace
 * `<ws>/.celestea-prompts.json` (`contracts/data-files/prompts.schema.json`,
 * `src/prompts.rs:560-880`).
 *
 * Tolerated-on-read, strict-on-write: a missing OR malformed registry file
 * degrades to an empty one (the registry must never break compose or the UI),
 * while every write validates the id and every override template before the
 * file is touched. There are four registry levels — builtin → global →
 * workspace → the bound prompt's `section_overrides` — and writing is
 * `persist -> hot apply -> roll the file back when the apply fails`.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";
import { badRequest, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { validatePromptId } from "./validate.js";
import { ORDER_FALLBACK, validateTemplate } from "./prompts-template.js";
import { BUILTIN_SECTIONS } from "./builtin-sections.js";

export interface PromptSectionRow {
  id: string;
  name: string;
  template: string;
  order: number;
  source: "builtin" | "global" | "workspace";
}

export interface PromptEntry {
  id: string;
  name: string;
  section_overrides: Record<string, string>;
  is_default: boolean;
}

export interface PromptListEntry extends PromptEntry {
  scope: "global" | "workspace";
  shadowed: boolean;
}

export interface PromptFileData {
  sections: Array<{ id: string; name: string; template: string; order: number }>;
  prompts: PromptEntry[];
  default_prompt: string | null;
}

export interface PromptScope {
  kind: "global" | "workspace";
  workspace: string | null;
  file: string;
}

export interface PromptDefaultRef {
  id: string;
  scope: "global" | "workspace";
}

export interface PromptListResponse {
  ok: true;
  scope: "global" | "workspace";
  workspace: string | null;
  global_file: string;
  sections: PromptSectionRow[];
  prompts: PromptListEntry[];
  default_prompt: PromptDefaultRef | null;
  active_prompt: string | null;
}

export interface PromptUpsertRequest {
  id: string;
  name: string;
  section_overrides?: Record<string, string>;
  is_default?: boolean;
}

const EMPTY: PromptFileData = { sections: [], prompts: [], default_prompt: null };

function parseSections(raw: unknown): PromptFileData["sections"] {
  if (!Array.isArray(raw)) return [];
  const out: PromptFileData["sections"] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const id = rec["id"];
    const template = rec["template"];
    if (typeof id !== "string" || id === "" || typeof template !== "string") continue;
    out.push({
      id,
      name: typeof rec["name"] === "string" ? rec["name"] : id,
      template,
      order: typeof rec["order"] === "number" ? Math.trunc(rec["order"]) : ORDER_FALLBACK,
    });
  }
  return out;
}

function parsePrompts(raw: unknown): PromptEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PromptEntry[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    const id = rec["id"];
    if (typeof id !== "string" || validatePromptId(id) !== null) continue;
    const overrides: Record<string, string> = {};
    const rawOverrides = rec["section_overrides"];
    if (typeof rawOverrides === "object" && rawOverrides !== null) {
      for (const [k, v] of Object.entries(rawOverrides as Record<string, unknown>)) {
        if (typeof v === "string") overrides[k] = v;
      }
    }
    out.push({ id, name: typeof rec["name"] === "string" ? rec["name"] : id, section_overrides: overrides, is_default: rec["is_default"] === true });
  }
  return out;
}

export class PromptsStore {
  constructor(private readonly globalFile: string) {}

  scopeGlobal(): PromptScope {
    return { kind: "global", workspace: null, file: this.globalFile };
  }

  scopeWorkspace(name: string, wsPath: string): PromptScope {
    return { kind: "workspace", workspace: name, file: `${wsPath}/.celestea-prompts.json` };
  }

  /** Tolerant read: missing OR malformed both degrade to an empty registry. */
  read(scope: PromptScope): PromptFileData {
    const out = readJsonIfExists(scope.file);
    if (!out.exists || out.error !== undefined) return { ...EMPTY, sections: [], prompts: [] };
    const rec = (typeof out.value === "object" && out.value !== null ? out.value : {}) as Record<string, unknown>;
    const def = rec["default_prompt"];
    return {
      sections: parseSections(rec["sections"]),
      prompts: parsePrompts(rec["prompts"]),
      default_prompt: typeof def === "string" && def !== "" ? def : null,
    };
  }

  /** Raw file text (the rollback snapshot for a failed hot apply). */
  snapshot(scope: PromptScope): string | null {
    return existsSync(scope.file) ? readFileSync(scope.file, "utf8") : null;
  }

  restore(scope: PromptScope, text: string | null): void {
    if (text === null) return;
    writeJsonAtomic(scope.file, JSON.parse(text) as unknown);
  }

  private persist(scope: PromptScope, data: PromptFileData): StoreResult<void> {
    try {
      writeJsonAtomic(scope.file, data);
      return ok(undefined);
    } catch (e) {
      return fail(500, errText(e));
    }
  }

  find(scope: PromptScope, id: string): PromptEntry | undefined {
    return this.read(scope).prompts.find((p) => p.id === id);
  }

  /** `default_prompt` of this scope, falling back to the global one. */
  defaultFor(scope: PromptScope): PromptDefaultRef | null {
    const own = this.read(scope);
    if (scope.kind === "workspace" && own.default_prompt !== null) return { id: own.default_prompt, scope: "workspace" };
    if (scope.kind === "workspace") {
      const global = this.read(this.scopeGlobal());
      return global.default_prompt === null ? null : { id: global.default_prompt, scope: "global" };
    }
    return own.default_prompt === null ? null : { id: own.default_prompt, scope: "global" };
  }

  private promptList(scope: PromptScope): PromptListEntry[] {
    const ws = scope.kind === "workspace" ? this.read(scope) : { ...EMPTY, prompts: [] as PromptEntry[] };
    const global = this.read(this.scopeGlobal());
    const wsIds = new Set(ws.prompts.map((p) => p.id));
    const rows: PromptListEntry[] = global.prompts.map((p) => ({ ...p, scope: "global" as const, shadowed: scope.kind === "workspace" && wsIds.has(p.id) }));
    if (scope.kind === "workspace") rows.push(...ws.prompts.map((p) => ({ ...p, scope: "workspace" as const, shadowed: false })));
    return rows;
  }

  /** GET /api/prompts body (handler fills `active_prompt`). */
  list(scope: PromptScope, activePrompt: string | null): PromptListResponse {
    return {
      ok: true,
      scope: scope.kind,
      workspace: scope.workspace,
      global_file: this.globalFile,
      sections: this.effective(scope, null).rows,
      prompts: this.promptList(scope),
      default_prompt: this.defaultFor(scope),
      active_prompt: activePrompt,
    };
  }

  private effective(scope: PromptScope, boundId: string | null): { rows: PromptSectionRow[]; templates: Map<string, string> } {
    return composeSections({
      global: scope.kind === "workspace" ? this.read(this.scopeGlobal()) : this.read(scope),
      workspace: scope.kind === "workspace" ? this.read(scope) : null,
      bound: boundId === null ? null : (this.find(scope, boundId) ?? null),
    });
  }

  /** The registry-resolved sections (used by the sections listing). */
  sections(scope: PromptScope, boundId: string | null = null): PromptSectionRow[] {
    return this.effective(scope, boundId).rows;
  }

  upsert(scope: PromptScope, req: PromptUpsertRequest): StoreResult<{ id: string; scope: "global" | "workspace"; hot_applied: true }> {
    const idError = validatePromptId(req.id);
    if (idError !== null) return badRequest(idError);
    const overrides = req.section_overrides ?? {};
    for (const [sectionId, template] of Object.entries(overrides)) {
      const bad = validateTemplate(template);
      if (bad !== null) return badRequest(`section '${sectionId}': ${bad.error}`);
    }
    const data = this.read(scope);
    const idx = data.prompts.findIndex((p) => p.id === req.id);
    const previous = idx >= 0 ? data.prompts[idx] : undefined;
    const isDefault = req.is_default ?? previous?.is_default ?? false;
    const entry: PromptEntry = { id: req.id, name: req.name, section_overrides: overrides, is_default: isDefault };
    if (idx >= 0) data.prompts[idx] = entry;
    else data.prompts.push(entry);
    if (isDefault) {
      for (const p of data.prompts) if (p.id !== req.id) p.is_default = false;
    }
    const saved = this.persist(scope, data);
    if (!saved.ok) return saved;
    return ok({ id: req.id, scope: scope.kind, hot_applied: true });
  }

  remove(scope: PromptScope, rawId: string): StoreResult<{ scope: "global" | "workspace"; hot_applied: true }> {
    const data = this.read(scope);
    const idx = data.prompts.findIndex((p) => p.id === rawId);
    if (idx < 0) return notFound(`unknown prompt '${rawId}'`);
    data.prompts.splice(idx, 1);
    if (data.default_prompt === rawId) data.default_prompt = null;
    const saved = this.persist(scope, data);
    if (!saved.ok) return saved;
    return ok({ scope: scope.kind, hot_applied: true });
  }

  setDefault(scope: PromptScope, rawId: string): StoreResult<{ default_prompt: string; scope: "global" | "workspace"; hot_applied: true }> {
    const data = this.read(scope);
    const idx = data.prompts.findIndex((p) => p.id === rawId);
    if (idx < 0) return notFound(`unknown prompt '${rawId}'`);
    data.default_prompt = rawId;
    for (const p of data.prompts) p.is_default = p.id === rawId;
    const saved = this.persist(scope, data);
    if (!saved.ok) return saved;
    return ok({ default_prompt: rawId, scope: scope.kind, hot_applied: true });
  }
}

export interface SectionComposeInput {
  global: PromptFileData;
  workspace: PromptFileData | null;
  bound: PromptEntry | null;
}

/**
 * Four-level overlay: builtin -> global -> workspace -> bound overrides.
 * A known id keeps its ORIGINAL order and only swaps its template; an unknown
 * id is appended with ORDER_FALLBACK and sorted by `(order, id)`.
 */
export function composeSections(input: SectionComposeInput): { rows: PromptSectionRow[]; templates: Map<string, string> } {
  const rows: PromptSectionRow[] = [];
  const seen = new Map<string, number>();
  const push = (id: string, name: string, template: string, order: number, source: PromptSectionRow["source"]): void => {
    const at = seen.get(id);
    if (at === undefined) {
      seen.set(id, rows.length);
      rows.push({ id, name, template, order, source });
    } else {
      const row = rows[at] as PromptSectionRow;
      row.template = template;
      if (source !== "builtin") row.source = source;
    }
  };
  for (const s of builtinRows()) push(s.id, s.name, s.template, s.order, "builtin");
  for (const s of input.global.sections) push(s.id, s.name, s.template, s.order, "global");
  if (input.workspace !== null) for (const s of input.workspace.sections) push(s.id, s.name, s.template, s.order, "workspace");
  if (input.bound !== null) {
    for (const [id, template] of Object.entries(input.bound.section_overrides)) {
      push(id, id, template, ORDER_FALLBACK, input.global.sections.some((s) => s.id === id) ? "global" : "builtin");
    }
  }
  rows.sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order));
  const templates = new Map(rows.map((r) => [r.id, r.template]));
  return { rows, templates };
}

/** Builtin rows, copied so a caller can never mutate the frozen table. */
function builtinRows(): Array<{ id: string; name: string; template: string; order: number }> {
  return BUILTIN_SECTIONS.map((s) => ({ ...s }));
}
