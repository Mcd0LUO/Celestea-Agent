/**
 * registry.tsv read/write (crates/workers/src/types.rs:50-97, registry.rs:158-230).
 *
 * 4 tab-separated columns: wid \t started_at \t status \t extra
 * Bad rows are skipped, never fatal. `extra` is free text of k=v tokens.
 */

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
