/**
 * Sandbox seam — the injected execution boundary behind `run_shell`.
 *
 * Parity target: `crates/tools/src/sandbox.rs` (`SandboxConfig`, `SandboxMeta`,
 * `SandboxOutput`, `SandboxError`, `execute_sandboxed`, `spawn_sandboxed`) plus
 * the `OsSandboxLayer` hook that lets an OS-level layer (bubblewrap / raw
 * namespaces / seccomp) wrap the direct command without touching call sites.
 *
 * Why a seam in `core`: `run_shell` must be pure orchestration (argument
 * handling, timeout/cap bookkeeping, background hand-off) and must never know
 * *how* isolation is achieved. Implementations are plugins: P2b ships the
 * userspace implementation in `@celestea/tools`; the real OS isolation lands in
 * P2c behind this exact interface (ARCHITECTURE.md §3.1, §7.4).
 *
 * Invariants kept from Rust:
 * - the effective isolation mode travels *inside* every result (`SandboxMeta`):
 *   a caller never infers the isolation level, and silent degradation stays
 *   visible;
 * - every failure is a structured `SandboxError` — `run_shell-sandbox: code=<k>
 *   msg="<quoted>"` — never a bare string, never a thrown non-Error;
 * - a kill deadline is enforced for foreground runs; background runs carry no
 *   call-level deadline (they outlive the turn) and are reaped by the caller.
 */

import type { Readable, Writable } from "node:stream";

/** Effective isolation mode of one run ("bwrap" | "raw" | "userspace" | …). */
export interface SandboxMeta {
  /** Provider that actually executed the command. */
  provider: string;
  /** true when the child ran in an isolated network namespace. */
  net_isolated: boolean;
  /** true when /tmp was a sandbox-private tmpfs. */
  tmp_private: boolean;
  /** true when a seccomp syscall whitelist was applied. */
  seccomp: boolean;
}

/** The userspace (no OS isolation) mode: everything reported, nothing hidden. */
export const USERSPACE_SANDBOX_META: SandboxMeta = {
  provider: "userspace",
  net_isolated: false,
  tmp_private: false,
  seccomp: false,
};

/** Tuning knobs every sandbox implementation honours (`SandboxConfig`). */
export interface SandboxConfig {
  /** Kill deadline when the call passes no `timeoutMs`. */
  timeoutMs: number;
  /** Upper bound accepted for a per-call `timeoutMs`. */
  maxTimeoutMs: number;
  /** Per-stream (stdout / stderr) capture cap in bytes. */
  maxOutputBytes: number;
  /** Fixed workdir: the default cwd of every command. */
  workdir: string;
  /** Canonical prefix every resolved workdir must stay inside. */
  root: string;
  /** Deliberate operator env injected on top of the allowlist. */
  extraEnv: ReadonlyArray<readonly [string, string]>;
}

/** Terminal state of a child process. */
export interface SandboxExit {
  code: number | null;
  signal: string | null;
}

/**
 * A spawned child, uniform across providers. `stdout`/`stderr` are the drains
 * the caller (process registry) owns; `wait()` resolves once the child has
 * exited *and* its pipes are closed, so buffered output is never lost.
 */
export interface SandboxChild {
  readonly pid: number | null;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  wait(): Promise<SandboxExit>;
  /** SIGTERM the process tree (best effort). */
  terminate(): void;
  /** SIGKILL the process tree (best effort). */
  kill(): void;
}

export interface SandboxRunRequest {
  command: string;
  /** Optional per-call cwd; must exist inside `config.root`. */
  workdir?: string;
  /** Optional per-call kill deadline, bounded by `config.maxTimeoutMs`. */
  timeoutMs?: number;
}

export interface SandboxSpawnRequest {
  command: string;
  workdir?: string;
}

/** Result of a foreground run: capped streams + exit code + effective mode. */
export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  sandbox: SandboxMeta;
}

/** A detached background child plus the mode it was spawned under. */
export interface SandboxSpawned {
  child: SandboxChild;
  sandbox: SandboxMeta;
}

/**
 * The execution boundary. `run` is the foreground path (deadline enforced,
 * stdio captured); `spawn` is the background path (no deadline, stdin piped so
 * `process_control` can write lines).
 */
export interface Sandbox {
  readonly config: SandboxConfig;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  spawn(req: SandboxSpawnRequest): Promise<SandboxSpawned>;
}

/** Stable error kinds (mirrors Rust `SandboxError::code`). */
export type SandboxErrorKind = "timeout" | "workdir" | "arg" | "config" | "spawn";

/** Stable prefix of every structured sandbox error (contract, not decoration). */
export const SANDBOX_ERROR_PREFIX = "run_shell-sandbox";

/** Escape + truncate a message so the one-line error contract stays parseable. */
export function quoteSandboxMessage(message: string): string {
  let out = "";
  let count = 0;
  for (const ch of message) {
    if (count >= 512) break;
    count += 1;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20) out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}

/**
 * Structured sandbox failure. `message` is the contract string
 * `run_shell-sandbox: code=<kind> msg="<quoted>"`; `detail` carries the
 * machine-readable extras (pid, captured byte counts, requested workdir, …).
 */
export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(kind: SandboxErrorKind, message: string, detail: Record<string, unknown> = {}) {
    super(`${SANDBOX_ERROR_PREFIX}: code=${kind} msg="${quoteSandboxMessage(message)}"`);
    this.name = "SandboxError";
    this.kind = kind;
    this.detail = detail;
  }
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}

/** Well-known token for the sandbox service in a Context. */
export const SANDBOX_SERVICE = "celestea.core.Sandbox";
