/**
 * Session / workspace path rules (`src/workspaces.rs:555-660`).
 *
 * The workspace segment of an id is ALWAYS a registry lookup, never a path
 * component; the session segment is sanitized and then parent-verified, so a
 * crafted id cannot escape the registered workspace directory. These functions
 * are pure — the stores own the filesystem side.
 */

import { basename, isAbsolute } from "node:path";

/** Separators / control chars / whitespace -> '_'; CJK and letters survive. */
export function sanitizeComponent(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isSeparator = ch === "/" || ch === "\\";
    out += isSeparator || isControl || /\s/u.test(ch) ? "_" : ch;
  }
  return out;
}

export interface ParsedSessionId {
  workspace: string;
  session: string;
  /** Canonical `<workspace>/<session>` after sanitization. */
  id: string;
}

/**
 * Split `<workspace>/<session>`: exactly one '/', both sides non-empty, the
 * session half separator-free after sanitization and never a hidden name.
 */
export function parseSessionId(raw: string): ParsedSessionId | null {
  const id = raw.trim();
  if (id === "") return null;
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const workspace = id.slice(0, slash);
  const rest = id.slice(slash + 1);
  if (rest === "" || rest.includes("/")) return null;
  const session = sanitizeComponent(rest);
  if (session === "" || session === "." || session === ".." || session.startsWith(".")) return null;
  return { workspace, session, id: `${workspace}/${session}` };
}

/** `"<secs>.<nanos>"` — the creation / trash suffix (Rust `now_ts`). */
export function timestampSuffix(nowMs: number): string {
  const secs = Math.floor(nowMs / 1000);
  const nanos = Math.floor((nowMs - secs * 1000) * 1e6);
  return `${secs}.${nanos}`;
}

/** `<sanitized title>-<secs>.<nanos>` — the session directory name. */
export function sessionDirName(title: string, nowMs: number): string {
  return `${sanitizeComponent(title)}-${timestampSuffix(nowMs)}`;
}

/** Folder basename, or null when the path has no usable last component. */
export function workspaceBasename(path: string): string | null {
  const base = basename(path);
  return base === "" || base === "/" ? null : base;
}

/** A hidden name can never become a visible session/workspace directory. */
export function isHiddenName(name: string): boolean {
  return name === "" || name === "." || name === ".." || name.startsWith(".");
}

/** Workspace rename validation (`validate_workspace_name`). */
export function validateWorkspaceName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  if (raw.trim() === "") return { ok: false, error: "workspace name must not be empty" };
  const name = sanitizeComponent(raw);
  if (name === "") return { ok: false, error: "workspace name must not be empty" };
  if (name === "." || name === "..") return { ok: false, error: `invalid workspace name '${raw}'` };
  return { ok: true, name };
}

export { isAbsolute };
