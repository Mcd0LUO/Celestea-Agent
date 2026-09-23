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
import { workerSessionPrefix } from "@celestea/runtime";
import { getExtra, hasDeliverable, observeWorkerTable, parseRegistryTsv, workerHost, workerOwner, type WorkerRecoveryReport } from "@celestea/workers";

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

/** Which persisted rows may be called "a previous generation's" (W1470b). */
export interface InheritedRowsInput {
  /** Does the host session that dispatched the worker still exist? Absent = cannot tell ⇒ nothing is inherited. */
  knownHost?: (sid: string) => boolean;
  /** wids a LIVE instance owns right now — a row is never listed twice. */
  ownWids: readonly string[];
  /** This process: a row IT owns is this generation's, never an inherited one. */
  pid: number;
}

export interface WorkerTableStateInput extends InheritedRowsInput {
  /** The configured table path (null = in-memory: nothing persisted to read). */
  path: string | null;
  /** Results dir of the deliverable probe (`results/<wid>*.md`). */
  resultsDir: string;
  now?: number;
}

export interface WorkerTableState {
  /** E §2.3 P0 ③: the observation-only judgement (`stale[]` / `orphans[]`). */
  recovery: WorkerRecoveryReport;
  /** W1470b: the rows of a PREVIOUS generation, for the panel (never counted as own). */
  inherited: WorkerEntry[];
}

/**
 * W1470b — the ONE read of the table behind both faces: the P0 judgement the
 * status view has always reported, plus the previous generation's rows.
 *
 * Why the table (and not the live registries): a restart leaves the table on
 * disk while every registry starts empty, so a panel built from live instances
 * cannot show a worker whose session has not been composed again. The table is
 * the durable fact, and `knownHost` is the same evidence P0 already uses.
 */
export function workerTableStateOf(input: WorkerTableStateInput): WorkerTableState {
  const { entries } = readWorkerTable(input.path);
  return {
    recovery: observeWorkerTable(entries, {
      ...(input.knownHost === undefined ? {} : { knownHost: input.knownHost }),
      artifactExists: (entry) => hasDeliverable(input.resultsDir, entry.wid).found,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    inherited: inheritedRowsOf(entries, input),
  };
}

/**
 * W1470b — which PERSISTED rows are a previous generation's, using exactly the
 * evidence W1470's tool face uses (`SessionRegistry.inheritedEntries`):
 *
 *   1. no LIVE instance owns the wid right now (`ownWids`);
 *   2. its `host=` conversation still EXISTS in this studio (an orphan is P0's
 *      `orphans[]`, never a panel row);
 *   3. its `sess=` was minted with that host's own prefix (`workerSessionPrefix`),
 *      so a row of a sibling conversation can never be adopted by accident;
 *   4. THIS process does not own it — `proc=`/`lease=` is another pid, i.e. a
 *      generation that is gone. A row this process wrote is this generation's.
 */
export function inheritedRowsOf(entries: readonly WorkerEntry[], input: InheritedRowsInput): WorkerEntry[] {
  const known = input.knownHost;
  if (known === undefined) return [];
  const own = new Set(input.ownWids);
  const inherited: WorkerEntry[] = [];
  for (const entry of entries) {
    if (own.has(entry.wid)) continue;
    const host = workerHost(entry);
    if (host === null || !known(host)) continue;
    const sess = getExtra(entry, "sess");
    if (sess === null || !sess.startsWith(workerSessionPrefix(host))) continue;
    if (workerOwner(entry)?.pid === input.pid) continue;
    inherited.push(entry);
  }
  return inherited;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
