/**
 * Session-scoped registry of background processes (`crates/tools/src/process.rs`).
 *
 * A `run_shell(background: true)` spawn registers its detached child here.
 * Entries survive across turns — that is the point: a server started in one
 * turn stays controllable from later turns. Each child gets a reaper that
 * drains stdout/stderr into capped ring buffers, records the exit exactly once,
 * removes the handle as soon as the process exits, and then — for a **natural**
 * exit only — fires the completion sink once, so a runtime can push a
 * `[process] … exited …` message into the session mailbox instead of polling.
 * `kill`/`killAll` paths are deliberately silent: the caller already got
 * `{killed: true}` back.
 */

import type { SandboxChild } from "@celestea/core";

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
}

class ProcState {
  exited = false;
  exitCode: number | null = null;
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

export class ProcessRegistry {
  private readonly map = new Map<string, Entry>();
  private readonly options: Required<ProcessRegistryOptions>;
  private nextHandle = 0;
  private completionSink: CompletionSink | null = null;

  constructor(options: ProcessRegistryOptions = {}) {
    this.options = {
      killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
      killWaitMs: options.killWaitMs ?? KILL_WAIT_MS,
      maxStreamBuffer: options.maxStreamBuffer ?? MAX_STREAM_BUFFER,
      tailBytes: options.tailBytes ?? TAIL_BYTES,
    };
  }

  /** Install (or clear) the natural-exit sink: one per registry, last wins. */
  setCompletionSink(sink: CompletionSink | null): void {
    this.completionSink = sink;
  }

  /** Register a spawned child: takes over its pipes and starts the reaper. */
  insert(child: SandboxChild, notify = true): ProcessHandle {
    const handle = `proc-${this.nextHandle}`;
    this.nextHandle += 1;
    const state = new ProcState(this.options.maxStreamBuffer);
    const entry: Entry = { handle, pid: child.pid, child, state, notify };
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
    if (entry === undefined) return unknownHandle(handle);
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

  /** `process_control(action=kill)`: SIGTERM, grace, then SIGKILL. Silent. */
  async kill(handle: string): Promise<Record<string, unknown>> {
    const entry = this.map.get(handle);
    if (entry === undefined) return unknownHandle(handle);
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
    if (entry === undefined) return unknownHandle(handle);
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

  /** Reaper tail: record the exit once, unregister, then maybe notify. */
  private finish(entry: Entry, exit: { code: number | null }): void {
    const state = entry.state;
    if (state.exited) return;
    state.exited = true;
    state.exitCode = exit.code;
    this.map.delete(entry.handle);
    if (!entry.notify || state.killPath) return;
    this.completionSink?.({
      handle: entry.handle,
      pid: entry.pid,
      exit_code: exit.code,
      stdout_tail: completionTail(state.stdout),
      stderr_tail: completionTail(state.stderr),
      elapsed_ms: Date.now() - state.spawnedAt,
    });
  }
}

function unknownHandle(handle: string): Record<string, unknown> {
  return { ok: false, error: `unknown handle: ${handle}` };
}
