/**
 * W891 (Windows slice) — an atomic replace that survives a transient Windows lock.
 *
 * POSIX `rename(2)` over an existing file is atomic and never fails because the
 * target is open. Windows `MoveFileEx` CAN fail with EPERM / EBUSY / EACCES when
 * the target is momentarily held (indexer, AV scanner, another handle), which made
 * every tmp+rename writer in this repo (registry.tsv, workspaces.json,
 * checkpoint.json, the compact rewrite) sporadically lose a write. Retry the
 * rename a few times with a short synchronous backoff; the last error is rethrown
 * so callers keep their existing failure reporting.
 */

import { renameSync } from "node:fs";

export interface RenameRetryOptions {
  /** Total attempts (first try + retries). Defaults to 5. */
  attempts?: number;
  /** Base backoff; attempt i waits `delayMs * (i + 1)`. Defaults to 20ms. */
  delayMs?: number;
  /** Injectable rename + sleep (tests); defaults to `fs.renameSync` + `sleepSync`. */
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}

/** Windows-only codes that a retry can clear. A missing source (ENOENT) is not one. */
const TRANSIENT_RENAME_CODES: readonly string[] = ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"];

export function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.includes(code);
}

/**
 * Synchronous sleep. Node has no sync sleep; `Atomics.wait` on a throwaway
 * `SharedArrayBuffer` is the standard, CPU-cheap way to block without spinning.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/** `renameSync(from, to)`, retrying the Windows transient-lock codes. */
export function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): void {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 20;
  const rename = options.rename ?? renameSync;
  const sleep = options.sleep ?? sleepSync;
  for (let i = 0; i < attempts; i++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || i === attempts - 1) throw error;
      sleep(delayMs * (i + 1));
    }
  }
}
