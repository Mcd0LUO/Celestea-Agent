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

/** `"<secs>.<nanos>"` — the creation / trash suffix (`now_ts`). */
export function timestampSuffix(nowMs: number): string {
  const secs = Math.floor(nowMs / 1000);
  const nanos = Math.floor((nowMs - secs * 1000) * 1e6);
  return `${secs}.${nanos}`;
}

/** `<sanitized title>-<secs>.<nanos>` — the session directory name. */
export function sessionDirName(title: string, nowMs: number): string {
  return `${sanitizeComponent(title)}-${timestampSuffix(nowMs)}`;
}

/** The creation tail [`stripCreationSuffix`] removes: `-<secs>.<nanos>[-<n>]`. */
const CREATION_SUFFIX = /-\d+\.\d+(-\d+)?$/;

/**
 * W779 T2 — the display name of a session DIRECTORY.
 *
 * A directory is `<sanitized title>-<secs>.<nanos>` (and `uniqueDir` may append
 * `-N`), a uniqueness trick that must never reach the GUI:
 *   main-1789192174.492000000 -> main
 *   v2-1-1700000000.0-2       -> v2-1
 *   plain                     -> plain        (nothing to strip)
 *   报告-2024                  -> 报告-2024     (digits, but not a timestamp)
 * A name that is ONLY a suffix keeps itself instead of becoming "".
 */
export function stripCreationSuffix(name: string): string {
  const stripped = name.replace(CREATION_SUFFIX, "");
  return stripped === "" ? name : stripped;
}

/** Folder basename, or null when the path has no usable last component. */
export function workspaceBasename(path: string): string | null {
  const base = basename(path);
  return base === "" || base === "/" ? null : base;
}

/**
 * W791: the two hidden sibling directories a session can be MOVED into.
 *
 * They live here (the session-directory vocabulary module) rather than in
 * `session-ops.ts` because BOTH sides need them: the mover writes into them, and
 * the scanner (`SessionsStore.listArchived`) reads `<ws>/.celestea-archived/`
 * back. Importing the mover from the scanner would make the two modules
 * circular, which the repo's dependency gate forbids.
 *
 * The names never change: a rename would orphan every archived session on disk.
 */
export const ARCHIVED_DIR = ".celestea-archived";
export const TRASH_DIR = ".celestea-trash";

/**
 * W877 (slice A) — the workspace-level container for NEW-layout session dirs.
 *
 * Live sessions used to sit directly in the workspace root
 * (`<ws>/<sanitized-title>-<secs>.<nanos>[-N>/`); new ones go into
 * `<ws>/.celestea/sessions/<dir>/` instead. The session ID does NOT change: it is
 * still `<workspace-basename>/<dir>`. Legacy sessions keep being recognized at
 * the old path (dual read), so both layouts must be probed on every path.
 *
 * The archive/trash vocabulary (`ARCHIVED_DIR`/`TRASH_DIR`) is deliberately left
 * untouched by this slice: archiving and trashing still live in the legacy hidden
 * siblings.
 */
export const CELESTEA_DIR = ".celestea";
export const SESSIONS_SUBDIR = "sessions";

/** The NEW-layout live-session root: `<ws>/.celestea/sessions`. */
export function sessionsRoot(wsPath: string): string {
  return `${wsPath}/${CELESTEA_DIR}/${SESSIONS_SUBDIR}`;
}

/**
 * The physical directories a live session may occupy, NEW layout FIRST.
 *
 * `resolve()` uses the first existing candidate and falls back to the new layout
 * when neither exists (so the write side stays consistent); `list()` scans both.
 * Pure — the caller owns the filesystem side.
 */
export function liveDirCandidates(wsPath: string, dir: string): string[] {
  return [`${sessionsRoot(wsPath)}/${dir}`, `${wsPath}/${dir}`];
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
