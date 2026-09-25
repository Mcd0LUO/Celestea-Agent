/**
 * Resource limits for the OS-isolated provider — and the `RLIMIT_NPROC` trap.
 *
 * `RLIMIT_NPROC` is **not** a per-sandbox process count: the kernel counts every
 * thread owned by the *real UID across the whole host*. W274 §3.2 measured this
 * the hard way: with 347 threads owned by uid 1003 on this machine, `--nproc`
 * below that number makes bwrap fail to even `clone()` its pid-1
 * (`Resource temporarily unavailable`), while the legacy default of 512 left only
 * ~165 threads of slack before production commands start failing.
 *
 * So the cap is **derived at probe time**: `threads(uid) + headroom`, with a
 * floor that also covers hosts where counting is impossible (non-Linux, no
 * `/proc`). It stays a fork-bomb brake, it just stops being a time bomb.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { envFlag, envInt } from "../env.js";

/** Env var: explicit `RLIMIT_NPROC` override (skips derivation). */
export const ENV_SANDBOX_NPROC = "CELESTEA_SANDBOX_NPROC";
/** Env var: slack added to the measured UID thread count (default 512). */
export const ENV_SANDBOX_NPROC_HEADROOM = "CELESTEA_SANDBOX_NPROC_HEADROOM";
/** Env var: `0` disables every rlimit (operator escape hatch). */
export const ENV_SANDBOX_RLIMITS = "CELESTEA_SANDBOX_RLIMITS";

/** Default slack above the measured thread count. */
export const NPROC_HEADROOM = 512;
/** Floor used when the thread count cannot be measured (and a sane minimum). */
export const NPROC_FLOOR = 1024;

/** The six limits the OS layer enforces (mirrors the legacy `V2Limits::default()`). */
export interface SandboxLimits {
  cpuSec: number;
  memMb: number;
  nproc: number;
  fsizeBytes: number;
  nofile: number;
  core: boolean;
}

/** Legacy defaults, except `nproc` which is always derived (see module docs). */
export const DEFAULT_LIMITS: Omit<SandboxLimits, "nproc"> = {
  cpuSec: 20,
  memMb: 2048,
  fsizeBytes: 256 * 1024 * 1024,
  nofile: 256,
  core: true,
};

/**
 * Count every thread owned by `uid` on this host by summing
 * `/proc/<pid>/task/*` for the pids that uid owns. Returns `null` when the
 * answer cannot be established (non-Linux, no `/proc`, nothing readable).
 */
export function countUidThreads(uid: number | null = currentUid(), procRoot = "/proc"): number | null {
  if (uid === null || process.platform !== "linux") return null;
  const entries = readDir(procRoot);
  let total = 0;
  for (const entry of entries) {
    if (isPid(entry)) total += threadsOf(join(procRoot, entry), uid);
  }
  return total > 0 ? total : null;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function readDir(target: string): string[] {
  try {
    return readdirSync(target);
  } catch {
    return [];
  }
}

function isPid(entry: string): boolean {
  const value = Number(entry);
  return Number.isInteger(value) && value > 0 && entry === String(value);
}

function threadsOf(pidDir: string, uid: number): number {
  try {
    if (statSync(pidDir).uid !== uid) return 0;
    return readdirSync(join(pidDir, "task")).length;
  } catch {
    return 0; // the process vanished mid-scan (or is not ours to inspect)
  }
}

/** `threads + headroom`, never below `floor` (see the module docs). */
export function deriveNproc(threads: number | null, headroom = NPROC_HEADROOM, floor = NPROC_FLOOR): number {
  return Math.max(floor, (threads ?? 0) + headroom);
}

/**
 * W1465: refresh ONLY the derived nproc from a **fresh** thread count.
 *
 * Why this exists (real outage): RLIMIT_NPROC counts every thread owned by the
 * real UID **host-wide**, so a value derived once at construction becomes a time
 * bomb -- the UID thread count keeps growing (other sessions, vitest workers,
 * MC servers) and the moment it passes the frozen cap, prlimit --nproc=<frozen>
 * makes bwrap fail to create its namespace at all:
 *
 *   bwrap: Creating new namespace failed: Resource temporarily unavailable
 *
 * The program then never starts, so every tool call inside it silently never
 * happens. Measured on this host: 1038 threads + NPROC_FLOOR 1024 => EAGAIN;
 * 1100 => exit 0.
 *
 * An explicit CELESTEA_SANDBOX_NPROC is an operator decision and is left alone;
 * otherwise the cap is re-derived per call so it always leads the real count.
 */
export function refreshNproc(limits: SandboxLimits, env: NodeJS.ProcessEnv = process.env, threads = countUidThreads()): SandboxLimits {
  const explicit = envInt(env, ENV_SANDBOX_NPROC);
  if (explicit !== undefined && explicit > 0) return limits;
  const headroom = envInt(env, ENV_SANDBOX_NPROC_HEADROOM) ?? NPROC_HEADROOM;
  const nproc = deriveNproc(threads, headroom);
  return nproc === limits.nproc ? limits : { ...limits, nproc };
}

/** Limits for one provider instance: measured `nproc` plus env overrides. */
export function limitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  threads: number | null = countUidThreads(),
): SandboxLimits {
  const explicit = envInt(env, ENV_SANDBOX_NPROC);
  const headroom = envInt(env, ENV_SANDBOX_NPROC_HEADROOM);
  return {
    ...DEFAULT_LIMITS,
    nproc: explicit !== undefined && explicit > 0 ? explicit : deriveNproc(threads, headroom ?? NPROC_HEADROOM),
  };
}

/** rlimits are on unless the operator explicitly turns them off. */
export function rlimitsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[ENV_SANDBOX_RLIMITS], true);
}

/** W6: the resolved per-call CPU limit plus whether it was clamped. */
export interface CpuResolution {
  cpuSec: number;
  clamped: boolean;
  /** The raw request (null = the caller passed nothing). */
  requested: number | null;
}

/**
 * Resolve the effective `RLIMIT_CPU` for ONE call.
 * - absent `requested` keeps `base` (the default, `DEFAULT_LIMITS.cpuSec` = 20);
 * - above `max` is CLAMPED to `max` (`clamped: true`, documented, not an error);
 * - a non-integer/below-1 value keeps `base` (the arg schema rejects it first).
 */
export function resolveCpuSec(base: number, requested: number | undefined, max: number): CpuResolution {
  if (requested === undefined) return { cpuSec: base, clamped: false, requested: null };
  const raw = Math.trunc(requested);
  if (!Number.isFinite(raw) || raw < 1) return { cpuSec: base, clamped: false, requested };
  if (raw > max) return { cpuSec: max, clamped: true, requested: raw };
  return { cpuSec: raw, clamped: false, requested: raw };
}

/** The base limits with the resolved CPU limit merged in (identity when equal). */
export function limitsForCpu(base: SandboxLimits, resolution: CpuResolution): SandboxLimits {
  return resolution.cpuSec === base.cpuSec ? base : { ...base, cpuSec: resolution.cpuSec };
}

// ---- CPU follows the wall clock (docs/feature-sandbox-time-semantics.md §3.1) ----

/**
 * Headroom added on top of the wall clock before it becomes `RLIMIT_CPU`.
 *
 * The point of the grace is to make "the wall clock fires first" the NORMAL
 * outcome: when the deadline wins, the caller gets the honest `code=timeout`
 * (with captured output previews), instead of an ambiguous CPU death that only
 * says "killed" and hides which of the two independent timelines expired. 5s
 * covers the SIGKILL + reap path (`REAP_GRACE_MS` = 5s in `launch.ts`) inside the
 * wall-clock window.
 */
export const CPU_GRACE_SEC = 5;

/**
 * §3.1: `cpuSec = clamp(ceil(wallClockMs / 1000) + CPU_GRACE_SEC, 1, maxCpuSec)`.
 *
 * `maxCpuSec` is the deployer ceiling (`CELESTEA_SHELL_MAX_CPU_SEC`), so a
 * derived value can never exceed it. The ceiling is treated as at least 1 so a
 * misconfigured `0` still yields a usable limit instead of `--cpu=0`.
 */
export function deriveCpuSecFromWallClock(wallClockMs: number, maxCpuSec: number, graceSec = CPU_GRACE_SEC): number {
  const ceiling = Math.max(Math.trunc(maxCpuSec), 1);
  const seconds = Math.ceil(wallClockMs / 1000) + graceSec;
  return Math.max(Math.min(seconds, ceiling), 1);
}

/**
 * Where a call's effective `RLIMIT_CPU` came from. There are exactly THREE
 * sources and they are deliberately asymmetric:
 *
 * | source       | when                             | value                    |
 * |--------------|----------------------------------|--------------------------|
 * | `explicit`   | the caller passed `cpu_sec`      | that value, clamped      |
 * | `wall-clock` | foreground, no `cpu_sec`         | `ceil(timeout/1000) + 5` |
 * | `background` | `background: true`, no `cpu_sec` | `maxCpuSec` (the ceiling)|
 *
 * The last row is INTENTIONALLY asymmetric. A background process has no
 * call-level wall clock at all — `launch.ts`'s `resolveTimeout` only bounds a
 * foreground `run` — so there is nothing for it to follow. The two honest
 * answers are "keep the old fixed 20s" or "use the deployer's ceiling"; the
 * deployer asked for long-lived helpers to be allowed the budget they
 * configured, so the default is the ceiling. The hard boundary is still
 * `maxCpuSec`, which only an operator can move.
 *
 * `DEFAULT_LIMITS.cpuSec` (20) therefore survives ONLY as the fallback for
 * callers that resolve limits outside any call (see [limitsFromEnv]); neither
 * the foreground nor the background per-call path reads it as a default.
 */
export type CpuSource = "explicit" | "wall-clock" | "background";

/** A [`CpuResolution`] plus which of the three sources produced it. */
export interface CallCpuResolution extends CpuResolution {
  source: CpuSource;
}

export interface CallCpuInput {
  /** The caller's per-call `cpu_sec` (`undefined` = not passed). */
  requested: number | undefined;
  /** Deployer ceiling: `config.maxCpuSec`. */
  maxCpuSec: number;
  /**
   * The **effective** wall clock of this call in ms (the value `resolveTimeout`
   * returned), or `null` for a background spawn — which has no call-level wall
   * clock and therefore nothing to follow.
   */
  wallClockMs: number | null;
}

/**
 * Resolve the effective `RLIMIT_CPU` of ONE call from its three possible
 * sources (see [CpuSource]). An explicit `cpu_sec` always wins over a derived
 * default and is clamped to `maxCpuSec` exactly as before — clamping is
 * reported (`clamped: true`), never an error.
 */
export function resolveCallCpuSec(input: CallCpuInput): CallCpuResolution {
  const { requested, maxCpuSec, wallClockMs } = input;
  const background = Math.max(Math.trunc(maxCpuSec), 1);
  const fallback = wallClockMs === null ? background : deriveCpuSecFromWallClock(wallClockMs, maxCpuSec);
  const resolved = resolveCpuSec(fallback, requested, maxCpuSec);
  const source: CpuSource =
    requested === undefined ? (wallClockMs === null ? "background" : "wall-clock") : "explicit";
  return { ...resolved, source };
}
