/**
 * W736 / ARCHITECTURE.md §7.3 step 5 — the worker watchdog.
 *
 * The architecture doc is explicit about the SHAPE: liveness judgement must be
 * "注册为独立插件（参考 Rust `WatchdogPlugin`），不要塞进后端实现里" — an
 * independent plugin, never a branch inside the driver or the registry backend.
 * This module is the TS port of `celestea_harness/crates/workers/src/watchdog.rs`
 * (W186) and the only owner of the question "is this RUNNING row still alive?".
 *
 * One tick (= one sweep) walks this process's RUNNING rows and adjudicates:
 *
 *   - the worker is still working (a live driver task, or a turn whose
 *     `turn_end` has not been written yet)          -> KeepRunning;
 *   - ended, and `results/<wid>*.md` exists         -> DONE (deliverable read);
 *   - ended, no deliverable, still inside the grace
 *     window since `started_at`                     -> GraceDeferred (no retry
 *                                                      storm on a slow start);
 *   - ended, no deliverable, `retries < maxRetries`
 *     and a recoverable brief                       -> Respawned (fresh session,
 *                                                      `retries+1`, re-driven);
 *   - ended, no deliverable, retries exhausted or no
 *     recoverable brief                             -> FAILED (with the reason);
 *   - the deliverable probe itself failed (IO)      -> ProbeError (skip this
 *                                                      round, never guess).
 *
 * Every status write goes through `WorkerRegistry.finalize` — the single terminal
 * write point, atomic tmp+rename — and a terminal row is frozen, so the watchdog
 * can never turn a DONE/FAILED row back into RUNNING (Rust registry.rs:474).
 *
 * Deliberate deviations from the Rust original:
 *   - only THIS process's rows are adjudicated (`ownEntries`, the `proc=` token
 *     rule of the status view): a stale row written by a dead process is left to
 *     its own watchdog rather than rewritten from here;
 *   - a live driver task counts as alive, because the TS driver parks on the
 *     mailbox between messages — a parked, addressable worker is genuinely up;
 *   - a missing results directory means "no deliverable yet" (ENOENT) instead of
 *     a probe error, so a worker that never wrote a report can still be failed;
 *   - the watcher/alert logs are opt-in (`watcherLog` / `alertsLog`, null by
 *     default) instead of being hard-wired to a deployment path.
 */

import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { definePlugin, type Plugin, type SessionEvent, type WorkerEntry } from "@celestea/core";
import type { WorkerRegistry } from "./registry.js";
import { getExtra, workerRetries } from "./registry-tsv.js";
import { utcNow, type WorkerVerdict } from "./types.js";

export const WATCHDOG_SERVICE = "celestea.workers.Watchdog";

export interface WatchdogConfig {
  /** Sweep period used by [Watchdog.start]. */
  intervalMs: number;
  /** Where a deliverable (`<wid>*.md`) is expected — the registry's results dir. */
  resultsDir: string;
  /** Re-dispatch ceiling: `retries >= maxRetries` fails the worker. */
  maxRetries: number;
  /** Fresh-spawn grace: a row younger than this is never re-dispatched. */
  graceMs: number;
  /** Append-only log of every verdict (`null` = no log file). */
  watcherLog: string | null;
  /** Append-only log of the verdicts worth a human (`null` = no log file). */
  alertsLog: string | null;
  /** Time source (tests freeze it). */
  now?: () => number;
}

/** Production defaults (Rust `WatchdogConfig::defaults`, minus the fixed paths). */
export const WATCHDOG_DEFAULTS: Omit<WatchdogConfig, "now"> = {
  intervalMs: 30_000,
  resultsDir: "results",
  maxRetries: 2,
  graceMs: 600_000,
  watcherLog: null,
  alertsLog: null,
};

export function watchdogConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return { ...WATCHDOG_DEFAULTS, ...overrides };
}

/** One verdict of a sweep, per row (Rust `WatchAction`). */
export type WatchAction =
  | { kind: "keep-running"; wid: string }
  | { kind: "done"; wid: string }
  | { kind: "grace-deferred"; wid: string }
  | { kind: "respawned"; wid: string; retries: number; sess: string }
  | { kind: "failed"; wid: string; reason: string }
  | { kind: "probe-error"; wid: string; error: string };

// --- pure predicates (unit-testable without a registry) --------------------

/**
 * Inverse of `utcNow` (`YYYY-MM-DD_HH:MM:SS`, optional trailing `Z`) in UTC
 * seconds; null when the stamp is unusable. Legacy rows without the `Z` mark
 * still parse (W234).
 */
export function parseUtc(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2}):(\d{2}):(\d{2})Z?$/.exec(text.trim());
  if (m === null) return null;
  const part = (i: number): number => Number.parseInt(m[i] ?? "", 10);
  const year = part(1);
  const month = part(2);
  const day = part(3);
  const hour = part(4);
  const minute = part(5);
  const second = part(6);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1_000);
}

/**
 * Is a turn still running? A `turn_start` without its `turn_end` is the only
 * liveness a log can prove (Rust W224 F3: pending mailbox mail does NOT count,
 * otherwise an ended worker is pinned at RUNNING forever).
 */
export function hasInProgressTurn(events: readonly SessionEvent[]): boolean {
  let open = 0;
  for (const ev of events) {
    if (ev.type === "turn_start") open += 1;
    else if (ev.type === "turn_end") open -= 1;
  }
  return open > 0;
}

export interface DeliverableProbe {
  found: boolean;
  /** Non-null only for a real IO failure; a missing directory = "not yet". */
  error: string | null;
}

/** Deliverable judgement: does `results/<wid>*.md` exist? (prefix rule as in Rust.) */
export function hasDeliverable(resultsDir: string, wid: string): DeliverableProbe {
  let names: string[];
  try {
    names = readdirSync(resultsDir);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { found: false, error: null }
      : { found: false, error: messageOf(error) };
  }
  return { found: names.some((name) => name.startsWith(wid) && name.endsWith(".md")), error: null };
}

/** Grace: `started_at` parsed, not in the future, younger than `graceSecs`. */
export function inGrace(startedAt: string, nowSecs: number, graceSecs: number): boolean {
  const started = parseUtc(startedAt);
  return started !== null && nowSecs >= started && nowSecs - started < graceSecs;
}

// --- the watchdog ----------------------------------------------------------

export class Watchdog {
  private readonly registry: WorkerRegistry;
  private readonly config: WatchdogConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(registry: WorkerRegistry, config: Partial<WatchdogConfig> = {}) {
    this.registry = registry;
    this.config = watchdogConfig({ resultsDir: registry.resultsDir, ...config });
  }

  get current(): WatchdogConfig {
    return this.config;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Start sweeping (idempotent); `unref` keeps the timer off the exit path. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.safeTick(), this.config.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep over this process's RUNNING rows, one verdict per row. */
  tick(): WatchAction[] {
    const nowMs = this.now();
    const stamp = utcNow(nowMs);
    const actions: WatchAction[] = [];
    for (const entry of this.registry.ownEntries()) {
      if (entry.status !== "RUNNING") continue;
      const action = this.tickOne(entry, Math.floor(nowMs / 1_000));
      actions.push(action);
      this.record(action, stamp);
    }
    return actions;
  }

  /** A sweep must never take the process down (timer errors are unhandled). */
  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      appendLine(this.config.watcherLog, `[${utcNow(this.now())}] watchdog tick failed: ${messageOf(error)}`);
    }
  }

  /** Adjudicate one RUNNING row (Rust `Watchdog::tick_one`). */
  private tickOne(entry: WorkerEntry, nowSecs: number): WatchAction {
    if (this.isAlive(entry)) return { kind: "keep-running", wid: entry.wid };
    const probe = hasDeliverable(this.config.resultsDir, entry.wid);
    if (probe.error !== null) return { kind: "probe-error", wid: entry.wid, error: probe.error };
    if (probe.found) return this.settle(entry, { ok: true });
    return this.anomaly(entry, nowSecs);
  }

  /** Ended without a deliverable: grace window, then re-dispatch, then FAILED. */
  private anomaly(entry: WorkerEntry, nowSecs: number): WatchAction {
    const wid = entry.wid;
    if (inGrace(entry.started_at, nowSecs, Math.floor(this.config.graceMs / 1_000))) {
      return { kind: "grace-deferred", wid };
    }
    const retries = workerRetries(entry);
    if (retries >= this.config.maxRetries) {
      return this.settle(entry, { ok: false, reason: `retries exhausted (${retries})` });
    }
    const sess = this.registry.respawn(wid);
    if (sess === null) return this.settle(entry, { ok: false, reason: "no recoverable brief to re-dispatch" });
    return { kind: "respawned", wid, retries: retries + 1, sess };
  }

  /** Terminal verdict of an ended worker: settle the row, then let the worker go. */
  private settle(entry: WorkerEntry, verdict: WorkerVerdict): WatchAction {
    this.registry.finalize(entry.wid, verdict);
    this.release(entry);
    if (verdict.ok) return { kind: "done", wid: entry.wid };
    return { kind: "failed", wid: entry.wid, reason: verdict.reason ?? "unspecified failure" };
  }

  /** Alive = its driver task is running, or a turn is open on its log. */
  private isAlive(entry: WorkerEntry): boolean {
    const sid = getExtra(entry, "sess") ?? "";
    if (sid === "") return false;
    if (this.registry.isDriving(sid)) return true;
    const log = this.registry.sessions.logOf(sid);
    return log !== undefined && hasInProgressTurn(log.events());
  }

  /** Rust F2: a settled worker gives up its session, its queue and its driver. */
  private release(entry: WorkerEntry): void {
    const sid = getExtra(entry, "sess") ?? "";
    if (sid !== "") this.registry.releaseSession(sid);
  }

  /** watcher.log sees every verdict; alerts.log only the ones a human needs. */
  private record(action: WatchAction, stamp: string): void {
    appendLine(this.config.watcherLog, `[${stamp}] ${describe(action)}`);
    if (action.kind !== "keep-running" && action.kind !== "done") {
      appendLine(this.config.alertsLog, `[${stamp}] ${describe(action)}`);
    }
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }
}

/**
 * The watchdog as an INDEPENDENT plugin (ARCHITECTURE.md §7.3 step 5): it owns no
 * worker state, it only reads the registry and adjudicates. Mount it after the
 * workers plugin. `autostart: false` leaves the cadence to the caller
 * (`watchdog.tick()`), which is what tests do.
 */
export interface WatchdogPluginOptions {
  registry: WorkerRegistry;
  config?: Partial<WatchdogConfig>;
  /** Pre-built watchdog (wins over `config`). */
  watchdog?: Watchdog;
  /** Start sweeping at mount time (default true). */
  autostart?: boolean;
  /** Mount name (auto-named when omitted). */
  name?: string;
}

export function watchdogPlugin(opts: WatchdogPluginOptions): Plugin {
  const watchdog = opts.watchdog ?? new Watchdog(opts.registry, opts.config);
  const name = opts.name ?? "celestea.workers.Watchdog";
  return definePlugin(name, (ctx) => {
    ctx.provide(WATCHDOG_SERVICE, watchdog);
    if (opts.autostart !== false) watchdog.start();
  });
}

// --- internals -------------------------------------------------------------

/** Human line for one verdict (the watcher/alert log body). */
function describe(action: WatchAction): string {
  switch (action.kind) {
    case "keep-running":
      return `${action.wid} keep-running`;
    case "done":
      return `${action.wid} -> DONE (deliverable present)`;
    case "grace-deferred":
      return `${action.wid} anomaly (ended, no deliverable), in grace, deferred`;
    case "respawned":
      return `${action.wid} AUTO-RESPAWN #${action.retries} sess=${action.sess}`;
    case "failed":
      return `${action.wid} -> FAILED (${action.reason})`;
    case "probe-error":
      return `${action.wid} deliverable probe IO error: ${action.error}; skip`;
  }
}

/** Best-effort append: an unwritable log must never break a sweep. */
function appendLine(path: string | null, line: string): void {
  if (path === null) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // Logging is diagnostics, not state (W180 B1(c)).
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
