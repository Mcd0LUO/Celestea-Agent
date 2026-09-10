/**
 * `providers.json` store — `contracts/data-files/providers.schema.json`,
 * `src/providers.rs:52-86,219-241,673-797`.
 *
 * Security rules enforced here, not by convention:
 *   - the file holds PLAINTEXT keys and is written through
 *     `OpenOptions::mode(0600)` + fsync + rename, i.e. EVERY save re-asserts
 *     0600 (see `save()`);
 *   - `public_view` has NO `api_key` key at all (not null, not empty) — the
 *     type returned by every read path simply has no such field, so a handler
 *     cannot leak it by accident;
 *   - update semantics: `api_key` absent/null/blank KEEPS the stored key (the
 *     only keep-on-default field), while `models` absent CLEARS the list,
 *     `note` absent clears to "", `request_format` absent silently resets to
 *     chat_completions and `name` absent falls back to `id`.
 */

import { readJsonIfExists, writeJsonAtomic } from "./fs-json.js";
import { badRequest, errText, fail, notFound, ok, type StoreResult } from "./result.js";
import { isHttpUrl } from "./validate.js";

export const REQUEST_FORMATS = ["chat_completions", "responses", "anthropic_messages"] as const;
export type RequestFormat = (typeof REQUEST_FORMATS)[number];
export const PROVIDERS_MODE = 0o600;

export interface ProviderModel {
  id: string;
  name: string;
  reasoning_efforts: string[];
  context_window: number | null;
  max_output_tokens: number | null;
}

/** Internal row: the ONLY place an api_key may live. */
export interface ProviderRow {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: RequestFormat;
  api_key: string | null;
  models: ProviderModel[];
}

/** Wire shape: structurally identical to `ProviderRow` MINUS `api_key`. */
export interface ProviderPublicView {
  id: string;
  name: string;
  note: string;
  base_url: string;
  request_format: RequestFormat;
  models: ProviderModel[];
  is_default: boolean;
  has_key: boolean;
}

export interface ProvidersView {
  providers: ProviderPublicView[];
  default_model: string | null;
}

export interface ProviderUpsertRequest {
  id?: string;
  name?: string;
  note?: string;
  base_url?: string;
  request_format?: string;
  api_key?: string | null;
  models?: Array<Partial<ProviderModel> & { id?: string }>;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function nullableInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function parseModel(raw: unknown): ProviderModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec["id"]);
  if (id === "") return null;
  const efforts = Array.isArray(rec["reasoning_efforts"]) ? rec["reasoning_efforts"].filter((x): x is string => typeof x === "string") : [];
  return {
    id,
    name: asString(rec["name"], id) || id,
    reasoning_efforts: efforts,
    context_window: nullableInt(rec["context_window"]),
    max_output_tokens: nullableInt(rec["max_output_tokens"]),
  };
}

function parseRow(raw: unknown, file: string): ProviderRow {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const id = asString(rec["id"]);
  const base_url = asString(rec["base_url"]);
  const fmt = asString(rec["request_format"]);
  if (id === "" || base_url === "" || !(REQUEST_FORMATS as readonly string[]).includes(fmt)) {
    throw new Error(`providers.json '${file}' is malformed: provider row needs id, base_url and a valid request_format`);
  }
  const models = Array.isArray(rec["models"]) ? rec["models"].map(parseModel).filter((m): m is ProviderModel => m !== null) : [];
  return {
    id,
    name: asString(rec["name"], id) || id,
    note: asString(rec["note"]),
    base_url,
    request_format: fmt as RequestFormat,
    api_key: typeof rec["api_key"] === "string" ? rec["api_key"] : null,
    models,
  };
}

function load(file: string): { providers: ProviderRow[]; default_model: string | null } {
  const out = readJsonIfExists(file);
  if (!out.exists) return { providers: [], default_model: null };
  if (out.error !== undefined) throw new Error(`providers.json '${file}' is malformed: ${out.error}`);
  const rec = (typeof out.value === "object" && out.value !== null ? out.value : {}) as Record<string, unknown>;
  const rows = Array.isArray(rec["providers"]) ? rec["providers"] : [];
  const def = rec["default_model"];
  return {
    providers: rows.map((r) => parseRow(r, file)),
    default_model: typeof def === "string" && def !== "" ? def : null,
  };
}

/** Normalize a base_url for the keyless-borrow comparison (trim + no trailing '/'). */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export class ProvidersStore {
  private data: { providers: ProviderRow[]; default_model: string | null };

  constructor(private readonly file: string) {
    this.data = load(file);
  }

  /** Internal rows — used by the probe and by `/api/config` model listing. */
  rows(): readonly ProviderRow[] {
    return this.data.providers;
  }

  find(id: string): ProviderRow | undefined {
    return this.data.providers.find((p) => p.id === id);
  }

  defaultModel(): string | null {
    return this.data.default_model;
  }

  /** Every id listed by any provider (used to validate `default_model`). */
  modelIds(): string[] {
    const out = new Set<string>();
    for (const p of this.data.providers) for (const m of p.models) out.add(m.id);
    return [...out];
  }

  private view(p: ProviderRow): ProviderPublicView {
    const def = this.data.default_model;
    return {
      id: p.id,
      name: p.name,
      note: p.note,
      base_url: p.base_url,
      request_format: p.request_format,
      models: p.models.map((m) => ({ ...m, reasoning_efforts: [...m.reasoning_efforts] })),
      is_default: def !== null && p.models.some((m) => m.id === def),
      has_key: typeof p.api_key === "string" && p.api_key !== "",
    };
  }

  viewOf(p: ProviderRow): ProviderPublicView {
    return this.view(p);
  }

  list(): ProviderPublicView[] {
    return this.data.providers.map((p) => this.view(p));
  }

  /** GET /api/providers body (no `ok`, never a key). */
  response(): ProvidersView {
    return { providers: this.list(), default_model: this.data.default_model };
  }

  private save(): StoreResult<void> {
    try {
      writeJsonAtomic(this.file, { providers: this.data.providers, default_model: this.data.default_model }, { mode: PROVIDERS_MODE, fsync: true });
      return ok(undefined);
    } catch (e) {
      return fail(500, `providers serialize failed: ${errText(e)}`);
    }
  }

  private validate(req: ProviderUpsertRequest): StoreResult<{ id: string; base_url: string; format: RequestFormat; models: ProviderModel[] }> {
    const id = (req.id ?? "").trim();
    if (id === "") return badRequest("provider id must not be empty");
    const base_url = (req.base_url ?? "").trim();
    if (base_url === "") return badRequest("base_url is required");
    if (!isHttpUrl(base_url)) return badRequest("base_url must be an http:// or https:// URL");
    const format = (req.request_format ?? "chat_completions") as RequestFormat;
    if (!(REQUEST_FORMATS as readonly string[]).includes(format)) {
      return badRequest(`invalid request_format '${format}': expected chat_completions | responses | anthropic_messages`);
    }
    const models: ProviderModel[] = [];
    for (const raw of req.models ?? []) {
      const model = parseModel(raw);
      if (model === null) return badRequest("each model needs a non-empty id");
      models.push(model);
    }
    return ok({ id, base_url, format, models });
  }

  /** POST /api/providers — upsert by id; returns the public view. */
  upsert(req: ProviderUpsertRequest): StoreResult<ProviderPublicView> {
    const checked = this.validate(req);
    if (!checked.ok) return checked;
    const { id, base_url, format, models } = checked.value;
    const idx = this.data.providers.findIndex((p) => p.id === id);
    const stored = idx >= 0 ? this.data.providers[idx] : undefined;
    const asked = req.api_key;
    const keepKey = asked === undefined || asked === null || asked.trim() === "";
    const row: ProviderRow = {
      id,
      name: (req.name ?? "").trim() === "" ? id : (req.name ?? "").trim(),
      note: req.note ?? "",
      base_url,
      request_format: format,
      api_key: keepKey ? (stored?.api_key ?? null) : asked,
      models,
    };
    if (idx >= 0) this.data.providers[idx] = row;
    else this.data.providers.push(row);
    const saved = this.save();
    if (!saved.ok) return saved;
    return ok(this.view(row));
  }

  /** POST /api/providers/{id}/delete — UNTRIMMED raw path value. */
  remove(rawId: string): StoreResult<void> {
    const idx = this.data.providers.findIndex((p) => p.id === rawId);
    if (idx < 0) return notFound(`unknown provider '${rawId}'`);
    this.data.providers.splice(idx, 1);
    if (this.data.default_model !== null && !this.modelIds().includes(this.data.default_model)) {
      this.data.default_model = null;
    }
    return this.save();
  }

  /** POST /api/providers/default — persist the default model id. */
  setDefaultModel(model: string): StoreResult<void> {
    this.data.default_model = model;
    return this.save();
  }

}
