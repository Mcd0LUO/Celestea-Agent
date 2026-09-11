/**
 * `checkpoint.json` — the per-session crash / shutdown sidecar (iteration E §1.2).
 *
 * WHY this file exists at all: `cli-main.jsonl` is the ONLY source of truth for
 * the conversation (K4), and everything derivable from it (turn counter,
 * history, last outcome) is deliberately NOT persisted twice. What the log can
 * NOT express is the difference between
 *
 *   - "a turn is open because this process is running it right now" and
 *   - "a turn is open because the process died mid-turn"
 *
 * so exactly those two facts are written here: the process identity
 * (`pid`/`boot_id`/`clean_shutdown`) and the open turn (`open_turn`).
 *
 * Failure discipline (fail-safe, §1.2.2 / R1-3):
 *   - missing file        -> "no checkpoint" (never repair, never invent);
 *   - unparsable / unknown `version` / `session` mismatch -> the WHOLE file is
 *     ignored and warned about, and the caller degrades to "no checkpoint" — a
 *     corrupt sidecar must never read as "the last exit was clean";
 *   - a failing write is reported and swallowed: checkpointing is observation,
 *     so it can never fail a turn (the session log's own degradation model).
 *
 * Write discipline: `<path>.tmp-<pid>` -> `rename` (atomic), mode `0600`,
 * pretty-printed JSON — the same rules as every other data file
 * (`contracts/data-files/index.json` durability map).
 */

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { outcomePhase, type TurnOutcome } from "@celestea/core";

/** File name inside a session directory (contract). */
export const CHECKPOINT_FILE_NAME = "checkpoint.json";
/** The only accepted `version`; anything else is "unknown schema" -> ignored. */
export const CHECKPOINT_VERSION = 1;

/** The turn a crashed process left open (null = no turn is running). */
export interface CheckpointOpenTurn {
  id: string;
  started_at: number;
}

/** One log repair this engine performed (the honest audit trail, R1-1). */
export interface CheckpointRepair {
  at: number;
  action: "synthesize_turn_end";
  turn_id: string;
}

/** P1 territory: lane persistence. Declared (empty) so the shape is frozen. */
export interface CheckpointLanes {
  next_turn: unknown[];
  next_step: unknown[];
}

export interface Checkpoint {
  version: number;
  /** Self-description `<workspace>/<session>`; a mismatch voids the file. */
  session: string;
  pid: number;
  /** One id per process start (a constant for the life of the process). */
  boot_id: string;
  updated_at: number;
  /** True only after a graceful shutdown; a clean exit is never repaired. */
  clean_shutdown: boolean;
  open_turn: CheckpointOpenTurn | null;
  /** Redundant with the log, kept for operators reading the sidecar directly. */
  last_outcome: string | null;
  degraded: { log_write_errors: number };
  lanes: CheckpointLanes;
  repaired: CheckpointRepair[];
}

/** Who is writing (`process.pid` + one random id per process start). */
export interface CheckpointIdentity {
  boot_id: string;
  pid: number;
}

/** `b-<8 hex>` — short, greppable, unique per process start. */
export function newBootId(): string {
  return `b-${randomBytes(4).toString("hex")}`;
}

const PROCESS_BOOT_ID = newBootId();

/** The identity of THIS process (stable for its whole life). */
export function currentProcessIdentity(): CheckpointIdentity {
  return { boot_id: PROCESS_BOOT_ID, pid: process.pid };
}

/** Read outcome of the sidecar: three states, never an exception. */
export type CheckpointRead =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "ok"; value: Checkpoint };

export function checkpointPathFor(dir: string): string {
  return join(dir, CHECKPOINT_FILE_NAME);
}

/** A fresh, empty checkpoint of the current process. */
export function freshCheckpoint(session: string, identity: CheckpointIdentity, now: number): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    session,
    pid: identity.pid,
    boot_id: identity.boot_id,
    updated_at: now,
    clean_shutdown: false,
    open_turn: null,
    last_outcome: null,
    degraded: { log_write_errors: 0 },
    lanes: { next_turn: [], next_step: [] },
    repaired: [],
  };
}

/** Atomic write: tmp file in the same directory -> rename, mode 0600. */
export function writeCheckpointFile(path: string, value: Checkpoint): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Read + validate; missing / corrupt / foreign files are never an exception. */
export function readCheckpointFile(path: string, session: string): CheckpointRead {
  if (!existsSync(path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { kind: "invalid", error: messageOf(e) };
  }
  if (text.trim() === "") return { kind: "invalid", error: "empty file" };
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    return { kind: "invalid", error: messageOf(e) };
  }
  return validateCheckpoint(raw, session);
}

/** Shape gate: version, self-description, open_turn and the repair list. */
export function validateCheckpoint(raw: unknown, session: string): CheckpointRead {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", error: "not a JSON object" };
  const value = raw as Partial<Checkpoint>;
  if (value.version !== CHECKPOINT_VERSION) return { kind: "invalid", error: `unknown version: ${String(value.version)}` };
  if (typeof value.session !== "string" || value.session !== session) {
    return { kind: "invalid", error: `session mismatch: ${String(value.session)} != ${session}` };
  }
  if (!(value.open_turn === null || value.open_turn === undefined || isOpenTurn(value.open_turn))) {
    return { kind: "invalid", error: "malformed open_turn" };
  }
  if (value.repaired !== undefined && !Array.isArray(value.repaired)) return { kind: "invalid", error: "malformed repaired[]" };
  return { kind: "ok", value: normalize(value, session) };
}

function isOpenTurn(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const turn = value as Partial<CheckpointOpenTurn>;
  return typeof turn.id === "string" && typeof turn.started_at === "number";
}

/** Fill every optional key so consumers never read `undefined`. */
function normalize(value: Partial<Checkpoint>, session: string): Checkpoint {
  const lanes = value.lanes ?? { next_turn: [], next_step: [] };
  return {
    version: CHECKPOINT_VERSION,
    session,
    pid: typeof value.pid === "number" ? value.pid : 0,
    boot_id: typeof value.boot_id === "string" ? value.boot_id : "",
    updated_at: typeof value.updated_at === "number" ? value.updated_at : 0,
    clean_shutdown: value.clean_shutdown === true,
    open_turn: value.open_turn ?? null,
    last_outcome: typeof value.last_outcome === "string" ? value.last_outcome : null,
    degraded: { log_write_errors: Math.max(0, Math.trunc(value.degraded?.log_write_errors ?? 0)) },
    lanes: { next_turn: lanes.next_turn ?? [], next_step: lanes.next_step ?? [] },
    repaired: (value.repaired ?? []).filter(isRepair),
  };
}

function isRepair(value: unknown): value is CheckpointRepair {
  if (value === null || typeof value !== "object") return false;
  const repair = value as Partial<CheckpointRepair>;
  return typeof repair.turn_id === "string" && typeof repair.at === "number";
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface CheckpointStoreOptions {
  /** Session directory the sidecar lives in. */
  dir: string;
  /** Self-description written into the file (`<workspace>/<session>`). */
  session: string;
  identity?: CheckpointIdentity;
  now?: () => number;
  /** Observation channel (stderr by default); never a failure. */
  warn?: (message: string) => void;
  /** Sample the log's own degradation counter at every write (§1.2.2). */
  logWriteErrors?: () => number;
}

/**
 * ONE session's checkpoint: in memory + on disk. Mutations are the write
 * timings of §1.2.2 (turn start, turn end, clean shutdown). Any activity marks
 * the process alive again (`clean_shutdown: false`); `markCleanShutdown` is the
 * only transition to `true`.
 */
export class CheckpointStore {
  readonly path: string;
  readonly session: string;

  private readonly identity: CheckpointIdentity;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly sample: () => number;
  private loaded: CheckpointRead | null = null;
  private state: Checkpoint | null = null;
  private readonly observations: string[] = [];

  constructor(opts: CheckpointStoreOptions) {
    this.session = opts.session;
    this.identity = opts.identity ?? currentProcessIdentity();
    this.now = opts.now ?? Date.now;
    this.warn = opts.warn ?? ((message) => process.stderr.write(`[celestea-session] ${message}\n`));
    this.sample = opts.logWriteErrors ?? ((): number => 0);
    this.path = checkpointPathFor(opts.dir);
  }

  /** The sidecar as found on disk (cached; never throws). */
  load(): CheckpointRead {
    if (this.loaded === null) {
      const read = readCheckpointFile(this.path, this.session);
      if (read.kind === "invalid") this.observe(`checkpoint ignored (${this.path}): ${read.error}`);
      this.loaded = read;
    }
    return this.loaded;
  }

  /** The current state (a fresh, empty checkpoint when missing / ignored). */
  get current(): Checkpoint {
    if (this.state !== null) return this.state;
    const read = this.load();
    if (read.kind !== "ok") {
      this.state = freshCheckpoint(this.session, this.identity, this.now());
      return this.state;
    }
    const value: Checkpoint = { ...read.value, degraded: { log_write_errors: Math.max(read.value.degraded.log_write_errors, this.sample()) } };
    this.state = value;
    return value;
  }

  /** Observations gathered so far (ignored files, failed writes). */
  warnings(): string[] {
    return [...this.observations];
  }

  /** A turn is open from now on (written RIGHT AFTER `turn_start`). */
  turnStarted(id: string): void {
    this.persist({ open_turn: { id, started_at: this.now() }, last_outcome: null });
  }

  /** The turn closed normally: no open turn, outcome recorded (§1.2.2). */
  turnEnded(outcome: TurnOutcome | undefined): void {
    this.persist({ open_turn: null, last_outcome: outcomePhase(outcome) });
  }

  /** Clear a stale open turn WITHOUT touching the log (already-closed case). */
  clearOpenTurn(): void {
    this.persist({ open_turn: null });
  }

  /**
   * The ONE crash repair: the log just got `turn_end: interrupted`, so the
   * record goes into `repaired[]` — the log row itself stays indistinguishable
   * from engine output (§1.2.3 幂等边界 4).
   */
  recordSynthesizedTurnEnd(turnId: string): void {
    const repaired = [...this.current.repaired, { at: this.now(), action: "synthesize_turn_end" as const, turn_id: turnId }];
    this.persist({ open_turn: null, last_outcome: "interrupted", repaired });
  }

  /** Graceful exit: `true` forbids any repair on the next boot. */
  markCleanShutdown(): void {
    this.persist({ open_turn: null, clean_shutdown: true });
  }

  /** Sample the log's degradation counter (sticky: a fork must stay visible). */
  noteLogWriteErrors(): void {
    if (this.sample() > 0) this.persist({});
  }

  private persist(patch: Partial<Checkpoint>): void {
    const base = this.current;
    const next: Checkpoint = {
      ...base,
      ...patch,
      version: CHECKPOINT_VERSION,
      session: this.session,
      pid: this.identity.pid,
      boot_id: this.identity.boot_id,
      updated_at: this.now(),
      // Any write means "this process is running this session": only an explicit
      // markCleanShutdown may claim a graceful exit.
      clean_shutdown: patch.clean_shutdown ?? false,
      degraded: { log_write_errors: Math.max(base.degraded.log_write_errors, this.sample()) },
    };
    this.state = next;
    this.loaded = { kind: "ok", value: next };
    try {
      writeCheckpointFile(this.path, next);
    } catch (e) {
      // Observation only: a sidecar that cannot be written must never fail a
      // turn — the next boot simply sees "no checkpoint" and stays fail-safe.
      this.observe(`checkpoint write failed (${this.path}): ${messageOf(e)}`);
    }
  }

  private observe(message: string): void {
    this.observations.push(message);
    this.warn(message);
  }
}
