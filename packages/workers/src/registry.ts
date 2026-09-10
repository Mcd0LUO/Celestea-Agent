/**
 * WorkerRegistry — the in-memory + `registry.tsv` state of every worker this
 * process owns, plus the seams that make a worker drivable (Rust W185/W232/W248).
 *
 * Shape of the state:
 *   - `entries`  Memoized view of the tsv table. Rows written by THIS process
 *                carry a `proc=<pid>` token; rows from another process (or
 *                legacy rows with no `proc` at all) are foreign and never show up
 *                in the status view as ours (W234).
 *   - `sessions` Addressable conversations (`session-<n>`, the host id, …).
 *   - `mailbox`  Per-session FIFO queues with wake-up semantics.
 *   - `drivers`  The three driver seams, attached by the composition root after
 *                the Llm/ToolRegistry/AgentLoop services exist (so a spawn is
 *                background-driven instead of merely registered).
 *
 * No strong cycle: the three worker tools hold a [WeakRef] to this registry
 * (tools.ts), the drivers hold only core seams, and [release] drops everything —
 * so a hot-swapped generation can actually be collected (W248).
 *
 * `tsvPath = null` keeps the whole table in memory (tests, ephemeral hosts).
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { WorkerEntry } from "@celestea/core";
import { runDriverLoop, type WorkerDrivers } from "./driver.js";
import { executeReceipt, type ReceiptRequest } from "./receipt.js";
import { SessionMailbox } from "./mailbox.js";
import { SessionRegistry } from "./sessions.js";
import type { SessionLogFactory } from "./log.js";
import { REGISTRY_TSV_PATH, getExtra, parseRegistryTsv, serializeRegistryTsv, summarize } from "./registry-tsv.js";
import { sanitizeExtra, utcNow, type WorkerSession } from "./types.js";

export const RESULTS_DIR_DEFAULT = "results";
export const WORKER_REGISTRY_SERVICE = "celestea.workers.WorkerRegistry";

/** What the receipt protocol needs about a worker, kept in memory at spawn. */
export interface SpawnInfo {
  wid: string;
  short: string;
  brief: string;
  reportTo: string | null;
}

export interface WorkerRegistryOptions {
  /** `null` = keep the table in memory only (no file IO at all). */
  tsvPath?: string | null;
  resultsDir?: string;
  sourceLabel?: string;
  logFactory?: SessionLogFactory;
  now?: () => number;
  pid?: number;
}

export class WorkerRegistry {
  private readonly path: string | null;
  private readonly rows = new Map<string, WorkerEntry>();
  private readonly sessionRegistry: SessionRegistry;
  private readonly mailboxRegistry: SessionMailbox;
  private readonly stops = new Map<string, AbortController>();
  /** In-memory spawn facts per worker session (the receipt protocol reads these). */
  private readonly spawns = new Map<string, SpawnInfo>();
  private readonly pending = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly ownPid: number;
  private drivers: WorkerDrivers | null = null;
  private resultsDirValue: string;
  private sourceLabelValue: string;
  private released = false;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.path = opts.tsvPath === undefined ? REGISTRY_TSV_PATH : opts.tsvPath;
    this.resultsDirValue = opts.resultsDir ?? RESULTS_DIR_DEFAULT;
    this.sourceLabelValue = opts.sourceLabel ?? "unknown";
    this.now = opts.now ?? Date.now;
    this.ownPid = opts.pid ?? process.pid;
    this.sessionRegistry = new SessionRegistry({ logFactory: opts.logFactory });
    this.mailboxRegistry = new SessionMailbox(this.now);
    this.reload();
  }

  // --- table state -------------------------------------------------------

  /** Re-read the tsv table (missing file = empty table; bad rows are skipped). */
  reload(): void {
    this.rows.clear();
    if (this.path === null) return;
    let text = "";
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return;
    }
    for (const entry of parseRegistryTsv(text).entries) this.rows.set(entry.wid, entry);
  }

  /** Whole table in insertion order (foreign rows included). */
  entries(): WorkerEntry[] {
    return [...this.rows.values()].map((e) => ({ ...e }));
  }

  /** Rows written by THIS process — the only ones the status view counts. */
  ownEntries(): WorkerEntry[] {
    return this.entries().filter((e) => isOwn(e, this.ownPid));
  }

  getEntry(wid: string): WorkerEntry | undefined {
    const row = this.rows.get(wid);
    return row === undefined ? undefined : { ...row };
  }

  /** Insert/replace one row (stamping this process's `proc` token) + persist. */
  upsert(entry: WorkerEntry): string | null {
    this.rows.set(entry.wid, withProc(entry, this.ownPid));
    return this.persist();
  }

  /** Mark a worker's state token (`idle` / `in-turn`); DONE/FAILED rows are frozen. */
  setWorkerState(sid: string, state: string): void {
    const wid = this.widForSession(sid);
    const entry = wid === null ? undefined : this.rows.get(wid);
    if (wid === null || entry === undefined || entry.status !== "RUNNING") return;
    this.rows.set(wid, withState(entry, state));
    void this.persist();
  }

  /** `worker_status` payload: whole-table summary, or one worker when filtered. */
  status(wid?: string | null): Record<string, unknown> {
    const own = this.ownEntries();
    if (wid !== undefined && wid !== null && wid !== "") {
      const entry = own.find((e) => e.wid === wid);
      if (entry === undefined) return { ok: false, step: "lookup", error: `no worker ${wid} in registry` };
      return { ok: true, wid, worker: entryView(entry) };
    }
    return summarize(own) as unknown as Record<string, unknown>;
  }

  /** The session id registered for a wid (empty string when absent). */
  sessionFor(wid: string): string {
    const entry = this.rows.get(wid);
    return entry === undefined ? "" : getExtra(entry, "sess") ?? "";
  }

  // --- seams -------------------------------------------------------------

  get sessions(): SessionRegistry {
    return this.sessionRegistry;
  }

  get mailbox(): SessionMailbox {
    return this.mailboxRegistry;
  }

  get resultsDir(): string {
    return this.resultsDirValue;
  }

  setResultsDir(dir: string): void {
    this.resultsDirValue = dir;
  }

  get sourceLabel(): string {
    return this.sourceLabelValue;
  }

  setSourceLabel(label: string): void {
    this.sourceLabelValue = label;
  }

  get isReleased(): boolean {
    return this.released;
  }

  get pid(): number {
    return this.ownPid;
  }

  get tsvPath(): string | null {
    return this.path;
  }

  /**
   * Remember a spawn's readable facts. The `extra` token list is
   * space-delimited, so a multi-word brief/title cannot round-trip through it;
   * the receipt protocol therefore reads these in-memory facts and only falls
   * back to the (folded) tokens for rows written by another process.
   */
  rememberSpawn(sid: string, info: SpawnInfo): void {
    this.spawns.set(sid, info);
  }

  /** The in-memory spawn facts of one worker session (diagnostics / receipts). */
  spawnInfo(sid: string): SpawnInfo | undefined {
    return this.spawns.get(sid);
  }

  /** Register a session under an id of its own (the host conversation). */
  registerHostSession(session: WorkerSession): void {
    this.sessionRegistry.register(session);
  }

  /** Attach the driver seams; `canDrive` is true only when all three exist. */
  attachDrivers(drivers: WorkerDrivers): void {
    this.drivers = drivers;
  }

  canDrive(): boolean {
    return this.drivers !== null && !this.released;
  }

  // --- background drivers ------------------------------------------------

  /**
   * Start the mailbox event loop for one worker (prune first, Rust F1). Returns
   * false when a seam is missing, the session is unknown, or after release —
   * a spawn then stays "registered but not driven".
   */
  driveIfPossible(sid: string, brief: string, receipt = true): boolean {
    if (!this.canDrive() || this.sessionRegistry.get(sid) === undefined) return false;
    const drivers = this.drivers;
    if (drivers === null) return false;
    const controller = new AbortController();
    this.stops.set(sid, controller);
    const task = runDriverLoop({
      sid,
      brief,
      drivers,
      sessions: this.sessionRegistry,
      mailbox: this.mailboxRegistry,
      signal: controller.signal,
      onState: (id, state) => this.setWorkerState(id, state),
      ...(receipt ? { receipt: (id, failure) => this.closeLoop(id, failure) } : {}),
    }).finally(() => this.stops.delete(sid));
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return true;
  }

  /** Stop one worker's event loop (also called when its session is released). */
  stopDriver(sid: string): void {
    this.stops.get(sid)?.abort();
    this.stops.delete(sid);
  }

  /** Stop every driver without awaiting (the sync half of shutdown). */
  abortAllNow(): void {
    for (const controller of this.stops.values()) controller.abort();
    this.stops.clear();
    this.mailboxRegistry.release();
  }

  /** Await every tracked driver task (the async half of shutdown). */
  async joinDrivers(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Live background driver tasks. */
  backgroundLen(): number {
    return this.pending.size;
  }

  /** Idempotent teardown: stop drivers, purge queues, drop sessions and rows. */
  shutdown(): void {
    this.abortAllNow();
    this.mailboxRegistry.purgeAll();
    this.sessionRegistry.clear();
    this.rows.clear();
    this.spawns.clear();
  }

  /**
   * Release the registry for good: [shutdown] plus a marker that makes every
   * later tool call fail closed (a swapped-out generation must not resurrect).
   */
  release(): void {
    this.shutdown();
    this.drivers = null;
    this.released = true;
  }

  // --- internals ---------------------------------------------------------

  /** Atomic write (tmp + rename); a failure is reported, never thrown (W180 B1(c)). */
  private persist(): string | null {
    if (this.path === null) return null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${this.ownPid}-${this.now()}`;
      writeFileSync(tmp, serializeRegistryTsv(this.entries()), "utf8");
      renameSync(tmp, this.path);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private widForSession(sid: string): string | null {
    for (const entry of this.ownEntries()) {
      if (getExtra(entry, "sess") === sid) return entry.wid;
    }
    return null;
  }

  /** W235: write the report and enqueue the receipt, once, after the brief turn. */
  private closeLoop(sid: string, failure: string | null): void {
    const wid = this.widForSession(sid);
    if (wid === null) return;
    const entry = this.rows.get(wid);
    if (entry === undefined) return;
    const remembered = this.spawns.get(sid);
    const reportTo = remembered?.reportTo ?? getExtra(entry, "report_to");
    if (reportTo === null || reportTo === "") return;
    const req: ReceiptRequest = {
      wid,
      short: remembered?.short ?? getExtra(entry, "title") ?? wid,
      startedAt: entry.started_at,
      brief: remembered?.brief ?? getExtra(entry, "brief") ?? "",
      reportTo,
      sid,
      resultsDir: this.resultsDirValue,
      log: this.sessionRegistry.logOf(sid),
      failure,
    };
    const result = executeReceipt(req);
    this.mailboxRegistry.send(reportTo, result.content, sid);
  }
}

/** Row ownership: only a matching `proc` token makes a row ours (W234). */
export function isOwn(entry: WorkerEntry, pid: number): boolean {
  return getExtra(entry, "proc") === String(pid);
}

/** Stamp/replace the `proc` token, leaving every other token untouched. */
export function withProc(entry: WorkerEntry, pid: number): WorkerEntry {
  return { ...entry, extra: setToken(entry.extra, "proc", String(pid)) };
}

/** Stamp/replace the `state` token. */
export function withState(entry: WorkerEntry, state: string): WorkerEntry {
  return { ...entry, extra: setToken(entry.extra, "state", sanitizeExtra(state)) };
}

function setToken(extra: string, key: string, value: string): string {
  const tokens = extra.split(/\s+/).filter((tok) => tok !== "" && !tok.startsWith(`${key}=`));
  tokens.push(`${key}=${value}`);
  return tokens.join(" ");
}

/** The AI-facing view of one row (Rust `WorkerEntry::to_json`). */
function entryView(entry: WorkerEntry): Record<string, unknown> {
  const proc = getExtra(entry, "proc");
  return {
    wid: entry.wid,
    started_at: entry.started_at,
    status: entry.status,
    sess: getExtra(entry, "sess") ?? "",
    ws: getExtra(entry, "ws") ?? "",
    title: getExtra(entry, "title") ?? "",
    driven: getExtra(entry, "driven") ?? "",
    state: getExtra(entry, "state") ?? "",
    proc: proc === null ? null : Number.parseInt(proc, 10),
    extra: entry.extra,
  };
}

/** Timestamp helper re-exported for callers that build registry rows. */
export { utcNow };
