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
 * Invariants kept from the legacy engine:
 * - the effective isolation mode travels *inside* every result (`SandboxMeta`):
 *   a caller never infers the isolation level, and silent degradation stays
 *   visible;
 * - **the provider declares its own completeness** (W1483): the fact booleans
 *   say what is in force, `SandboxMeta.enforcement` says whether that covers
 *   *every* effect the mode promises, and `promise_gaps` names what is missing.
 *   A consumer needing an absolute boundary refuses a `partial` run instead of
 *   re-deriving the answer from the booleans;
 * - every failure is a structured `SandboxError` — `run_shell-sandbox: code=<k>
 *   msg="<quoted>"` — never a bare string, never a thrown non-Error;
 * - a kill deadline is enforced for foreground runs; background runs carry no
 *   call-level deadline (they outlive the turn) and are reaped by the caller.
 */

import type { Readable, Writable } from "node:stream";

/**
 * Enforcement completeness of one run's isolation.
 *
 * `full` = the provider delivered EVERY effect its mode promises; `partial` =
 * it delivered a subset and names the difference in `promise_gaps`. This is the
 * layer the fact booleans cannot express: `net_isolated` / `tmp_private` /
 * `seccomp` report what the provider *believes* is in force, `enforcement`
 * reports whether that belief was *verified against the promises*. Parity: DSH's
 * `SandboxEnforcement`. A consumer that needs an absolute boundary must refuse
 * a `partial` run or surface the difference — never treat it as `full`.
 */
export type SandboxEnforcement = "full" | "partial";

/**
 * Machine-readable reasons `enforcement` is `partial` (stable tokens).
 *
 * One token per promised effect, so a consumer branches on the vocabulary
 * instead of on prose. `no_os_isolation` is the coarse honest answer of a
 * provider that promises none of the OS-level effects (the userspace fallback);
 * a provider that promises them but did not deliver one names that one.
 */
export type SandboxPromiseGap =
  | "no_os_isolation"
  | "mount_namespace"
  | "pid_namespace"
  | "ipc_namespace"
  | "uts_namespace"
  | "user_namespace"
  | "cgroup_namespace"
  | "network_namespace"
  | "readonly_root"
  | "private_tmp"
  | "seccomp"
  | "rlimits";

/** The `enforcement` + `promise_gaps` half of a `SandboxMeta`. */
export interface SandboxEnforcementReport {
  enforcement: SandboxEnforcement;
  /** Absent iff `enforcement === "full"` (a full run has nothing to report). */
  promise_gaps?: readonly SandboxPromiseGap[];
}

/**
 * Build the report from the gaps a provider actually found.
 *
 * One call site per provider keeps `enforcement` and `promise_gaps` from ever
 * disagreeing: an empty list IS `full`, a non-empty one IS `partial`, and the
 * list is de-duplicated in first-seen order.
 */
export function enforcementReport(gaps: readonly SandboxPromiseGap[] = []): SandboxEnforcementReport {
  const unique = [...new Set(gaps)];
  return unique.length === 0 ? { enforcement: "full" } : { enforcement: "partial", promise_gaps: unique };
}

/** Effective isolation mode of one run ("bwrap" | "raw" | "userspace" | …). */
export interface SandboxMeta {
  /** Provider that actually executed the command. */
  provider: string;
  /** W6: effective `RLIMIT_CPU` in seconds for this run (absent = not reported). */
  cpu_sec?: number;
  /** true when the child ran in an isolated network namespace. */
  net_isolated: boolean;
  /** true when /tmp was a sandbox-private tmpfs. */
  tmp_private: boolean;
  /** true when a seccomp syscall whitelist was applied. */
  seccomp: boolean;
  /**
   * W1483: whether the facts above cover every effect this provider's mode
   * promises. Declared by the provider itself (see [SandboxEnforcement]).
   */
  enforcement: SandboxEnforcement;
  /** What is missing; absent iff `enforcement === "full"`. */
  promise_gaps?: readonly SandboxPromiseGap[];
}

/**
 * The userspace (no OS isolation) mode: everything reported, nothing hidden.
 *
 * W1483: it promises no OS-level effect, so it is `partial` by construction and
 * says so with the coarse `no_os_isolation` token — the per-effect detail is
 * constant for this provider and would only flood every result.
 */
export const USERSPACE_SANDBOX_META: SandboxMeta = {
  provider: "userspace",
  net_isolated: false,
  tmp_private: false,
  seccomp: false,
  enforcement: "partial",
  promise_gaps: ["no_os_isolation"],
};

/** Tuning knobs every sandbox implementation honours (`SandboxConfig`). */
export interface SandboxConfig {
  /** Kill deadline when the call passes no `timeoutMs`. */
  timeoutMs: number;
  /** Upper bound accepted for a per-call `timeoutMs`. */
  maxTimeoutMs: number;
  /** W6: upper bound accepted for a per-call `cpuSec` (env `CELESTEA_SHELL_MAX_CPU_SEC`). */
  maxCpuSec: number;
  /** Per-stream (stdout / stderr) capture cap in bytes. */
  maxOutputBytes: number;
  /** Fixed workdir: the default cwd of every command. */
  workdir: string;
  /** Canonical prefix every resolved workdir must stay inside. */
  root: string;
  /**
   * W880: absolute directory the `run_code` broker writes its transient program
   * files into. It lives OUTSIDE the workspace now (under `CELESTEA_HOME`), so
   * the bwrap provider must bind it into the namespace or the child cannot read
   * the program it was told to run.
   */
  programDir: string;
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

/**
 * F4: per-call address-space exemption.
 *
 * Modern Chromium reserves an enormous VIRTUAL address space; under a 2GiB
 * `RLIMIT_AS` it dies with SIGTRAP before it can log anything (measured:
 * 2/3/4/8/16/32GiB all die, 64GiB lives). Setting this on ONE call omits
 * `RLIMIT_AS` and NOTHING ELSE — CPU/NPROC/FSIZE/NOFILE/CORE still apply.
 *
 * Absent/undefined = the historical behaviour (address space limited).
 * Deliberately NOT surfaced in `SandboxMeta`: the model-visible contract stays
 * the four fields it was just reduced to; the tool layer states the exemption
 * in its own result.
 */
export interface SandboxAddressSpaceOptions {
  noAddressSpaceLimit?: boolean;
}

export interface SandboxRunRequest extends SandboxAddressSpaceOptions {
  command: string;
  /** Optional per-call cwd; must exist inside `config.root`. */
  workdir?: string;
  /** Optional per-call kill deadline, bounded by `config.maxTimeoutMs`. */
  timeoutMs?: number;
  /** W6: optional per-call `RLIMIT_CPU` in seconds, clamped to `config.maxCpuSec`. */
  cpuSec?: number;
}

export interface SandboxSpawnRequest extends SandboxAddressSpaceOptions {
  command: string;
  workdir?: string;
  /** W6: optional per-call `RLIMIT_CPU` in seconds, clamped to `config.maxCpuSec`. */
  cpuSec?: number;
}

/** Result of a foreground run: capped streams + exit code + effective mode. */
export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  /** W6: terminating signal when the child was killed (SIGXCPU/SIGKILL on a CPU cap). */
  signal?: string | null;
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
 * W885: the inputs a `run_code` broker needs to quote its interpreter line for
 * the shell that will actually carry it. Structural on purpose — `core` is the
 * dependency-free leaf and cannot import the tools implementation — and
 * OPTIONAL: an absent field means the host default (the `celestea-home.ts`
 * defaulting rule).
 */
export interface SandboxShellLookup {
  /** `process.platform` equivalent. */
  platform?: NodeJS.Platform | string;
  /** `process.env` equivalent. */
  env?: Record<string, string | undefined>;
  /** PATH lookup seam (bare executable name -> absolute path or null). */
  which?: (bin: string) => string | null;
  /** Existence check for absolute candidate paths. */
  exists?: (path: string) => boolean;
}

/**
 * The execution boundary. `run` is the foreground path (deadline enforced,
 * stdio captured); `spawn` is the background path (no deadline, stdin piped so
 * `process_control` can write lines).
 */
export interface Sandbox {
  readonly config: SandboxConfig;
  /**
   * W885: the platform/shell view this provider runs commands under. Absent =
   * host defaults; tests inject a win32 view to exercise the Windows branch.
   */
  readonly shell?: SandboxShellLookup;
  run(req: SandboxRunRequest): Promise<SandboxRunResult>;
  spawn(req: SandboxSpawnRequest): Promise<SandboxSpawned>;
}

/** Stable error kinds (mirrors the engine's `SandboxError::code`). */
export type SandboxErrorKind = "timeout" | "workdir" | "arg" | "config" | "spawn";

/** Stable prefix of every structured sandbox error (contract, not decoration). */
export const SANDBOX_ERROR_PREFIX = "run_shell-sandbox";

/** `<prefix>: code=<code> msg="<quoted>"` — the one shape every denial uses. */
export function contractDenial(prefix: string, code: string, message: string): string {
  return `${prefix}: code=${code} msg="${quoteSandboxMessage(message)}"`;
}

/**
 * The absolute-promise gate for upper layers (W1483).
 *
 * A path that may only run under a FULL boundary calls this and refuses on the
 * returned error — it never re-derives the answer from `net_isolated` /
 * `tmp_private` / `seccomp`. `null` means the run covers every promise.
 *
 * This reuses the existing fail-closed mechanism (`SandboxError` with
 * `kind: "config"`, exactly what `CELESTEA_SANDBOX_FALLBACK=fail` raises) rather
 * than inventing a parallel one: the message keeps the `sandbox_unavailable:`
 * vocabulary the policy layer already speaks, and adds the reason.
 */
export function requireFullEnforcement(meta: SandboxMeta): SandboxError | null {
  if (meta.enforcement === "full") return null;
  const gaps = (meta.promise_gaps ?? []).join(", ") || "unspecified";
  return new SandboxError(
    "config",
    `sandbox_unavailable: the ${meta.provider} provider reports partial enforcement (missing: ${gaps}) and this path requires every promised effect; use a host with a complete provider or set CELESTEA_SANDBOX_FALLBACK=userspace to accept the degraded boundary explicitly`,
    { provider: meta.provider, enforcement: meta.enforcement, promise_gaps: [...(meta.promise_gaps ?? [])] },
  );
}

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
    super(contractDenial(SANDBOX_ERROR_PREFIX, kind, message));
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
