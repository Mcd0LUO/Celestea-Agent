/**
 * `<session-dir>/session.json` — the optional Studio session metadata
 * (`contracts/data-files/session.schema.json`).
 *
 * The engine NEVER reads this file; only `POST /api/sessions` writes it (and
 * only when `title` and/or `model` and/or `prompt` and/or `mode` is non-empty),
 * `rename`/`branch` re-write it (see W779 below), and `activate`/`compact` honor
 * its `model` override. Missing or corrupt files are tolerated (`None`), never
 * repaired.
 *
 * W779 T2: `title` joins them — the ORIGINAL, un-sanitized session title (CJK,
 * spaces and all), so the GUI can show `我的 会话` instead of the directory name
 * `我的_会话-1700000000.0`. `POST /api/sessions` always has a title, so every
 * session created from now on carries one; the field is optional on read, and a
 * session without it falls back to the de-suffixed directory name.
 *
 * W729 (P0): `mode` joins `model`/`prompt` as a creation-time session property.
 * K8: the default mode is *not* written — the KEY never appears for a session
 * that did not ask for one. W779 T2 adds `title`, so the file itself now always
 * exists; K8's guarantee is per-key (no `mode` key), not per-file.
 */

import { parseMode, type SessionMode } from "./mode.js";
import { readJsonIfExists, writeTextPlain } from "./fs-json.js";

export const SESSION_META = "session.json";

export interface SessionMeta {
  /**
   * W779 T2: the display name, verbatim as the user typed it. Absent = the
   * caller falls back to the directory name without its creation suffix.
   */
  title?: string;
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
  if (typeof rec["title"] === "string") meta.title = rec["title"];
  if (typeof rec["model"] === "string") meta.model = rec["model"];
  if (typeof rec["prompt"] === "string") meta.prompt = rec["prompt"];
  const mode = parseMode(rec["mode"]);
  if (mode !== null) meta.mode = mode;
  return meta;
}

/** Any of `title`/`model`/`prompt`/`mode` non-empty -> write; all empty -> no file. */
export function writeSessionMeta(dir: string, meta: SessionMeta): void {
  const title = meta.title ?? "";
  const model = meta.model ?? "";
  const prompt = meta.prompt ?? "";
  const mode: string = meta.mode ?? "";
  if (title === "" && model === "" && prompt === "" && mode === "") return;
  const body: Record<string, string> = {};
  if (title !== "") body["title"] = title;
  if (model !== "") body["model"] = model;
  if (prompt !== "") body["prompt"] = prompt;
  if (mode !== "") body["mode"] = mode;
  writeTextPlain(`${dir}/${SESSION_META}`, `${JSON.stringify(body, null, 2)}\n`);
}
