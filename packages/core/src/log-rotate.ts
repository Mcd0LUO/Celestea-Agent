/**
 * Bounded append-only log files — the ONE rotation primitive.
 *
 * WHY this module exists: the same 16 MiB "roll to `<path>.1`, then append" logic had
 * been written FOUR times independently (`runtime/ledger.ts`, `studio/store/
 * grants-audit.ts`, `studio/runtime/recovery-audit.ts`, `session/log/file.ts`), and
 * the watcher/alert logs were about to add a fifth and sixth. Copies drift: they
 * already disagreed on `existsSync` guards, on `mkdir` ordering, on file mode, and
 * on whether the fd is closed before the rename.
 *
 * It lives in core because core is the zero-dependency leaf — every tier-1 package
 * (including `workers`) may depend on it, and none of them may depend on each other.
 *
 * SCOPE: this module provides the **replacing** shape (`<path>` → `<path>.1`, any
 * previous `.1` discarded) for AUDIT/DIAGNOSTIC logs — the previous chain is a nicety,
 * and keeping generations forever would be its own unbounded-growth bug.
 *
 * The session log deliberately does NOT use it: that file is the source of
 * model-visible history, so it rotates by **generation** (`.1`, `.2`, … never
 * overwriting) in `session/log/file.ts`. Replacing `.1` there would DELETE history
 * rather than archive it, which is why the two shapes must not be unified.
 *
 * Best-effort by design. A log is diagnostics, not state — an unwritable log must
 * never break the caller's real work, so failures are swallowed and reported as a
 * `false` return rather than an exception.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The audit-log ceiling: 16 MiB, the discipline borrowed from `grants-audit.jsonl`. */
export const LOG_ROTATE_MAX_BYTES = 16 * 1024 * 1024;

export interface AppendRotatingOptions {
  /** Roll once the file reaches this many bytes. Defaults to [LOG_ROTATE_MAX_BYTES]. */
  maxBytes?: number;
  /** File mode for a newly created log. Omitted = process default. */
  mode?: number;
}

/**
 * Append one line, rolling the file to `<path>.1` first when it is at or above the
 * ceiling. Creates the parent directory when missing.
 *
 * Order matters and is the contract: **roll BEFORE the write**, so the rolled file is
 * always a complete prefix of the stream and the current file starts fresh. Rolling
 * after the write would put the record in `.1` while the caller believes it is current.
 *
 * Best-effort: any filesystem error is swallowed (returns `false`). Callers that want
 * to report the failure should do their own `try` around it — see `grants-audit.ts`.
 *
 * @returns whether a rotation actually happened.
 */
export function appendRotating(path: string, line: string, options: AppendRotatingOptions = {}): boolean {
  const maxBytes = options.maxBytes ?? LOG_ROTATE_MAX_BYTES;
  let rotated = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotated = rotateReplacing(path, maxBytes);
    appendFileSync(path, line, options.mode === undefined ? {} : { mode: options.mode });
  } catch {
    // Diagnostics, not state (W180 B1(c)): an unwritable log must not break the sweep.
  }
  return rotated;
}

/**
 * Roll `path` to `<path>.1` when it is at or above `maxBytes` (replacing a previous
 * `.1`). A missing or unreadable file is not a rotation.
 *
 * The comparison is `>=`, matching the usage ledger and the session log: a file that
 * sits exactly on the ceiling rolls on the next append rather than growing past it.
 */
export function rotateReplacing(path: string, maxBytes: number = LOG_ROTATE_MAX_BYTES): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // No file yet (first write) or unreadable: nothing to roll.
  }
  if (size < maxBytes) return false;
  try {
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false; // Locked (Windows) or gone: keep appending to the current file.
  }
}
