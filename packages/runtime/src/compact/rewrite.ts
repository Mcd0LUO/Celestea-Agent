/**
 * Atomic log rewrite (port of `celestea_studio/src/compact.rs:344-390`).
 *
 * The order is the durability contract:
 *   1. the CURRENT file is copied to `cli-main.jsonl.precompact` (single copy,
 *      overwritten) — the pre-compaction history is always recoverable;
 *   2. the new log is written to a same-directory `cli-main.jsonl.tmp-<pid>` and
 *      fsynced (a temp file on another device would make `rename` a copy);
 *   3. `rename` replaces the log atomically: a concurrent reader sees either the
 *      whole old log or the whole new one, never a half-written file.
 *
 * A failed rename removes the temp file, so a retry cannot be poisoned by a
 * stale partial write.
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serializeSessionEvent, type SessionEvent } from "@celestea/core";

/** Single-copy backup of the pre-compaction log. */
export const COMPACT_BACKUP_FILE = "cli-main.jsonl.precompact";
/** Same-directory temp prefix (rename must not cross devices). */
export const COMPACT_TMP_PREFIX = "cli-main.jsonl.tmp-";

/** The log as one JSONL record per event, every record newline-terminated. */
export function serializeEventLog(events: readonly SessionEvent[]): string {
  let text = "";
  for (const ev of events) text += `${serializeSessionEvent(ev)}\n`;
  return text;
}

/** Copy the current log to the backup path (only when it exists). */
function backupCurrent(path: string, backup: string): void {
  if (existsSync(path)) copyFileSync(path, backup);
}

/** Write `text` to `tmp` and fsync it before it can replace anything. */
function writeDurable(tmp: string, text: string): void {
  writeFileSync(tmp, text, "utf8");
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Rewrite `path` with `events` (backup + fsync + atomic rename). */
export function rewriteAtomic(path: string, events: readonly SessionEvent[], pid: number = process.pid): void {
  const dir = dirname(path);
  const tmp = join(dir, `${COMPACT_TMP_PREFIX}${pid}`);
  backupCurrent(path, join(dir, COMPACT_BACKUP_FILE));
  writeDurable(tmp, serializeEventLog(events));
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e instanceof Error ? e : new Error(String(e));
  }
}
