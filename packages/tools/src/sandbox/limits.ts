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
