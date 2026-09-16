/**
 * registry.tsv read/write (crates/workers/src/types.rs:50-97, registry.rs:158-230).
 *
 * 4 tab-separated columns: wid \t started_at \t status \t extra
 * Bad rows are skipped, never fatal. `extra` is free text of k=v tokens.
 *
 * W787 (E §2.2.2): four tokens joined the vocabulary — `host=` (the dispatching
 * host conversation), `attempt=` (which try this row is, first = 0, §5.2), `lease=`
 * (`<pid>@<unix>` of the owning process) and `receipt=` (the delivered receipt's
 * idempotency key). The COLUMN COUNT does not change, so an older parser keeps
 * reading the table (it only sees a longer `extra`), which is what makes this a
 * backward-compatible change (B7 round-trip).
 */

import { readFileSync } from "node:fs";
import { WORKER_STATUSES, type WorkerEntry, type WorkerStatus } from "@celestea/core";

export const REGISTRY_TSV_PATH = "/tmp/celestea-workers-registry.tsv";

export function isWorkerStatus(v: string): v is WorkerStatus {
  return (WORKER_STATUSES as readonly string[]).includes(v);
}

export interface RegistryParseResult {
  entries: WorkerEntry[];
  /** Physical lines seen (including skipped ones). */
  lines: number;
  skipped: Array<{ line: number; raw: string; reason: string }>;
}

export function parseRegistryTsv(text: string): RegistryParseResult {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const entries: WorkerEntry[] = [];
  const skipped: RegistryParseResult["skipped"] = [];

  lines.forEach((raw, i) => {
    if (raw.trim() === "") return;
    const parts = raw.split("\t");
    if (parts.length < 4) {
      skipped.push({ line: i + 1, raw, reason: `expected 4 tab-separated columns, got ${parts.length}` });
      return;
    }
    const wid = (parts[0] ?? "").trim();
    const startedAt = (parts[1] ?? "").trim();
    const status = (parts[2] ?? "").trim();
    const extra = parts.slice(3).join("\t");
    if (wid === "" || startedAt === "") {
      skipped.push({ line: i + 1, raw, reason: "empty wid or started_at" });
      return;
    }
    if (!isWorkerStatus(status)) {
      skipped.push({ line: i + 1, raw, reason: `unknown status '${status}'` });
      return;
    }
    entries.push({ wid, started_at: startedAt, status, extra });
  });
  return { entries, lines: lines.length, skipped };
}

export function serializeRegistryTsv(entries: readonly WorkerEntry[]): string {
  return entries.map((e) => `${e.wid}\t${e.started_at}\t${e.status}\t${e.extra}`).join("\n") + (entries.length > 0 ? "\n" : "");
}

/**
 * E §2.2.1: ONE table per process carries the rows of every studio session, and
 * `host=<sid>` tells them apart. A writer therefore MERGES its own rows into
 * whatever the other session registries already wrote — writing `entries()`
 * alone would silently delete a sibling session's worker.
 *
 * `mine` wins on a duplicate `wid` (the wid is the table's key); foreign rows
 * keep their insertion order, new ones are appended.
 */
export function mergeTableRows(fileRows: readonly WorkerEntry[], mine: readonly WorkerEntry[]): WorkerEntry[] {
  const merged = new Map<string, WorkerEntry>();
  for (const row of fileRows) merged.set(row.wid, row);
  for (const row of mine) merged.set(row.wid, row);
  return [...merged.values()];
}

/** Read a table for a merge (`[]` for a missing / unreadable file). */
/**
 * W831 R3 B4 (W813 P1-persist-foreign): the table as READ, without lying about
 * failure. A missing file is an empty table (ENOENT, the normal first-run
 * state); any other read error is reported so the writer can ABORT instead of
 * merging its own rows against an empty base and deleting every foreign row.
 *
 * `raw` carries the physical lines that did not parse, verbatim, so a rewrite
 * can pass them through instead of dropping them.
 */
export interface RegistryTableRead {
  rows: WorkerEntry[];
  raw: string[];
  /** Non-null only for a real read failure (ENOENT is an empty table). */
  error: string | null;
}

export function readTable(path: string): RegistryTableRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return { rows: [], raw: [], error: null };
    return { rows: [], raw: [], error: messageOf(error) };
  }
  const parsed = parseRegistryTsv(text);
  return { rows: parsed.entries, raw: parsed.skipped.map((s) => s.raw), error: null };
}

/**
 * Read just the rows of a table (`[]` for a missing / unreadable file). Kept for
 * callers that only observe; a WRITER must use [readTable] so a read failure can
 * stop the write.
 */
export function readTableRows(path: string): WorkerEntry[] {
  return readTable(path).rows;
}

function errorCodeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** k=v token lookup inside `extra` (whitespace separated). */
export function getExtra(entry: WorkerEntry, key: string): string | null {
  for (const tok of entry.extra.split(/\s+/)) {
    const idx = tok.indexOf("=");
    if (idx <= 0) continue;
    if (tok.slice(0, idx) === key) return tok.slice(idx + 1);
  }
  return null;
}

export function workerState(entry: WorkerEntry): string | null {
  return getExtra(entry, "state");
}

export function workerProc(entry: WorkerEntry): number | null {
  const raw = getExtra(entry, "proc");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** W186/W736: the watchdog's re-dispatch counter (`retries=`; absent = 0). */
export function workerRetries(entry: WorkerEntry): number {
  const raw = getExtra(entry, "retries");
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** E §2.2.2: the four tokens P0/P1 add to a row (the schema's whitelist). */
export const WORKER_ROW_TOKENS = ["host", "attempt", "lease", "receipt"] as const;

/** The host session that dispatched this worker (`host=`; null when absent). */
export function workerHost(entry: WorkerEntry): string | null {
  return getExtra(entry, "host");
}

/**
 * Which try this row is (`attempt=`). §5.2 (the CROSS-CAPABILITY convention —
 * ruled authoritative over §2.2.2's local wording): the FIRST spawn is `0` and a
 * re-dispatch adds one, so the worker table uses the SAME numbering as the usage
 * ledger and the model fallback (`fallback.ts` counts from 0, D6 asserts
 * `attempt = 0/1/2`). A row with no token at all is a first try ⇒ `0`: every
 * pre-P1 row was one, and the token is only absent on rows written before W787.
 */
export function workerAttempt(entry: WorkerEntry): number {
  const raw = getExtra(entry, "attempt");
  const n = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** `lease=<pid>@<unix>` — who owns the row and when it was last renewed. */
export interface WorkerLease {
  pid: number;
  at: number;
}

export function workerLease(entry: WorkerEntry): WorkerLease | null {
  const raw = getExtra(entry, "lease");
  if (raw === null) return null;
  const [pid, at] = raw.split("@");
  const n = Number.parseInt(pid ?? "", 10);
  const ts = Number.parseInt(at ?? "", 10);
  return Number.isSafeInteger(n) && Number.isSafeInteger(ts) ? { pid: n, at: ts } : null;
}

/** `lease=<pid>@<unix>` of a process at a moment (seconds, like every other ts). */
export function leaseToken(pid: number, nowMs: number): string {
  return `${pid}@${Math.floor(nowMs / 1000)}`;
}

/** The idempotency key of a DELIVERED receipt, as stored in `receipt=` (§2.2.3). */
export function receiptToken(wid: string, attempt: number): string {
  return `${wid}:${attempt}`;
}

/** The same key in the injection namespace the host inbox deduplicates on. */
export function receiptKey(wid: string, attempt: number): string {
  return `receipt:${receiptToken(wid, attempt)}`;
}

/** Has a receipt for exactly this `(wid, attempt)` already been delivered? */
export function receiptDelivered(entry: WorkerEntry, attempt: number): boolean {
  return getExtra(entry, "receipt") === receiptToken(entry.wid, attempt);
}

export function workerReportTo(entry: WorkerEntry): string | null {
  return getExtra(entry, "report_to");
}

export function workerSess(entry: WorkerEntry): string | null {
  return getExtra(entry, "sess");
}

export interface WorkerSummary {
  ok: boolean;
  total: number;
  by_status: { RUNNING: number; DONE: number; FAILED: number };
  by_state: { idle: number; "in-turn": number; running: number };
  workers: WorkerEntry[];
}

/** Mirror of WorkerRegistry::summarize for the given (already process-filtered) rows. */
export function summarize(entries: readonly WorkerEntry[]): WorkerSummary {
  const by_status = { RUNNING: 0, DONE: 0, FAILED: 0 };
  const by_state = { idle: 0, "in-turn": 0, running: 0 };
  for (const e of entries) {
    by_status[e.status] += 1;
    if (e.status !== "RUNNING") continue;
    const s = workerState(e);
    if (s === "in-turn") by_state["in-turn"] += 1;
    else if (s === "idle") by_state.idle += 1;
    else by_state.running += 1;
  }
  return { ok: true, total: entries.length, by_status, by_state, workers: [...entries] };
}
