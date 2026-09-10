/**
 * `<session-dir>/session.json` — the optional Studio session metadata
 * (`contracts/data-files/session.schema.json`).
 *
 * The engine NEVER reads this file; only `POST /api/sessions` writes it (and
 * only when `model` and/or `prompt` is non-empty), `branch` copies it, and
 * `activate`/`compact` honor its `model` override. Missing or corrupt files are
 * tolerated (`None`), never repaired.
 */

import { readJsonIfExists, writeTextPlain } from "./fs-json.js";

export const SESSION_META = "session.json";

export interface SessionMeta {
  model?: string;
  prompt?: string;
}

/** Read the metadata; a corrupt file behaves exactly like a missing one. */
export function readSessionMeta(dir: string): SessionMeta | null {
  const out = readJsonIfExists(`${dir}/${SESSION_META}`);
  if (!out.exists || out.error !== undefined) return null;
  if (typeof out.value !== "object" || out.value === null || Array.isArray(out.value)) return null;
  const rec = out.value as Record<string, unknown>;
  const meta: SessionMeta = {};
  if (typeof rec["model"] === "string") meta.model = rec["model"];
  if (typeof rec["prompt"] === "string") meta.prompt = rec["prompt"];
  return meta;
}

/** `model` and/or `prompt` non-empty -> write; both empty -> do not create. */
export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  const model = meta.model ?? "";
  const prompt = meta.prompt ?? "";
  if (model === "" && prompt === "") return;
  const body: Record<string, string> = {};
  if (model !== "") body["model"] = model;
  if (prompt !== "") body["prompt"] = prompt;
  writeTextPlain(`${dir}/${SESSION_META}`, `${JSON.stringify(body, null, 2)}\n`);
}
