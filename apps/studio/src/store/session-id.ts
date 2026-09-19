/**
 * Session / workspace path rules (`src/workspaces.rs:555-660`).
 *
 * The workspace segment of an id is ALWAYS a registry lookup, never a path
 * component; the session segment is sanitized and then parent-verified, so a
 * crafted id cannot escape the registered workspace directory. These functions
 * are pure — the stores own the filesystem side.
 */

import { pathApi, type PlatformInput } from "@celestea/tools";

import { workspaceHome } from "./celestea-home.js";

/** The host's platform, injectable in tests (the W885 win32 seam). */
export type PathInput = PlatformInput;
export type PathInputLike = PlatformInput | string | undefined;

/**
 * W885 — collapse an input that may be a whole [PlatformInput] or a bare
 * platform id (the pre-W885 signatures took neither, so both are additive).
 */
function platformOf(input: PathInputLike): string {
  if (input === undefined) return process.platform;
  return typeof input === "string" ? input : (input.platform ?? process.platform);
}

/** The path implementation of this call's platform (win32 in a win32 test). */
function apiOf(input: PathInputLike): ReturnType<typeof pathApi> {
  return pathApi(platformOf(input));
}

/** `<a>/<b>` under the call's platform, never string concatenation (W883 E1/E2). */
function under(input: PathInputLike, base: string, ...segments: string[]): string {
  return apiOf(input).join(base, ...segments);
}

/** `dirname` under the call's platform. */
export function parentDir(path: string, input: PathInputLike = undefined): string {
  return apiOf(input).dirname(path);
}

/** `basename` under the call's platform. */
export function baseName(path: string, input: PathInputLike = undefined): string {
  return apiOf(input).basename(path);
}

/** The filesystem root of `path` (`/`, `C:\\`, `\\\\\\\\server\\\\share\\\\`). */
export function rootOf(path: string, input: PathInputLike = undefined): string {
  return apiOf(input).parse(path).root;
}

/** Absolute per the call's platform (Windows drive letters included). */
export function isAbsolutePath(path: string, input: PathInputLike = undefined): boolean {
  return apiOf(input).isAbsolute(path);
}

/**
 * `resolve` under the call's platform.
 *   W885 follow-up: "make this path absolute/canonical" is the same platform
 *   question as "is this path absolute" — `node:path`'s bare `resolve` answers
 *   it for the HOST, which is wrong the moment a win32 path is handled on Linux
 *   (tests) or the reverse.
 */
export function resolvePath(path: string, input: PathInputLike = undefined): string {
  return apiOf(input).resolve(path);
}

/** `join` under the call's platform (public form of `under`; W883 E1/E2). */
export function joinPath(input: PathInputLike, base: string, ...segments: string[]): string {
  return under(input, base, ...segments);
}

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
export function workspaceBasename(path: string, input: PathInputLike = undefined): string | null {
  const base = baseName(path, input);
  return base === "" || base === "/" || base === "\\" ? null : base;
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
 * W877 (slice A) — the workspace-level `.celestea/` container.
 *
 * Slice A sank NEW session dirs into `<ws>/.celestea/sessions/`; W880 moves the
 * canonical container OUT of the workspace into `CELESTEA_HOME`, so this path is
 * now only the MIDDLE read fallback (dual-read compatibility with real data
 * written by slice A).
 */
export const CELESTEA_DIR = ".celestea";
export const SESSIONS_SUBDIR = "sessions";
/** W880 archive sub-container (under `workspaceHome`). */
export const ARCHIVE_SUBDIR = "archive";
/** W880 trash sub-container (under `workspaceHome`). */
export const TRASH_SUBDIR = "trash";
/** W880 workspace prompt-registry file name. */
export const PROMPTS_FILE = "prompts.json";
/** W880 run_code transient-program sub-container. */
export const RUN_CODE_SUBDIR = "run-code";

/** W880 canonical live-session root: `<CELESTEA_HOME>/workspaces/<ws>/sessions`. */
export function sessionsRoot(wsPath: string, input: PathInputLike = undefined): string {
  return under(input, workspaceHome(wsPath, inputOf(input)), SESSIONS_SUBDIR);
}

/** W877 transitional root: `<ws>/.celestea/sessions`. */
export function legacySessionsRoot(wsPath: string, input: PathInputLike = undefined): string {
  return under(input, wsPath, CELESTEA_DIR, SESSIONS_SUBDIR);
}

/**
 * The [PlatformInput] form of a [PathInputLike]: a bare `"win32"` has to become
 * an input object before it can reach `celestea-home`, which resolves its own
 * per-platform defaults (and `homedir` matters for the win32 branch).
 */
function inputOf(input: PathInputLike): PlatformInput {
  if (input === undefined) return {};
  if (typeof input === "string") return { platform: input };
  return input;
}

/**
 * The physical roots a live session may occupy, canonical FIRST:
 * `<home>/.../sessions` -> `<ws>/.celestea/sessions` -> `<ws>`.
 *
 * Pure — the caller owns the filesystem side. `resolve()` uses the first
 * existing candidate and falls back to the canonical root when none exists (so
 * the write side stays consistent); `list()` scans all three and lets the
 * canonical row shadow a same-named legacy one.
 */
export function sessionRoots(wsPath: string, input: PathInputLike = undefined): string[] {
  return [sessionsRoot(wsPath, input), legacySessionsRoot(wsPath, input), wsPath];
}

/** `dir` under every live-session root, canonical FIRST. */
export function liveDirCandidates(wsPath: string, dir: string, input: PathInputLike = undefined): string[] {
  return sessionRoots(wsPath, input).map((root) => under(input, root, dir));
}

/** Archive roots, canonical FIRST: `home/archive` -> `.celestea/archive` -> `.celestea-archived`. */
export function archiveRoots(wsPath: string, input: PathInputLike = undefined): string[] {
  return [
    under(input, workspaceHome(wsPath, inputOf(input)), ARCHIVE_SUBDIR),
    under(input, wsPath, CELESTEA_DIR, ARCHIVE_SUBDIR),
    under(input, wsPath, ARCHIVED_DIR),
  ];
}

/** `dir` under every archive root, canonical FIRST. */
export function archiveDirCandidates(wsPath: string, dir: string, input: PathInputLike = undefined): string[] {
  return archiveRoots(wsPath, input).map((root) => under(input, root, dir));
}

/** Trash roots, canonical FIRST. */
export function trashRoots(wsPath: string, input: PathInputLike = undefined): string[] {
  return [
    under(input, workspaceHome(wsPath, inputOf(input)), TRASH_SUBDIR),
    under(input, wsPath, CELESTEA_DIR, TRASH_SUBDIR),
    under(input, wsPath, TRASH_DIR),
  ];
}

/** Workspace prompt-registry candidates, canonical FIRST (write target = `[0]`). */
export function promptsFileCandidates(wsPath: string, input: PathInputLike = undefined): string[] {
  return [
    under(input, workspaceHome(wsPath, inputOf(input)), PROMPTS_FILE),
    under(input, wsPath, CELESTEA_DIR, PROMPTS_FILE),
    under(input, wsPath, ".celestea-prompts.json"),
  ];
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

/** The host `isAbsolute` (kept exported for pre-W885 callers). */
export function isAbsolute(path: string): boolean {
  return isAbsolutePath(path);
}

export type { PlatformInput };
