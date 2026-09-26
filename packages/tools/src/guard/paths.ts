/**
 * Path canonicalization helpers for the guard.
 *
 * Every decision is made on the *canonical* path (`realpath`, i.e. symlinks
 * resolved), never on the string the caller supplied:
 * - reads/list: the canonical target must exist inside a read root; an
 *   unresolvable target passes through so the tool reports its own error;
 * - writes: an existing file canonicalizes directly; a not-yet-created file
 *   canonicalizes its nearest existing ancestor and re-appends the missing
 *   suffix, so a new file is arbitrated by the directory it would land in.
 *
 * This closes `..` traversal and symlink escape at once: both are collapsed by
 * canonicalization before the containment test (parity:
 * `crates/tools/src/guard.rs`).
 */

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { isWindows } from "../platform/paths.js";

/** `realpath` or `null` when the path does not exist / cannot be resolved. */
export function canonicalExisting(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/** Resolve `target` against `workspace` (absolute targets are kept as given). */
export function absolutize(target: string, workspace: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(workspace, target);
}

/**
 * Containment test on canonical paths (segment-aware, not string-prefix).
 *
 * `platform` selects the SEPARATOR, exactly like [pathApi] does for the other
 * path helpers. It matters because callers can inject a platform that is not the
 * host's: `engine-grants.insidePath(..., "win32")` proves the win32 case on a
 * Linux CI runner. Using the host's `sep` there built `"c:\\users\\a/"` for a
 * Windows root and the containment test silently answered false — the assertion
 * passed on Windows and failed on ubuntu, which is how it was found.
 */
export function isInside(child: string, root: string, platform: string = process.platform): boolean {
  if (child === root) return true;
  const s = isWindows(platform) ? "\\" : "/";
  const prefix = root.endsWith(s) ? root : `${root}${s}`;
  return child.startsWith(prefix);
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Canonical path of an existing read/list target, or `null`. */
export function resolveExistingTarget(target: string, workspace: string): string | null {
  return canonicalExisting(absolutize(target, workspace));
}

/**
 * The target of a symlink at p (resolved against its own directory), or null
 * when p is missing / not a symlink. lstat does NOT follow the final component,
 * so a DANGLING link still reports as a link here.
 */
function symlinkTarget(p: string): string | null {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null;
    const link = readlinkSync(p);
    return isAbsolute(link) ? resolve(link) : resolve(dirname(p), link);
  } catch {
    return null;
  }
}

/**
 * Canonical path a write would land on, or null when no ancestor exists.
 *
 * W824 (W812 P0-1): the FINAL component must never be treated as a plain
 * missing file when it is a symlink. realpath fails for a dangling link, and
 * the lexical re-append below would then hand back the link's own
 * (in-workspace) path while fs.writeFile follows the link out of the
 * workspace. Resolve the link target first - even when that target does not
 * exist yet - so containment is decided on where the bytes would actually land.
 */
export function resolveWriteTarget(target: string, workspace: string): string | null {
  let absolute = absolutize(target, workspace);
  // Walk the final component through any symlink chain (bounded: ELOOP parity).
  for (let hops = 0; hops < 40; hops += 1) {
    const direct = canonicalExisting(absolute);
    if (direct !== null) return direct;
    const link = symlinkTarget(absolute);
    if (link === null) break;
    absolute = link;
  }
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return null;
    missing.push(basename(current));
    const canonicalParent = canonicalExisting(parent);
    if (canonicalParent !== null) return resolve(canonicalParent, ...missing.reverse());
    current = parent;
  }
}
