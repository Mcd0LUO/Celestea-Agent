/**
 * Host self-check (`probeHost`): what isolation can this machine actually give?
 *
 * The probe is deliberately *evidence-based*: bwrap is only "usable" after it
 * has run the real mount sequence and read `/dev/zero` inside it (W274 §8.2).
 * A binary that exists but cannot create a namespace (AppArmor tightening, a
 * missing `bwrap-userns-restrict` exception, a deleted device node) must be
 * reported as unusable — never assumed working, never assumed broken.
 *
 * The result is memoized per process (the probe costs two short `execFileSync`s)
 * and is injectable, so policy tests never touch the host.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildBwrapArgv, DEFAULT_BWRAP_OPTIONS } from "./bwrap-argv.js";
import { countUidThreads } from "./limits.js";

/** Env var: explicit `bwrap` path (skips the PATH search). */
export const ENV_SANDBOX_BWRAP = "CELESTEA_SANDBOX_BWRAP";

/** One-shot device smoke: read a device node that only exists if order is right. */
const DEVICE_SMOKE = "exec 3</dev/zero 2>/dev/null && exec 4</dev/null && printf ok";
/** One-shot ulimit probe: the zero-dependency rlimit fallback. */
const ULIMIT_SMOKE = "ulimit -v 65536 2>/dev/null && ulimit -t 1 && printf ok";

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly bwrapPath: string | null;
  readonly bwrapVersion: string | null;
  /** true only after the ordered device smoke returned `ok`. */
  readonly bwrapUsable: boolean;
  /** Why the probe rejected bwrap (startup-log / degraded-reason material). */
  readonly bwrapRejectReason: string | null;
  readonly prlimitPath: string | null;
  readonly shellUlimitWorks: boolean;
  /** Threads owned by this uid host-wide → drives the `RLIMIT_NPROC` cap. */
  readonly uidThreads: number | null;
}

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Ignore (and replace) the memoized probe. */
  refresh?: boolean;
  /** Inject a uid thread count (tests); default: measure the host. */
  uidThreads?: number | null;
}

let cached: HostProbe | null = null;
let cachedKey: string | null = null;

/** Drop the memoized probe (tests, or after a host-level change). */
export function resetProbeCache(): void {
  cached = null;
  cachedKey = null;
}

/** Cache key: the probe answer depends on these two env values and nothing else. */
function cacheKey(env: NodeJS.ProcessEnv): string {
  return `${env[ENV_SANDBOX_BWRAP] ?? ""}\u0000${env["PATH"] ?? ""}`;
}

export function probeHost(options: ProbeOptions = {}): HostProbe {
  const env = options.env ?? process.env;
  const key = cacheKey(env);
  if (cached !== null && cachedKey === key && options.refresh !== true) return cached;
  cachedKey = key;
  const bwrap = probeBwrap(env);
  cached = {
    platform: process.platform,
    ...bwrap,
    prlimitPath: whichSync("prlimit", env),
    shellUlimitWorks: runOk("/bin/sh", ["-c", ULIMIT_SMOKE]).includes("ok"),
    uidThreads: options.uidThreads === undefined ? countUidThreads() : options.uidThreads,
  };
  return cached;
}

interface BwrapProbe {
  bwrapPath: string | null;
  bwrapVersion: string | null;
  bwrapUsable: boolean;
  bwrapRejectReason: string | null;
}

function probeBwrap(env: NodeJS.ProcessEnv): BwrapProbe {
  const path = resolveBwrapPath(env);
  if (path === null) return reject("bwrap not found on PATH (set CELESTEA_SANDBOX_BWRAP to pin one)");
  const version = run(path, ["--version"]);
  if (!version.ok) return reject(`${path} --version failed: ${version.out}`, path);
  if (process.platform !== "linux") return reject(`${path} reported ${version.out}, but this is not Linux`, path);
  const smoke = run(path, [...buildBwrapArgv(null, DEFAULT_BWRAP_OPTIONS), "--", "/bin/sh", "-c", DEVICE_SMOKE]);
  if (!smoke.out.includes("ok")) {
    return reject(`device smoke failed (argv order regression?): ${smoke.out || "(no output)"}`, path);
  }
  return { bwrapPath: path, bwrapVersion: version.out, bwrapUsable: true, bwrapRejectReason: null };
}

function reject(reason: string, path: string | null = null): BwrapProbe {
  return { bwrapPath: path, bwrapVersion: null, bwrapUsable: false, bwrapRejectReason: reason };
}

function resolveBwrapPath(env: NodeJS.ProcessEnv): string | null {
  const pinned = env[ENV_SANDBOX_BWRAP];
  if (pinned !== undefined && pinned.trim() !== "") {
    const candidate = pinned.trim();
    return existsSync(candidate) ? candidate : null;
  }
  return whichSync("bwrap", env);
}

/** PATH lookup that honours an explicitly passed env (no global mutation). */
export function whichSync(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of (env["PATH"] ?? "/usr/bin:/bin").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface RunResult {
  ok: boolean;
  out: string;
}

/** Run a short probe command; never throws, folds stdout+stderr into `out`. */
function run(file: string, args: readonly string[]): RunResult {
  try {
    const out = execFileSync(file, [...args], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).toString();
    return { ok: true, out };
  } catch (error) {
    const detail = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const out = `${detail.stdout?.toString() ?? ""}${detail.stderr?.toString() ?? ""}${detail.message ?? ""}`;
    return { ok: false, out };
  }
}

function runOk(file: string, args: readonly string[]): string {
  return run(file, args).out;
}
