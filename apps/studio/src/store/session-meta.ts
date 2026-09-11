/**
 * `<session-dir>/session.json` — the optional Studio session metadata
 * (`contracts/data-files/session.schema.json`).
 *
 * The engine NEVER reads this file; only `POST /api/sessions` writes it (and
 * only when `model` and/or `prompt` and/or `mode` is non-empty), `branch` copies
 * it, and `activate`/`compact` honor its `model` override. Missing or corrupt
 * files are tolerated (`None`), never repaired.
 *
 * W729 (P0): `mode` joins `model`/`prompt` as a creation-time session property.
 * K8: the default mode is *not* written, so the writer's output for a session
 * without `mode` stays byte-for-byte what it was before this change.
 */

import { parseMode, type SessionMode } from "./mode.js";
import { readJsonIfExists, writeTextPlain } from "./fs-json.js";

export const SESSION_META = "session.json";

export interface SessionMeta {
  model?: string;
  prompt?: string;
  /** Declared session mode; ABSENT = `standard` and no key on disk (K8). */
  mode?: SessionMode;
}

/**
 * Read the metadata; a corrupt file behaves exactly like a missing one, and a
 * `mode` that is not a declared literal is dropped (never repaired on disk).
 */
export function readSessionMeta(dir: string): SessionMeta | null {
  const out = readJsonIfExists(`${dir}/${SESSION_META}`);
  if (!out.exists || out.error !== undefined) return null;
  if (typeof out.value !== "object" || out.value === null || Array.isArray(out.value)) return null;
  const rec = out.value as Record<string, unknown>;
  const meta: SessionMeta = {};
  if (typeof rec["model"] === "string") meta.model = rec["model"];
  if (typeof rec["prompt"] === "string") meta.prompt = rec["prompt"];
  const mode = parseMode(rec["mode"]);
  if (mode !== null) meta.mode = mode;
  return meta;
}

/** Any of `model`/`prompt`/`mode` non-empty -> write; all empty -> do not create. */
export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  const model = meta.model ?? "";
  const prompt = meta.prompt ?? "";
  const mode: string = meta.mode ?? "";
  if (model === "" && prompt === "" && mode === "") return;
  const body: Record<string, string> = {};
  if (model !== "") body["model"] = model;
  if (prompt !== "") body["prompt"] = prompt;
  if (mode !== "") body["mode"] = mode;
  writeTextPlain(`${dir}/${SESSION_META}`, `${JSON.stringify(body, null, 2)}\n`);
}
