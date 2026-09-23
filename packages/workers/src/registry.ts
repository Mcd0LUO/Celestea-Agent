/**
 * WorkerRegistry — the in-memory + `registry.tsv` state of every worker this
 * process owns, plus the seams that make a worker drivable (W185/W232/W248).
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renameWithRetry, type WorkerEntry, type WorkerStatus } from "@celestea/core";
import { runDriverLoop, type DriverExit, type WorkerDrivers } from "./driver.js";
import { executeReceipt, receiptSummary, verdictOf, type ReceiptRequest } from "./receipt.js";
import { SessionMailbox } from "./mailbox.js";
import { SessionRegistry } from "./sessions.js";
import type { SessionLogFactory } from "./log.js";
import {
  REGISTRY_TSV_PATH,
  getExtra,
  leaseToken,
  mergeTableRows,
  parseRegistryTsv,
  readTable,
  receiptDelivered,
  receiptKey,
  receiptToken,
  serializeRegistryTsv,
  summarize,
  workerAttempt,
  workerRetries,
} from "./registry-tsv.js";
import { dropTokens, entryView, isOwn, setToken as setTokenOf, terminalEntry, withProc, withState, withTokens } from "./row.js";
import { observeWorkerTable, pidAliveDefault, workerOwner, type WorkerRecoveryOptions, type WorkerRecoveryReport } from "./recovery.js";
import { hydrateSessions, inheritableRows, statusView } from "./rehydrate.js";
import { sanitizeExtra, utcNow, workerTitle, type SpawnInfo, type WorkerSession, type WorkerVerdict } from "./types.js";
import { PersistFailureLog, type PersistFailure } from "./persist-log.js";

// W787: the pure ROW-FORMAT helpers moved to `row.ts` (§4.1 budget); their public
// import path stays `registry.js`, so no caller changed.
export { entryView, isOwn, withProc, withState } from "./row.js";

export const RESULTS_DIR_DEFAULT = "results";
export const WORKER_REGISTRY_SERVICE = "celestea.workers.WorkerRegistry";

export type { SpawnInfo } from "./types.js";

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
  /**
   * E §2.2.2 (`host=`): the HOST conversation this registry dispatches for. The
   * row records it, so a boot observer (and P2's re-dispatch) can tell WHERE a
   * worker belonged even after the process that spawned it is gone (G2-6).
   */
  hostSessionId?: string | null;
  now?: () => number;
  pid?: number;
  /**
   * W831 R3 B4 (R2-A4): file a failed persist is appended to (null = no file).
   * Persist never throws (W180 B1(c)), so without a sink the mismatch
   * "memory DONE / disk RUNNING" would be invisible.
   */
  alertsLog?: string | null;
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
  private readonly persistLog: PersistFailureLog;
  private drivers: WorkerDrivers | null = null;
  private resultsDirValue: string;
  private sourceLabelValue: string;
  private hostModeValue: string | null;
  private readonly hostSessionValue: string | null;
  private released = false;

  constructor(opts: WorkerRegistryOptions = {}) {
    this.path = opts.tsvPath === undefined ? REGISTRY_TSV_PATH : opts.tsvPath;
    this.resultsDirValue = opts.resultsDir ?? RESULTS_DIR_DEFAULT;
    this.sourceLabelValue = opts.sourceLabel ?? "unknown";
    this.hostModeValue = opts.hostMode ?? null;
    this.hostSessionValue = opts.hostSessionId ?? null;
    this.now = opts.now ?? Date.now;
    this.ownPid = opts.pid ?? process.pid;
    this.persistLog = new PersistFailureLog(opts.alertsLog ?? null);
    this.sessionRegistry = new SessionRegistry({
      logFactory: opts.logFactory,
      ...(opts.sessionIdPrefix === undefined ? {} : { prefix: opts.sessionIdPrefix }),
    });
    this.mailboxRegistry = new SessionMailbox(this.now);
    this.reload();
  }

  // --- table state -------------------------------------------------------

  /**
   * Re-read the tsv table (missing file = empty table; bad rows are skipped) and
   * rebuild the ADDRESSABLE state the table still describes (W1470). The rebuild
   * is read-only: it adopts the persisted sessions and reserves their ids, so a
   * restart can address the previous generation's workers and can never hand
   * their session ids to a new one.
   */
  reload(): void {
    this.rows.clear();
    if (this.path !== null) {
      try {
        for (const entry of parseRegistryTsv(readFileSync(this.path, "utf8")).entries) this.rows.set(entry.wid, entry);
      } catch {
        /* a missing / unreadable table is an empty table (W180 B1(c)) */
      }
    }
    hydrateSessions(this.sessionRegistry, this.entries(), { host: this.hostSessionValue, prefix: this.sessionRegistry.prefixOf });
  }

  /** Whole table in insertion order (foreign rows included). */
  entries(): WorkerEntry[] {
    return [...this.rows.values()].map((e) => ({ ...e }));
  }

  /**
   * Rows THIS registry owns — the only ones its status view counts.
   *
   * W787: ownership is `proc=<pid>` PLUS, when the registry declares a host
   * conversation, `host=<sid>`. One process now shares ONE table across every
   * session (`host=` tells them apart, §2.2.2), so the process-wide `proc` rule
   * alone would make two sessions see — and adjudicate — each other's workers.
   * A registry with no declared host (the embedded / legacy case) keeps the
   * original `proc`-only rule, so nothing that worked before changed.
   */
  ownEntries(): WorkerEntry[] {
    return this.entries().filter((e) => this.isMine(e));
  }

  getEntry(wid: string): WorkerEntry | undefined {
    const row = this.rows.get(wid);
    return row === undefined ? undefined : { ...row };
  }

  /** Insert/replace one row (stamping this process's `proc` token) + persist. */
  upsert(entry: WorkerEntry): string | null {
    this.rows.set(entry.wid, withProc(entry, this.ownPid));
    return this.persistObserved(entry.wid);
  }

  /** Mark a worker's state token (`idle` / `in-turn`); DONE/FAILED rows are frozen. */
  setWorkerState(sid: string, state: string): void {
    const wid = this.widForSession(sid);
    const entry = wid === null ? undefined : this.rows.get(wid);
    if (wid === null || entry === undefined || entry.status !== "RUNNING") return;
    // E §2.2.2: driver activity RENEWS `lease=<pid>@<unix>` — that is what makes
    // "the owner is still driving this row" observable without a timer (P2 adds
    // the heartbeat cadence).
    this.rows.set(wid, withTokens(withState(entry, state), { lease: this.lease() }));
    void this.persistObserved(wid);
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
    if (entry === undefined || !this.isMine(entry) || entry.status !== "RUNNING") return null;
    const settled = terminalEntry(entry, verdict, this.now());
    this.rows.set(wid, settled);
    void this.persistObserved(wid);
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

  /** `release_session` (W224 F2): drop the session, its queue and its driver. */
  releaseSession(sid: string): void {
    this.sessionRegistry.remove(sid);
    this.mailboxRegistry.purge(sid);
    this.stopDriver(sid);
    // W831 R3 B4 (W813 P1-spawns): the readable brief dies with the session.
    // respawn() copies the facts out BEFORE calling this, so a re-dispatch still
    // has its brief; without this a long-lived host pins every brief forever.
    this.spawns.delete(sid);
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
    if (entry === undefined || !this.isMine(entry) || entry.status !== "RUNNING") return null;
    const oldSid = getExtra(entry, "sess");
    const remembered = oldSid === null ? undefined : this.spawns.get(oldSid);
    if (remembered === undefined || remembered.brief === "") return null;
    if (oldSid !== null && oldSid !== "") this.releaseSession(oldSid);
    const mode = remembered.mode ?? getExtra(entry, "mode");
    const session = this.sessionRegistry.create({
      title: workerTitle(wid, remembered.short),
      workspace: getExtra(entry, "workspace"),
      model: getExtra(entry, "model"),
      mode,
      permission: remembered.permission ?? null,
    });
    // E §2.2.2 + §5.2: a re-dispatch is the NEXT attempt of the same wid
    // (0 -> 1, the 0-based cross-capability convention) — the report name and the
    // receipt key both derive from it (G2-2/G2-3).
    const attempt = workerAttempt(entry) + 1;
    const cleared = { ...entry, extra: dropTokens(entry.extra, ["fail", "ended_at", "receipt"]) };
    const extra = withTokens(cleared, {
      sess: session.meta.id,
      retries: String(workerRetries(entry) + 1),
      attempt: String(attempt),
      lease: this.lease(),
      driven: this.canDrive() ? "yes" : "no",
    }).extra;
    this.rows.set(wid, { ...entry, started_at: utcNow(this.now()), extra });
    this.rememberSpawn(session.meta.id, {
      wid,
      short: remembered.short,
      brief: remembered.brief,
      reportTo: remembered.reportTo,
      mode,
      permission: remembered.permission ?? null,
    });
    void this.persistObserved(wid);
    if (this.canDrive()) this.driveIfPossible(session.meta.id, remembered.brief);
    return session.meta.id;
  }

  /**
   * `worker_status` payload: the summary of the OWN rows, or one worker when
   * filtered. W1470: a wid the persisted table names is reported too (marked
   * `inherited`), because "the table still names it" is a fact — see
   * `rehydrate.ts` (`statusView`).
   */
  status(wid?: string | null): Record<string, unknown> {
    return statusView(this, wid);
  }

  /**
   * W1470: rows of a PREVIOUS generation of this host conversation — the table
   * names their session, their owner process is gone, and this registry has not
   * claimed them. Visible (and addressable) but never counted as own workers.
   */
  inheritedEntries(): WorkerEntry[] {
    return inheritableRows(this.entries(), { host: this.hostSessionValue, prefix: this.sessionRegistry.prefixOf }).filter((e) => !this.isMine(e));
  }

  /**
   * W1470 P2 (§2.2.4): take a DEAD generation's RUNNING row under this process,
   * so the terminal write point may settle it. Refuses — always — a row that is
   * already ours, a frozen row, a row of another host conversation, and a row
   * whose recorded owner is still ALIVE: liveness is the only licence to take a
   * row over, and this method re-checks it rather than trusting the caller.
   *
   * The host guard is also what keeps [persist]'s merge honest: a write merges
   * `ownEntries()` over the table, so a row that fails [mayInherit] would be
   * mutated in memory and silently dropped on disk. Claim and ownership must
   * therefore ask the SAME question — they do.
   */
  claim(wid: string, pidAlive: (pid: number) => boolean = pidAliveDefault): WorkerEntry | null {
    const entry = this.rows.get(wid);
    if (entry === undefined || entry.status !== "RUNNING" || !this.mayInherit(entry) || isOwn(entry, this.ownPid)) return null;
    const owner = workerOwner(entry);
    if (owner !== null && pidAlive(owner.pid)) return null;
    const taken = withTokens(entry, { proc: String(this.ownPid), lease: this.lease(), claimed: this.lease() });
    this.rows.set(wid, taken);
    void this.persistObserved(wid);
    return { ...taken };
  }

  /**
   * E §2.2.4: judge every row of the table for a boot observer. OBSERVATION
   * ONLY — nothing here settles, re-dispatches or rewrites a row (P0).
   */
  recoverCandidates(opts: WorkerRecoveryOptions = {}): WorkerRecoveryReport {
    return observeWorkerTable(this.entries(), opts);
  }

  /**
   * E §2.2.3: the cross-process idempotency key of a worker's receipt
   * (`receipt:<wid>:<attempt>`), or null for a session this registry does not
   * know. The host inbox deduplicates on exactly this string (B3), so a receipt
   * replayed by a restarted driver is injected once.
   */
  receiptKeyFor(sid: string): string | null {
    const wid = this.widForSession(sid);
    const entry = wid === null ? undefined : this.rows.get(wid);
    return entry === undefined ? null : receiptKey(entry.wid, workerAttempt(entry));
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

  /** E §2.2.2: the host conversation stamped into every row this registry writes. */
  get hostSessionId(): string | null {
    return this.hostSessionValue;
  }

  /** `lease=<pid>@<unix>` of THIS process at the current instant. */
  lease(): string {
    return leaseToken(this.ownPid, this.now());
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
   * Start the mailbox event loop for one worker (prune first, F1). Returns
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

  /** Record the delivered receipt key on a settled row (one atomic write). */
  private markReceipt(wid: string, attempt: number): void {
    const row = this.rows.get(wid);
    if (row === undefined) return;
    this.rows.set(wid, { ...row, extra: setTokenOf(row.extra, "receipt", receiptToken(wid, attempt)) });
    void this.persistObserved(wid);
  }

  /**
   * Atomic write (tmp + rename); a failure is reported, never thrown (W180
   * B1(c)). W787: the write MERGES with the rows other session registries of this
   * process already put in the shared table, then refreshes the in-memory view
   * from the merge — writing `entries()` alone would drop a sibling's worker.
   *
   * W825 P0 (registry.tsv stale-snapshot rollback): the merge base is the table
   * as it is ON DISK right now (read-modify-write), and only THIS registry's own
   * rows may win over it. The in-memory view also holds a copy of every FOREIGN
   * row it loaded at construction, and that copy can be stale: session B reloads
   * W1(RUNNING), session A finalizes W1(DONE), and B's next write would then put
   * its old RUNNING copy back. `ownEntries()` — not `entries()` — is the
   * authoritative side of the merge, so a sibling's terminal row is never rolled
   * back (T-3: /tmp/w822-reg.mts, W822 R2 verification).
   */
  private persist(): string | null {
    if (this.path === null) return null;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // W831 R3 B4 (W813 P1-persist-foreign): a READ failure ABORTS the write.
      // The old readTableRows -> [] made the merge base empty, so the rename
      // deleted every foreign row. Only an absent file is an empty table.
      const read = readTable(this.path);
      if (read.error !== null) return "registry write aborted: cannot read " + this.path + ": " + read.error;
      const merged = mergeTableRows(read.rows, this.ownEntries());
      this.rows.clear();
      for (const row of merged) this.rows.set(row.wid, row);
      const tmp = `${this.path}.tmp-${this.ownPid}-${this.now()}`;
      // W831 R3 B4 (W813 P1-persist-foreign): carry unparsed lines through.
      writeFileSync(tmp, serializeRegistryTsv(merged) + read.raw.map((line) => line + "\n").join(""), "utf8");
      renameWithRetry(tmp, this.path);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** W831 R3 B4 (R2-A4): [persist] plus the observability sink (never throws). */
  private persistObserved(wid: string | null): string | null {
    const error = this.persist();
    if (error === null) return null;
    this.persistLog.record({ at: utcNow(this.now()), path: this.path ?? "", wid, error });
    return error;
  }

  /** W831 R3 B4 (R2-A4): the persist failures this instance has seen. */
  persistFailures(): readonly PersistFailure[] {
    return this.persistLog.list();
  }

  /**
   * Ownership of one row (see [ownEntries]): `proc`, and — when the registry
   * declares a host conversation — `host=`. A row with NO `host=` token is kept
   * when `proc` matches: such a row was written by an older build or by an
   * embedded caller that upserts directly, so `proc` is the only ownership
   * evidence it carries, and hiding it would lose a row this process owns.
   */
  private isMine(entry: WorkerEntry): boolean {
    return isOwn(entry, this.ownPid) && this.mayInherit(entry);
  }

  /**
   * Does the row belong to THIS host conversation? A row with NO `host=` token
   * (pre-W787 / directly upserted) is kept: `proc` is then the only evidence it
   * carries. W1470: [claim] asks the same question, so ownership and takeover
   * can never disagree about whose row it is.
   */
  private mayInherit(entry: WorkerEntry): boolean {
    const host = this.hostSessionValue;
    if (host === null) return true;
    const rowHost = getExtra(entry, "host");
    return rowHost === null || rowHost === host;
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
    // W831 R3 B4 (W813 P1-spawns): the loop is gone, so its in-memory brief is
    // dead too. runDriverLoop ALWAYS reports onExit, so this is the single
    // cleanup for every driven session; releaseSession covers the rest.
    this.spawns.delete(sid);
  }

  /** W736: abandon every still-RUNNING own row as FAILED (see [shutdown]). */
  private settleOpenRows(reason: string): void {
    let touched = false;
    for (const entry of this.ownEntries()) {
      if (entry.status !== "RUNNING") continue;
      this.rows.set(entry.wid, terminalEntry(entry, { ok: false, reason }, this.now()));
      touched = true;
    }
    if (touched) void this.persistObserved(null);
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
    const attempt = workerAttempt(entry);
    // E §2.2.3: ONE receipt per `(wid, attempt)`, decided by the ROW (durable),
    // never by a memory sequence — a replayed closeLoop finds the token and stops.
    if (receiptDelivered(entry, attempt)) return;
    const req: ReceiptRequest = {
      wid,
      attempt,
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
    const settled = this.finalize(wid, verdictOf(failure, result));
    // The token rides the SAME atomic row write as the verdict, so "delivered"
    // can never be recorded for a row the verdict did not reach.
    if (settled !== null) this.markReceipt(wid, attempt);
    // W515 §4: the settlement notice carries its own envelope, so the host can
    // tell it apart from a relay message the worker sent on purpose.
    this.mailboxRegistry.send(reportTo, result.content, sid, {
      kind: "receipt",
      source: { kind: "subagent-settled", form: "notice", summary: receiptSummary(req, result.content), senderSessionId: sid },
    });
  }
}

/** Timestamp helper re-exported for callers that build registry rows. */
export { utcNow };
