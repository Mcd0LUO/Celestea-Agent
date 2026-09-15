/**
 * The studio's worker TABLE path and its boot-observation view (E §2.2.1/§2.2.4).
 *
 * Two host decisions live here, both about the same file:
 *
 *   1. WHERE the table is. §2.2.1: the studio and the DSH-side plugin
 *      (`celes-worker-spawn`) each own a table and they must NEVER write each
 *      other's (R2-1, asserted by B6). The studio's default is
 *      `<data dir>/worker-registry.tsv`, overridable with
 *      `CELESTEA_WORKER_REGISTRY`; an EMPTY value means "in-memory only"
 *      (`tsvPath: null`, the test/embedded option that must stay available).
 *   2. WHAT a persisted row means at boot: `stale[]` / `orphans[]` for
 *      `GET /api/worker/status`. P0 OBSERVES ONLY — the judgement is the pure
 *      function in `@celestea/workers` and nothing here settles or re-dispatches.
 *
 * Reading is also how the boot observer writes its audit line, so the two share
 * this module instead of each parsing the file on its own.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkerEntry } from "@celestea/core";
import { hasDeliverable, observeWorkerTable, parseRegistryTsv, type WorkerRecoveryReport } from "@celestea/workers";

/** `CELESTEA_WORKER_REGISTRY` — the table path; empty = in-memory only. */
export const ENV_WORKER_REGISTRY = "CELESTEA_WORKER_REGISTRY";
/** File name inside `<data dir>` (never the DSH plugin's `workerBase`). */
export const WORKER_REGISTRY_FILE = "worker-registry.tsv";

export interface WorkerTablePathInput {
  env: NodeJS.ProcessEnv;
  /** `<data dir>` — where workspaces.json / the ledger live. */
  dataDir?: string | null;
  /** `<data dir>/worker-results`; its parent is the data dir when unset. */
  resultsDir?: string | null;
  /** Explicit option wins (`null` = in-memory); `undefined` = derive it. */
  override?: string | null;
}

/**
 * The configured table path, or null for an in-memory table. Precedence:
 * explicit option > `CELESTEA_WORKER_REGISTRY` > `<data dir>/worker-registry.tsv`.
 */
export function workerTablePath(input: WorkerTablePathInput): string | null {
  if (input.override !== undefined) return input.override === null ? null : resolve(input.override);
  const raw = input.env[ENV_WORKER_REGISTRY];
  if (raw !== undefined) return raw.trim() === "" ? null : resolve(raw);
  const dir = input.dataDir ?? (input.resultsDir == null ? null : resolve(input.resultsDir, ".."));
  if (dir === null || dir === "") return null;
  return join(isAbsolute(dir) ? dir : resolve(dir), WORKER_REGISTRY_FILE);
}

/** Parse one table; a missing or unreadable file is an EMPTY table, never a throw. */
export function readWorkerTable(path: string | null): { entries: WorkerEntry[]; error: string | null } {
  if (path === null) return { entries: [], error: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT is the normal state before the first spawn (no file yet).
    return { entries: [], error: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : messageOf(e) };
  }
  return { entries: parseRegistryTsv(text).entries, error: null };
}

export interface WorkerRecoveryBlockInput {
  /** The table path (null = in-memory: there is nothing to observe). */
  path: string | null;
  /** Does the host session that dispatched a worker still exist? */
  knownHost?: (sid: string) => boolean;
  /** Results dir of the deliverable probe (`results/<wid>*.md`). */
  resultsDir: string;
  now?: () => number;
}

/**
 * Judge the table for the status view. `stale`/`orphans` are PURE ADDITIONS to
 * `/api/worker/status`; a foreign-process row is the NORMAL case here (that is
 * what a persisted table means), so the view must show it.
 */
export function workerRecoveryBlock(input: WorkerRecoveryBlockInput): WorkerRecoveryReport {
  const { entries } = readWorkerTable(input.path);
  return observeWorkerTable(entries, {
    ...(input.knownHost === undefined ? {} : { knownHost: input.knownHost }),
    artifactExists: (entry) => hasDeliverable(input.resultsDir, entry.wid).found,
    ...(input.now === undefined ? {} : { now: input.now() }),
  });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
