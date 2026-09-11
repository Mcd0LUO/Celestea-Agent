/**
 * Cost & usage ledger (iteration E §3 P0, W728) — append-only, step granularity.
 *
 * One JSON line per model step in `<data dir>/usage-ledger.jsonl`, plus one
 * `turn_total` line per turn for reconciliation. The file is the durable,
 * never-rewritten record of what was spent: the in-memory usage tracker is
 * reset by every generation rebuild (§3.1 G3-1), the ledger is not.
 *
 * Discipline (all mechanical, see the §3.4 assertions):
 *   - append-only: a line is written once and never edited (no rewrite, no
 *     compaction, no rotation in P0 — rotation is §3.3 P1);
 *   - one `writeSync` on an `O_APPEND` fd per record, mode 0600, so concurrent
 *     writers cannot interleave a line;
 *   - idempotent: the key is `(session, turn_id, step, attempt)`; a key already
 *     booked by THIS writer is skipped, never rewritten. The key set is
 *     per-process ON PURPOSE: seeding it from the file would silently drop
 *     legitimate out-of-turn rows, whose turn_id is null and whose step index
 *     restarts at 1 after a restart (cross-process dedupe belongs to the P1
 *     work on rotation, §3.3);
 *   - no prompt/message text and no credential can reach a line: a record is
 *     built from counters, names and prices only (§3.5 R3-4);
 *   - observation only: a write failure is reported on stderr and swallowed —
 *     bookkeeping must never change request behaviour (§3.5 R3-3).
 *
 * WHERE a step is observed: `packages/llm`'s `LlmError.httpStatus/retryable`
 * (W723) is only visible at the `Llm` seam, and so are the step boundaries — a
 * stream that tears AFTER a usage frame is ONE error row, not an ok row plus an
 * error row (§3.2.3). [createLedgerLlm] therefore drives `beginStep` → one
 * `record` per usage frame → `close` at the stream's terminal event, while the
 * turn boundaries come from the runtime's [TurnLedgerHooks]. [UsageLedger]
 * still implements the runtime's structural `UsageAccounting` seam, and its
 * `latest`/`total` views are derived from the FILE, so they survive a restart.
 */

import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { usageAdd, zeroUsage, type SessionEvent, type SessionLog, type TurnOutcome, type Usage } from "@celestea/core";
import {
  costAdd,
  costOf,
  emptyPricing,
  loadPricingFile,
  priceFor,
  priceSnapshot,
  pricingPath,
  type LedgerCost,
  type PriceSnapshot,
  type PricingTable,
} from "./pricing.js";
import type { UsageAccounting } from "./usage.js";

/** `<data dir>/usage-ledger.jsonl` (§3.2.1). */
export const USAGE_LEDGER_FILE = "usage-ledger.jsonl";
/** `CELESTEA_USAGE_LEDGER=off` disables the ledger entirely (§3.5 R3-3). */
export const ENV_USAGE_LEDGER = "CELESTEA_USAGE_LEDGER";
/** Path override (`CELESTEA_USAGE_LEDGER_FILE`). */
export const ENV_USAGE_LEDGER_FILE = "CELESTEA_USAGE_LEDGER_FILE";
/** Record version, written as `v` on every line. */
export const LEDGER_VERSION = 1;

export type LedgerStepKind = "ok" | "error";
export type PricedBy = "table" | "record" | "unpriced";

/** The model half of a record (§3.2.1). */
export interface LedgerModelInfo {
  provider: string | null;
  model: string | null;
  base_url_host: string | null;
}

/** One step row: `kind: "ok"` (a response arrived) or `"error"` (§3.2.3). */
export interface UsageStepRecord extends LedgerModelInfo {
  v: number;
  ts: number;
  kind: LedgerStepKind;
  session: string;
  turn: number | null;
  turn_id: string | null;
  step: number;
  attempt: number;
  usage: Usage | null;
  /** true = the provider reported no usage: the cost is UNKNOWN, not 0. */
  billed_unknown: boolean;
  error_kind: string | null;
  http_status: number | null;
  retryable: boolean | null;
  price: PriceSnapshot | null;
  cost: LedgerCost | null;
  priced_by: PricedBy;
  fallback_from: string | null;
}

/** The per-turn summary row (a reconciliation convenience; details stay). */
export interface UsageTurnTotalRecord {
  v: number;
  ts: number;
  kind: "turn_total";
  session: string;
  turn: number | null;
  turn_id: string | null;
  steps: number;
  attempts: number;
  usage: Usage;
  cost: LedgerCost | null;
  /** false = at least one contributing row was unpriced or unbilled. */
  cost_complete: boolean;
  priced_by: PricedBy;
  unpriced_models: string[];
  billed_unknown_steps: number;
  outcome: TurnOutcome;
}

export type UsageLedgerRecord = UsageStepRecord | UsageTurnTotalRecord;

/** What the ledger is told when a model step opens. */
export interface LedgerStepInfo extends LedgerModelInfo {
  /** 0 = first attempt; retries/fallbacks increment (§5.2). P0 writes 0. */
  attempt: number;
  fallback_from: string | null;
}

/** The terminal verdict of one step (the only place a failure is announced). */
export interface LedgerStepOutcome {
  kind: LedgerStepKind;
  error_kind?: string | null;
  http_status?: number | null;
  retryable?: boolean | null;
}

/** The handle [UsageLedger.beginStep] hands back: one buffer per model step. */
export interface LedgerStepHandle {
  record(usage: Usage): void;
  close(outcome: LedgerStepOutcome): void;
}

/** Write side of the ledger, as consumed by the `Llm` step observer. */
export interface LedgerStepSink {
  beginStep(info: LedgerStepInfo): LedgerStepHandle;
}

/** Turn lifecycle hooks the runtime calls (observation only, never throws). */
export interface TurnLedgerHooks {
  beginTurn(log: SessionLog): void;
  endTurn(outcome: TurnOutcome): void;
}

/** The open turn of a session log: the newest `turn_start` with no `turn_end`. */
export function openTurnOf(events: readonly SessionEvent[]): { id: string; turn: number | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === "turn_end") return null;
    if (ev.type === "turn_start") return { id: ev.id, turn: turnNumberOf(ev.id) };
  }
  return null;
}

/** `turn-7` -> 7 (the ledger only needs the display number of the log's id). */
export function turnNumberOf(id: string): number | null {
  const m = /^turn-(\d+)$/.exec(id);
  if (m === null || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** The idempotency key of a step row (§3.2.3). */
export function ledgerKey(record: Pick<UsageStepRecord, "session" | "turn_id" | "step" | "attempt">): string {
  return `${record.session}|${record.turn_id ?? "-"}|${record.step}|${record.attempt}`;
}

/** Append-only writer of one ledger file, shared by every session (§3.6). */
export class UsageLedgerFile {
  private fd: number | null = null;
  private readonly keys = new Set<string>();
  private readonly target: string;
  private readonly clock: () => number;
  readonly pricing: PricingTable;

  constructor(opts: { path: string; pricing?: PricingTable; now?: () => number }) {
    this.target = opts.path;
    this.clock = opts.now ?? Date.now;
    this.pricing = opts.pricing ?? emptyPricing(null);
  }

  /** Absolute path of the append-only ledger. */
  get path(): string {
    return this.target;
  }

  /** Second-resolution timestamp of a row (the ledger's own injectable clock). */
  stamp(): number {
    return Math.floor(this.clock() / 1000);
  }

  /**
   * Append one record. False = the key was already booked, or the write failed
   * (reported on stderr, never thrown: bookkeeping cannot break a turn).
   */
  append(record: UsageLedgerRecord, key: string | null = null): boolean {
    if (key !== null && this.keys.has(key)) return false;
    if (key !== null) this.keys.add(key);
    try {
      writeSync(this.ensureFd(), `${JSON.stringify(record)}\n`);
      return true;
    } catch (e) {
      warn(`ledger write failed (${errorText(e)})`);
      return false;
    }
  }

  /** Every readable record, in file order (an unparsable line is skipped). */
  read(): UsageLedgerRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.target, "utf8");
    } catch {
      return [];
    }
    const out: UsageLedgerRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) out.push(parsed as UsageLedgerRecord);
      } catch {
        // A torn/foreign line never hides the rows around it.
      }
    }
    return out;
  }

  /** Close the descriptor (idempotent; the file itself is never truncated). */
  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // A descriptor we cannot close must not fail a shutdown.
    }
    this.fd = null;
  }

  /** One `O_APPEND` descriptor; one `writeSync` per record keeps lines whole. */
  private ensureFd(): number {
    if (this.fd === null) this.fd = openSync(this.target, "a", 0o600);
    return this.fd;
  }
}

/** One turn's running sums (flushed as the `turn_total` row). */
interface TurnAcc {
  turnId: string | null;
  turn: number | null;
  steps: number;
  attempts: number;
  usage: Usage;
  cost: LedgerCost | null;
  unpriced: Set<string>;
  billedUnknown: number;
}

/** Where one closed step belongs (captured when the step OPENED). */
interface StepRef {
  info: LedgerStepInfo;
  turnId: string | null;
  turn: number | null;
}

/** Per-session ledger: usage frames in, append-only rows out (§3.3 P0 ①–④). */
export class UsageLedger implements UsageAccounting, LedgerStepSink, TurnLedgerHooks {
  private readonly file: UsageLedgerFile;
  private readonly session: string;
  private logRef: SessionLog | null = null;
  private acc: TurnAcc | null = null;
  private current: LedgerStepHandle | null = null;

  constructor(opts: { session: string; file: UsageLedgerFile }) {
    this.session = opts.session;
    this.file = opts.file;
  }

  /** The process-shared file this session books into. */
  get ledgerFile(): UsageLedgerFile {
    return this.file;
  }

  /** Turn start: bind the session log, drop the previous turn's buffer. */
  beginTurn(log: SessionLog): void {
    this.logRef = log;
    this.acc = null;
  }

  /** Turn end: flush the summary row (a turn that booked nothing writes none). */
  endTurn(outcome: TurnOutcome): void {
    const acc = this.acc;
    this.acc = null;
    if (acc === null || acc.steps === 0) return;
    const complete = acc.unpriced.size === 0 && acc.billedUnknown === 0;
    this.file.append({
      v: LEDGER_VERSION,
      ts: this.file.stamp(),
      kind: "turn_total",
      session: this.session,
      turn: acc.turn,
      turn_id: acc.turnId,
      steps: acc.steps,
      attempts: acc.attempts,
      usage: { ...acc.usage },
      cost: acc.cost === null ? null : { ...acc.cost },
      cost_complete: complete,
      priced_by: complete ? "table" : "unpriced",
      unpriced_models: [...acc.unpriced].sort(),
      billed_unknown_steps: acc.billedUnknown,
      outcome,
    });
  }

  /**
   * Open one model step. The turn identity is captured HERE (not at close), so
   * a step that outlives its turn still books against the turn it belongs to.
   */
  beginStep(info: LedgerStepInfo): LedgerStepHandle {
    const open = this.logRef === null ? null : openTurnOf(this.logRef.events());
    const ref: StepRef = { info, turnId: open?.id ?? null, turn: open?.turn ?? null };
    const handle = this.stepHandle(ref);
    this.current = handle;
    return handle;
  }

  /** UsageRecorder: one frame for whichever step is open (see [beginStep]). */
  record(usage: Usage): void {
    this.current?.record(usage);
  }

  /** Usage of the most recent booked step of this session (file-derived). */
  latest(): Usage {
    for (const record of this.rows()) {
      if (record.usage !== null) return { ...record.usage };
    }
    return zeroUsage();
  }

  /** Every token this session ever booked (survives a restart, §3.4 C5). */
  total(): Usage {
    return aggregateUsage(this.rows()).tokens;
  }

  /** C3/C5 view: tokens, cost, and the models the table could not price. */
  totals(): LedgerTotals {
    return aggregateUsage(this.rows());
  }

  /** This session's step rows, newest first (`turn_total` rows excluded). */
  private rows(): UsageStepRecord[] {
    return this.file
      .read()
      .filter((r): r is UsageStepRecord => r.kind !== "turn_total" && r.session === this.session)
      .reverse();
  }

  /** One handle per step: its own buffer, closed at most once. */
  private stepHandle(ref: StepRef): LedgerStepHandle {
    let buffered: Usage | null = null;
    let closed = false;
    return {
      record: (usage: Usage): void => {
        if (!closed) buffered = usage;
      },
      close: (outcome: LedgerStepOutcome): void => {
        if (closed) return;
        closed = true;
        if (outcome.kind === "ok" && buffered === null) return;
        this.book(ref, outcome, buffered);
      },
    };
  }

  /** Build the row of one closed step and append it (idempotent by key). */
  private book(ref: StepRef, outcome: LedgerStepOutcome, usage: Usage | null): void {
    const acc = this.accumulator(ref.turnId, ref.turn);
    const price = usage === null ? null : priceFor(this.file.pricing, ref.info.model);
    const cost = usage !== null && price !== null ? costOf(usage, price) : null;
    const record: UsageStepRecord = {
      v: LEDGER_VERSION,
      ts: this.file.stamp(),
      kind: outcome.kind,
      session: this.session,
      turn: ref.turn,
      turn_id: ref.turnId,
      step: acc.steps + 1,
      attempt: ref.info.attempt,
      provider: ref.info.provider,
      model: ref.info.model,
      base_url_host: ref.info.base_url_host,
      usage: usage === null ? null : { ...usage },
      billed_unknown: usage === null,
      error_kind: outcome.error_kind ?? null,
      http_status: outcome.http_status ?? null,
      retryable: outcome.retryable ?? null,
      price: price === null ? null : priceSnapshot(this.file.pricing, price),
      cost,
      priced_by: cost === null ? "unpriced" : "table",
      fallback_from: ref.info.fallback_from,
    };
    if (!this.file.append(record, ledgerKey(record))) return;
    acc.steps += 1;
    acc.attempts += ref.info.attempt + 1;
    if (usage !== null) acc.usage = usageAdd(acc.usage, usage);
    if (cost !== null) acc.cost = acc.cost === null ? cost : costAdd(acc.cost, cost);
    if (usage !== null && cost === null) acc.unpriced.add(ref.info.model ?? "(unknown model)");
    if (usage === null) acc.billedUnknown += 1;
  }

  /** The accumulator of the step's turn, created on first use. */
  private accumulator(turnId: string | null, turn: number | null): TurnAcc {
    if (this.acc !== null && this.acc.turnId === turnId) return this.acc;
    this.acc = {
      turnId,
      turn,
      steps: 0,
      attempts: 0,
      usage: zeroUsage(),
      cost: null,
      unpriced: new Set<string>(),
      billedUnknown: 0,
    };
    return this.acc;
  }
}

/** Factory form (`createXxx` convention, ARCHITECTURE.md §6.1). */
export function createUsageLedger(opts: { session: string; file: UsageLedgerFile }): UsageLedger {
  return new UsageLedger(opts);
}

/** Aggregate view over step rows (the P0 half of §3.2.4; the endpoint is P1). */
export interface LedgerTotals {
  currency: string;
  price_version: string | null;
  records: number;
  tokens: Usage;
  cost: LedgerCost | null;
  cost_complete: boolean;
  /** Rows that carried usage the table could not price (never silently 0). */
  unpriced_records: number;
  /** Rows whose provider reported no usage: the cost is UNKNOWN. */
  billed_unknown_records: number;
  unpriced_models: string[];
}

/** Sum the step rows of one session (or of the whole file when omitted). */
export function aggregateUsage(records: readonly UsageLedgerRecord[], session?: string): LedgerTotals {
  const totals: LedgerTotals = {
    currency: "CNY",
    price_version: null,
    records: 0,
    tokens: zeroUsage(),
    cost: null,
    cost_complete: true,
    unpriced_records: 0,
    billed_unknown_records: 0,
    unpriced_models: [],
  };
  const unpriced = new Set<string>();
  for (const record of records) {
    if (record.kind === "turn_total") continue;
    if (session !== undefined && record.session !== session) continue;
    totals.records += 1;
    if (record.price !== null) {
      totals.currency = record.price.currency;
      totals.price_version = record.price.version;
    }
    if (record.usage === null) {
      totals.billed_unknown_records += 1;
    } else {
      totals.tokens = usageAdd(totals.tokens, record.usage);
      if (record.priced_by === "unpriced") {
        totals.unpriced_records += 1;
        unpriced.add(record.model ?? "(unknown model)");
      }
    }
    if (record.cost !== null) totals.cost = totals.cost === null ? record.cost : costAdd(totals.cost, record.cost);
  }
  totals.unpriced_models = [...unpriced].sort();
  totals.cost_complete = totals.unpriced_records === 0 && totals.billed_unknown_records === 0;
  return totals;
}

/**
 * The process-level ledger file (one writer per process, every session books
 * into it — §3.6). `CELESTEA_USAGE_LEDGER=off|0|false|no` disables it entirely;
 * the price snapshot is read once here, so a new process picks up a new version
 * while every already-written row keeps the one it was priced with (C7).
 */
export function createUsageLedgerFile(opts: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): UsageLedgerFile | null {
  const env = opts.env ?? process.env;
  if (!ledgerEnabled(env)) return null;
  const override = env[ENV_USAGE_LEDGER_FILE];
  const path = override === undefined || override.trim() === "" ? join(opts.dataDir, USAGE_LEDGER_FILE) : override;
  const pricing = loadPricingFile(pricingPath(opts.dataDir, env));
  return new UsageLedgerFile({ path, pricing, ...(opts.now === undefined ? {} : { now: opts.now }) });
}

/** `off` (and the usual falsey spellings) turns the ledger off. */
export function ledgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ENV_USAGE_LEDGER] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

function warn(message: string): void {
  process.stderr.write(`usage ledger: ${message}\n`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
