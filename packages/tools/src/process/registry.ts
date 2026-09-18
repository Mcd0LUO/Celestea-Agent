/**
 * Session-scoped registry of background processes (`crates/tools/src/process.rs`).
 *
 * A `run_shell(background: true)` spawn registers its detached child here.
 * Entries survive across turns — that is the point: a server started in one
 * turn stays controllable from later turns. Each child gets a reaper that
 * drains stdout/stderr into capped ring buffers and records the exit exactly
 * once. W6: a finished process is retained as a BOUNDED tombstone (most recent
 * `MAX_TOMBSTONES`, at most `TOMBSTONE_TTL_MS`), so a `poll` AFTER exit still
 * returns `{running:false, exit_code, signal, stdout_tail, stderr_tail}` instead
 * of `unknown handle`; a CPU-cap kill is marked `cpu_exceeded`. For a **natural**
 * exit the completion sink may fire once (a host CAN push a `[process] … exited
 * …` message into a session mailbox, though this studio host does not wire one —
 * `process_control(action=poll)` is the durable read). `kill`/`killAll` paths
 * are deliberately silent: the caller already got `{killed: true}` back.
 */

import type { SandboxChild, SandboxExit } from "@celestea/core";

import { delay, TIMED_OUT, withTimeout } from "../sandbox/async.js";
import {
  completionTail,
  MAX_STREAM_BUFFER,
  RingBuffer,
  TAIL_BYTES,
} from "./buffers.js";

/** Well-known token for the process registry service in a Context. */
export const PROCESS_REGISTRY_SERVICE = "celestea.tools.ProcessRegistry";

/** Grace between SIGTERM and SIGKILL in `kill`. */
export const KILL_GRACE_MS = 1_000;
/** Upper bound for the SIGKILL reap wait. */
export const KILL_WAIT_MS = 2_000;
/** Upper bound for one stdin line write. */
export const STDIN_WRITE_TIMEOUT_MS = 5_000;
/** Exit-poll interval while waiting for a kill to land. */
const POLL_INTERVAL_MS = 20;
/** W6: how many terminal records stay pollable (most recent wins). */
export const MAX_TOMBSTONES = 32;
/** W6: how long a terminal record stays pollable. */
export const TOMBSTONE_TTL_MS = 10 * 60 * 1_000;

/** One natural-exit completion handed to the sink (W251 parity). */
export interface ProcessCompletion {
  handle: string;
  pid: number | null;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  elapsed_ms: number;
}

export type CompletionSink = (completion: ProcessCompletion) => void;

export interface ProcessRegistryOptions {
  killGraceMs?: number;
  killWaitMs?: number;
  maxStreamBuffer?: number;
  tailBytes?: number;
  /** W6: cap on retained terminal records (default [MAX_TOMBSTONES]). */
  maxTombstones?: number;
  /** W6: TTL of a terminal record (default [TOMBSTONE_TTL_MS]). */
  tombstoneTtlMs?: number;
  /** Clock (tests pin it). */
  now?: () => number;
}

/** W6: per-insert facts the terminal record needs (the effective CPU cap). */
export interface ProcessInsertOptions {
  /** Effective `RLIMIT_CPU` of this process; enables the `cpu_exceeded` marker. */
  cpuSec?: number | null;
}

export interface ProcessHandle {
  handle: string;
  pid: number | null;
}

interface Entry {
  handle: string;
  pid: number | null;
  child: SandboxChild;
  state: ProcState;
  notify: boolean;
  /** W6: effective CPU cap (null = no marker). */
  cpuSec: number | null;
}

class ProcState {
  exited = false;
  exitCode: number | null = null;
  /** W6: terminating signal (SIGXCPU/SIGKILL on a CPU cap, …). */
  signal: string | null = null;
  /** kill/shutdown path: record the exit, never fire the completion sink. */
  killPath = false;
  writeChain: Promise<unknown> = Promise.resolve();
  readonly stdout: RingBuffer;
  readonly stderr: RingBuffer;
  readonly spawnedAt = Date.now();

  constructor(maxStreamBuffer: number) {
    this.stdout = new RingBuffer(maxStreamBuffer);
    this.stderr = new RingBuffer(maxStreamBuffer);
  }
}

/** W6: a finished process, bounded in count and age, still answerable to poll. */
interface Tombstone {
  handle: string;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  cpuSec: number | null;
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnedAt: number;
  finishedAt: number;
  killPath: boolean;
}

export class ProcessRegistry {
  private readonly map = new Map<string, Entry>();
  /** W6: finished processes (bounded in count and age), still pollable. */
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly options: Required<Omit<ProcessRegistryOptions, "now">>;
  private readonly now: () => number;
  private nextHandle = 0;
  private completionSink: CompletionSink | null = null;

  constructor(options: ProcessRegistryOptions = {}) {
    this.options = {
      killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
      killWaitMs: options.killWaitMs ?? KILL_WAIT_MS,
      maxStreamBuffer: options.maxStreamBuffer ?? MAX_STREAM_BUFFER,
      tailBytes: options.tailBytes ?? TAIL_BYTES,
      maxTombstones: options.maxTombstones ?? MAX_TOMBSTONES,
      tombstoneTtlMs: options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS,
    };
    this.now = options.now ?? Date.now;
  }

  /** Install (or clear) the natural-exit sink: one per registry, last wins. */
  setCompletionSink(sink: CompletionSink | null): void {
    this.completionSink = sink;
  }

  /** Register a spawned child: takes over its pipes and starts the reaper. */
  insert(child: SandboxChild, notify = true, opts: ProcessInsertOptions = {}): ProcessHandle {
    const handle = `proc-${this.nextHandle}`;
    this.nextHandle += 1;
    const state = new ProcState(this.options.maxStreamBuffer);
    const entry: Entry = { handle, pid: child.pid, child, state, notify, cpuSec: opts.cpuSec ?? null };
    this.map.set(handle, entry);
    child.stdout?.on("data", (chunk: Buffer) => state.stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => state.stderr.append(chunk));
    void child.wait().then((exit) => this.finish(entry, exit));
    return { handle, pid: child.pid };
  }

  get size(): number {
    return this.map.size;
  }

  get isEmpty(): boolean {
    return this.map.size === 0;
  }

  /** `process_control(action=poll)`: running flag, capped tails, exit code. */
  poll(handle: string): Record<string, unknown> {
    const entry = this.map.get(handle);
    if (entry !== undefined) {
      const state = entry.state;
      return {
        ok: true,
        handle: entry.handle,
        pid: entry.pid,
        running: !state.exited,
        stdout_tail: state.stdout.tail(this.options.tailBytes),
        stderr_tail: state.stderr.tail(this.options.tailBytes),
        stdout_truncated: state.stdout.truncated,
        stderr_truncated: state.stderr.truncated,
        exit_code: state.exited ? state.exitCode : null,
      };
    }
    // W6: a finished process stays pollable from its bounded tombstone.
    const done = this.tombstone(handle);
    return done === undefined ? unknownHandle(handle) : this.tombstonePoll(done);
  }

  /** `process_control(action=kill)`: SIGTERM, grace, then SIGKILL. Silent. */
  async kill(handle: string): Promise<Record<string, unknown>> {
    const entry = this.map.get(handle);
    if (entry === undefined) {
      const done = this.tombstone(handle);
      return done === undefined ? unknownHandle(handle) : { ok: false, error: exitedMessage(done) };
    }
    entry.state.killPath = true;
    entry.child.terminate();
    if (!(await this.waitExited(entry, this.options.killGraceMs))) {
      entry.child.kill();
      await this.waitExited(entry, this.options.killWaitMs);
    }
    return { ok: true, killed: true, handle: entry.handle };
  }

  /** `process_control(action=stdin)`: write one line (content + newline). */
  async stdinLine(handle: string, line: string): Promise<Record<string, unknown>> {
    const entry = this.map.get(handle);
    if (entry === undefined) {
      const done = this.tombstone(handle);
      return done === undefined ? unknownHandle(handle) : { ok: false, error: `process ${handle} already exited` };
    }
    if (entry.state.exited) return { ok: false, error: `process ${handle} already exited` };
    if (entry.child.stdin === null) return { ok: false, error: `process ${handle} stdin unavailable` };
    const payload = `${line}\n`;
    // Serialize writes per process: two concurrent stdin actions must not
    // interleave and corrupt a line-oriented child.
    const chained = entry.state.writeChain.then(() => this.write(entry, payload));
    entry.state.writeChain = chained.catch(() => undefined);
    const settled = await withTimeout(
      chained.then(
        () => ({ ok: true }) as const,
        (e: unknown) => ({ ok: false, error: `stdin write failed: ${e instanceof Error ? e.message : String(e)}` }),
      ),
      STDIN_WRITE_TIMEOUT_MS,
    );
    if (settled === TIMED_OUT) return { ok: false, error: "stdin write timed out (5s)" };
    if (!settled.ok) return { ok: false, error: settled.error };
    return { ok: true, handle: entry.handle, written: Buffer.byteLength(payload) };
  }

  private write(entry: Entry, payload: string): Promise<void> {
    const stdin = entry.child.stdin;
    if (stdin === null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => (error === null || error === undefined ? resolve() : reject(error)));
    });
  }

  /** Kill every still-registered child (shutdown path); idempotent. */
  killAll(): void {
    for (const entry of [...this.map.values()]) {
      entry.state.killPath = true;
      entry.child.kill();
    }
    this.map.clear();
    this.tombstones.clear();
  }

  /** Alias of [killAll] for `Runtime.shutdown` call sites. */
  dispose(): void {
    this.killAll();
  }

  private async waitExited(entry: Entry, windowMs: number): Promise<boolean> {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (entry.state.exited) return true;
      await delay(POLL_INTERVAL_MS);
    }
    return entry.state.exited;
  }

  /** Reaper tail: record the exit once, tombstone it, then maybe notify. */
  private finish(entry: Entry, exit: SandboxExit): void {
    const state = entry.state;
    if (state.exited) return;
    state.exited = true;
    state.exitCode = exit.code;
    state.signal = exit.signal ?? null;
    this.map.delete(entry.handle);
    // W6: keep a bounded terminal record so poll-after-exit still answers.
    this.tombstones.set(entry.handle, {
      handle: entry.handle,
      pid: entry.pid,
      exitCode: state.exitCode,
      signal: state.signal,
      cpuSec: entry.cpuSec,
      stdoutTail: state.stdout.tail(this.options.tailBytes),
      stderrTail: state.stderr.tail(this.options.tailBytes),
      stdoutTruncated: state.stdout.truncated,
      stderrTruncated: state.stderr.truncated,
      spawnedAt: state.spawnedAt,
      finishedAt: this.now(),
      killPath: state.killPath,
    });
    this.evictTombstones();
    if (!entry.notify || state.killPath) return;
    this.completionSink?.({
      handle: entry.handle,
      pid: entry.pid,
      exit_code: exit.code,
      stdout_tail: completionTail(state.stdout),
      stderr_tail: completionTail(state.stderr),
      elapsed_ms: this.now() - state.spawnedAt,
    });
  }

  /** A live tombstone, or undefined (evicting it once its TTL has passed). */
  private tombstone(handle: string): Tombstone | undefined {
    const done = this.tombstones.get(handle);
    if (done === undefined) return undefined;
    if (this.now() - done.finishedAt > this.options.tombstoneTtlMs) {
      this.tombstones.delete(handle);
      return undefined;
    }
    return done;
  }

  /** W6: the terminal answer `poll` gives after a process has exited. */
  private tombstonePoll(done: Tombstone): Record<string, unknown> {
    const cpuExceeded = this.cpuExceeded(done);
    return {
      ok: true,
      handle: done.handle,
      pid: done.pid,
      running: false,
      stdout_tail: done.stdoutTail,
      stderr_tail: done.stderrTail,
      stdout_truncated: done.stdoutTruncated,
      stderr_truncated: done.stderrTruncated,
      exit_code: done.exitCode,
      signal: done.signal,
      ...(cpuExceeded ? { cpu_exceeded: true, message: `CPU time limit ${done.cpuSec}s exceeded` } : {}),
    };
  }

  /** W6: RLIMIT_CPU termination (SIGXCPU, or the SIGKILL that follows it). */
  private cpuExceeded(done: Tombstone): boolean {
    if (done.killPath || done.cpuSec === null) return false;
    return done.signal === "SIGXCPU" || done.signal === "SIGKILL";
  }

  /** Evict terminal records past the TTL, then oldest-first past the count cap. */
  private evictTombstones(): void {
    const now = this.now();
    for (const [handle, done] of [...this.tombstones]) {
      if (now - done.finishedAt > this.options.tombstoneTtlMs) this.tombstones.delete(handle);
    }
    while (this.tombstones.size > this.options.maxTombstones) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [handle, done] of this.tombstones) {
        if (done.finishedAt < oldestAt) {
          oldestAt = done.finishedAt;
          oldest = handle;
        }
      }
      if (oldest === null) break;
      this.tombstones.delete(oldest);
    }
  }
}

function unknownHandle(handle: string): Record<string, unknown> {
  return { ok: false, error: `unknown handle: ${handle}` };
}

/** W6: a clear terminal error for a handle whose process has already exited. */
function exitedMessage(done: Tombstone): string {
  const tail =
    done.exitCode === null
      ? done.signal === null
        ? "no exit status"
        : `signal=${done.signal}`
      : `exit_code=${done.exitCode}`;
  return `process ${done.handle} already exited (${tail})`;
}
