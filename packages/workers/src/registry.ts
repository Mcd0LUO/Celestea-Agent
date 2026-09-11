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
 * Lifecycle (W736): a row is born RUNNING and is settled exactly once, by
 * [finalize] — the single terminal write point (DONE / FAILED plus `ended_at`
 * and, on failure, `fail=<reason>`), reached through the same atomic tmp+rename
 * path as every other row write. The in-band writers are the receipt protocol
 * ([closeLoop]: the brief turn's verdict), the driver's exit ([driverExited]:
 * the session vanished or the loop was stopped) and a stopping host
 * ([shutdown]); the out-of-band adjudicator for rows that have no driver left is
 * the independent watchdog (`watchdog.ts`, the sole owner of liveness
 * judgement). A terminal row is frozen.
 *
 * No strong cycle: the three worker tools hold a [WeakRef] to this registry
 * (tools.ts), the drivers hold only core seams, and [release] drops everything —
 * so a hot-swapped generation can actually be collected (W248).
 *
 * `tsvPath = null` keeps the whole table in memory (tests, ephemeral hosts).
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionLog, WorkerEntry, WorkerStatus } from "@celestea/core";
import { runDriverLoop, type DriverExit, type WorkerDrivers } from "./driver.js";
import { executeReceipt, lastAssistantSummary, type ReceiptRequest, type ReceiptResult } from "./receipt.js";
import { SessionMailbox } from "./mailbox.js";
import { SessionRegistry } from "./sessions.js";
import type { SessionLogFactory } from "./log.js";
import { REGISTRY_TSV_PATH, getExtra, parseRegistryTsv, serializeRegistryTsv, summarize, workerRetries } from "./registry-tsv.js";
import { sanitizeExtra, truncateChars, utcNow, type WorkerSession, type WorkerVerdict } from "./types.js";

export const RESULTS_DIR_DEFAULT = "results";
export const WORKER_REGISTRY_SERVICE = "celestea.workers.WorkerRegistry";

/** What the receipt protocol needs about a worker, kept in memory at spawn. */
export interface SpawnInfo {
  wid: string;
  short: string;
  brief: string;
  reportTo: string | null;
  /** W729: the working mode recorded at spawn (null = the caller declared none). */
  mode: string | null;
}

export interface WorkerRegistryOptions {
  /** `null` = keep the table in memory only (no file IO at all). */
  tsvPath?: string | null;
  resultsDir?: string;
  sourceLabel?: string;
  logFactory?: SessionLogFactory;
  /** Id prefix of the worker sessions this registry mints (`session-`). */
  sessionIdPrefix?: string;
  /**
   * W729: the mode of the session this registry belongs to. A spawn without an
   * explicit `mode` argument inherits it (§2.3: worker defaults to parent mode).
   */
  hostMode?: string | null;
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
  private hostModeValue: string | null;
  private released = false;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.path = opts.tsvPath === undefined ? REGISTRY_TSV_PATH : opts.tsvPath;
    this.resultsDirValue = opts.resultsDir ?? RESULTS_DIR_DEFAULT;
    this.sourceLabelValue = opts.sourceLabel ?? "unknown";
    this.hostModeValue = opts.hostMode ?? null;
    this.now = opts.now ?? Date.now;
    this.ownPid = opts.pid ?? process.pid;
    this.sessionRegistry = new SessionRegistry({
      logFactory: opts.logFactory,
      ...(opts.sessionIdPrefix === undefined ? {} : { prefix: opts.sessionIdPrefix }),
    });
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

  /**
   * W736: the terminal write point of the state machine — a RUNNING row becomes
   * DONE / FAILED (plus `ended_at`, and `fail=<reason>` on failure), written
   * through the same atomic tmp+rename path as every other row write. A terminal
   * row is frozen: a second verdict, and any verdict about a foreign row, are
   * ignored (null).
   */
  finalize(wid: string, verdict: WorkerVerdict): WorkerEntry | null {
    const entry = this.rows.get(wid);
    if (entry === undefined || !isOwn(entry, this.ownPid) || entry.status !== "RUNNING") return null;
    const settled = terminalEntry(entry, verdict, this.now());
    this.rows.set(wid, settled);
    void this.persist();
    return { ...settled };
  }

  /** [finalize] addressed by session id — the driver's view of its own worker. */
  finalizeSession(sid: string, verdict: WorkerVerdict): WorkerEntry | null {
    const wid = this.widForSession(sid);
    return wid === null ? null : this.finalize(wid, verdict);
  }

  /** Is a driver task alive for this session? (the watchdog's liveness signal.) */
  isDriving(sid: string): boolean {
    return this.stops.has(sid);
  }

  /** Rust `release_session` (W224 F2): drop the session, its queue and its driver. */
  releaseSession(sid: string): void {
    this.sessionRegistry.remove(sid);
    this.mailboxRegistry.purge(sid);
    this.stopDriver(sid);
  }

  /**
   * W186/W736: re-dispatch a RUNNING row whose session ended without a
   * deliverable — a fresh session for the remembered brief, `retries+1`,
   * `started_at` refreshed, then driven again. The readable brief lives in the
   * in-memory spawn facts (the `brief=` tsv token is lossy by construction), so
   * a row with no remembered brief cannot be re-dispatched: null is returned and
   * the caller settles the row as FAILED instead.
   */
  respawn(wid: string): string | null {
    const entry = this.rows.get(wid);
    if (entry === undefined || !isOwn(entry, this.ownPid) || entry.status !== "RUNNING") return null;
    const oldSid = getExtra(entry, "sess");
    const remembered = oldSid === null ? undefined : this.spawns.get(oldSid);
    if (remembered === undefined || remembered.brief === "") return null;
    if (oldSid !== null && oldSid !== "") this.releaseSession(oldSid);
    const mode = remembered.mode ?? getExtra(entry, "mode");
    const session = this.sessionRegistry.create({
      title: `${wid}·${truncateChars(remembered.short, 20)}`,
      workspace: getExtra(entry, "workspace"),
      model: getExtra(entry, "model"),
      mode,
    });
    const extra = setTokens(dropTokens(entry.extra, ["fail", "ended_at"]), {
      sess: session.meta.id,
      retries: String(workerRetries(entry) + 1),
      driven: this.canDrive() ? "yes" : "no",
    });
    this.rows.set(wid, { ...entry, started_at: utcNow(this.now()), extra });
    this.rememberSpawn(session.meta.id, {
      wid,
      short: remembered.short,
      brief: remembered.brief,
      reportTo: remembered.reportTo,
      mode,
    });
    void this.persist();
    if (this.canDrive()) this.driveIfPossible(session.meta.id, remembered.brief);
    return session.meta.id;
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

  /**
   * W729: the mode a spawn inherits when it does not pass one — the mode of the
   * session that owns this registry (the composition sets it once, from
   * `session.json.mode`).
   */
  get hostMode(): string | null {
    return this.hostModeValue;
  }

  setHostMode(mode: string | null): void {
    this.hostModeValue = mode;
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
      onExit: (id, reason) => this.driverExited(id, reason),
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

  /**
   * Idempotent teardown: stop drivers, settle the rows they were driving, purge
   * queues, drop sessions and rows. A stopping host leaves no RUNNING row behind
   * (W736) — an abandoned row would otherwise read as RUNNING forever.
   */
  shutdown(): void {
    this.abortAllNow();
    this.settleOpenRows("registry-shutdown");
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

  /**
   * W736: the driver loop ended without a receipt verdict for a still-RUNNING
   * row — the worker never delivered. A row already settled (or already
   * replaced) is left alone, which is what makes a late exit harmless during
   * shutdown.
   */
  private driverExited(sid: string, reason: DriverExit): void {
    this.finalizeSession(sid, { ok: false, reason: `driver exited: ${reason}` });
  }

  /** W736: abandon every still-RUNNING own row as FAILED (see [shutdown]). */
  private settleOpenRows(reason: string): void {
    let touched = false;
    for (const entry of this.ownEntries()) {
      if (entry.status !== "RUNNING") continue;
      this.rows.set(entry.wid, terminalEntry(entry, { ok: false, reason }, this.now()));
      touched = true;
    }
    if (touched) void this.persist();
  }

  /**
   * W235/W736: the receipt protocol — write the report, settle the row from the
   * same verdict, then enqueue the receipt (once, Ok or Err alike). The row is
   * settled even without a `report_to` target: a finished brief is a finished
   * worker, and `worker_status` must not keep calling it RUNNING.
   */
  private closeLoop(sid: string, failure: string | null): void {
    const wid = this.widForSession(sid);
    if (wid === null) return;
    const entry = this.rows.get(wid);
    if (entry === undefined) return;
    const remembered = this.spawns.get(sid);
    const reportTo = remembered?.reportTo ?? getExtra(entry, "report_to");
    if (reportTo === null || reportTo === "") {
      this.finalize(wid, verdictOf(failure, null));
      return;
    }
    const req: ReceiptRequest = {
      wid,
      short: remembered?.short ?? getExtra(entry, "title") ?? wid,
      startedAt: entry.started_at,
      brief: remembered?.brief ?? getExtra(entry, "brief") ?? "",
      // W729: the mode line of the report header (in-memory fact first, then
      // the tsv token, so a row written by another process still reports one).
      mode: remembered?.mode ?? getExtra(entry, "mode"),
      reportTo,
      sid,
      resultsDir: this.resultsDirValue,
      log: this.sessionRegistry.logOf(sid),
      failure,
    };
    const result = executeReceipt(req);
    this.finalize(wid, verdictOf(failure, result));
    // W515 §4: the settlement notice carries its own envelope, so the host can
    // tell it apart from a relay message the worker sent on purpose.
    this.mailboxRegistry.send(reportTo, result.content, sid, {
      kind: "receipt",
      source: { kind: "subagent-settled", form: "notice", summary: receiptSummary(req, result.content), senderSessionId: sid },
    });
  }
}

/**
 * W736: the receipt verdict of one brief turn. A turn error fails the worker; so
 * does a receipt whose report could not be written, because then no deliverable
 * exists for the coordinator to read (stricter than Rust, which only warns).
 */
function verdictOf(failure: string | null, result: ReceiptResult | null): WorkerVerdict {
  if (failure !== null) return { ok: false, reason: failure };
  if (result !== null && result.warn !== "") return { ok: false, reason: `receipt not written:${result.warn}` };
  return { ok: true };
}

/**
 * W736: the terminal row of a verdict — status, `ended_at`, the `fail=<reason>`
 * token of a failure and `state=idle` (the driver's mailbox loop is at rest; a
 * stale `in-turn` on a frozen row would read as a turn still running). Pure, so
 * every terminal writer produces byte-identical rows.
 */
export function terminalEntry(entry: WorkerEntry, verdict: WorkerVerdict, nowMs: number): WorkerEntry {
  const status: WorkerStatus = verdict.ok ? "DONE" : "FAILED";
  const tokens: Record<string, string> = { ended_at: utcNow(nowMs), state: "idle" };
  if (!verdict.ok) tokens["fail"] = oneToken(truncateChars(sanitizeExtra(verdict.reason ?? "unspecified failure"), 200));
  return { ...entry, status, extra: setTokens(entry.extra, tokens) };
}

/** Fold whitespace so a value stays ONE `extra` token (the row format needs it). */
function oneToken(value: string): string {
  return value.replace(/\s+/g, "-");
}

/** One-line summary of a settlement notice (the DSH `source.summary` field). */
function receiptSummary(req: ReceiptRequest, content: string): string {
  const summary = lastAssistantSummaryOf(req.log);
  return summary === null ? truncateChars(content, 120) : truncateChars(summary, 120);
}

function lastAssistantSummaryOf(log: SessionLog | undefined): string | null {
  return log === undefined ? null : lastAssistantSummary(log.events());
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

/** Replace/insert several `k=v` tokens in one pass (every other token kept). */
function setTokens(extra: string, values: Record<string, string>): string {
  const keys = Object.keys(values);
  const tokens = dropTokens(extra, keys).split(/\s+/).filter((tok) => tok !== "");
  for (const key of keys) tokens.push(`${key}=${values[key]}`);
  return tokens.join(" ");
}

/** Remove every `k=v` token of the given keys. */
function dropTokens(extra: string, keys: readonly string[]): string {
  return extra
    .split(/\s+/)
    .filter((tok) => tok !== "" && !keys.some((k) => tok.startsWith(`${k}=`)))
    .join(" ");
}

function setToken(extra: string, key: string, value: string): string {
  return setTokens(extra, { [key]: value });
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
    // W736: the terminal stamp of the state machine (null while RUNNING).
    ended_at: getExtra(entry, "ended_at"),
    fail: getExtra(entry, "fail"),
    proc: proc === null ? null : Number.parseInt(proc, 10),
    extra: entry.extra,
  };
}

/** Timestamp helper re-exported for callers that build registry rows. */
export { utcNow };
