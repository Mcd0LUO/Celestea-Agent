/**
 * File-level helpers shared by the three data stores.
 *
 * Durability is part of the frozen contract (`contracts/data-files/index.json`
 * `durability` map): every registry file is written pretty-printed through
 * `<file>.tmp` + `rename`; `providers.json` additionally forces mode 0600 and
 * fsyncs. Reading never silently overwrites an unreadable file — the caller
 * decides whether a malformed file is fatal (workspaces/providers) or merely a
 * warning (prompts).
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errText } from "./result.js";

export interface ReadOutcome<T> {
  /** false = the file does not exist (ENOENT), which every store tolerates. */
  exists: boolean;
  value?: T;
  /** Set when the file exists but could not be read/parsed. */
  error?: string;
}

/** Read + parse JSON; a missing file is `{exists:false}`, a broken one an error. */
export function readJsonIfExists(path: string): ReadOutcome<unknown> {
  if (!existsSync(path)) return { exists: false };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { exists: true, error: errText(e) };
  }
  if (text.trim() === "") return { exists: true, value: undefined };
  try {
    return { exists: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { exists: true, error: errText(e) };
  }
}

export interface WriteOptions {
  /** Force this mode on the temp file before the rename (0600 for secrets). */
  mode?: number;
  /** fsync the file before renaming (providers.json only). */
  fsync?: boolean;
  /** Trailing newline (Rust `to_string_pretty` + file write has none). */
  newline?: boolean;
}

/** Atomic pretty-JSON write: `<path>.tmp` -> fsync? -> rename. */
export function writeJsonAtomic(path: string, value: unknown, opts: WriteOptions = {}): void {
  const body = `${JSON.stringify(value, null, 2)}${opts.newline === true ? "\n" : ""}`;
  writeTextAtomic(path, body, opts);
}

export function writeTextAtomic(path: string, body: string, opts: WriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, opts.mode === undefined ? {} : { mode: opts.mode });
  if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
  if (opts.fsync === true) {
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  renameSync(tmp, path);
}

/** Plain (non-atomic) write, matching `session.json` semantics. */
export function writeTextPlain(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function writeFileRaw(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface FileStat {
  size: number;
  /** Seconds since the epoch (contract `modified`). */
  modified: number;
}

export function statOf(path: string): FileStat | null {
  try {
    const st = statSync(path);
    return { size: st.size, modified: Math.floor(st.mtimeMs / 1000) };
  } catch {
    return null;
  }
}

/** Direct sub-directory names, dot-dirs skipped, sorted (fs browse semantics). */
export function listDirNames(path: string, limit: number): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    dirs.push(e.name);
  }
  dirs.sort();
  return dirs.slice(0, limit);
}

/** Direct child names including dot-dirs and files (session scanning). */
export function listEntries(path: string): Array<{ name: string; isDir: boolean }> {
  try {
    return readdirSync(path, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Best-effort recursive delete: used by every create/move rollback path. */
export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
