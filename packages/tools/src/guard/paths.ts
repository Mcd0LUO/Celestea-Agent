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
 * canonicalization before the containment test (Rust parity:
 * `crates/tools/src/guard.rs`).
 */

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

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

/** Containment test on canonical paths (segment-aware, not string-prefix). */
export function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
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

/** Canonical path a write would land on, or `null` when no ancestor exists. */
export function resolveWriteTarget(target: string, workspace: string): string | null {
  const absolute = absolutize(target, workspace);
  const direct = canonicalExisting(absolute);
  if (direct !== null) return direct;
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
