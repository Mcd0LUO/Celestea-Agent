/**
 * Host self-check (`probeHost`): what isolation can this machine actually give?
 *
 * The probe is deliberately *evidence-based*: bwrap is only "usable" after it
 * has run the real mount sequence and read `/dev/zero` inside it (W274 §8.2).
 * A binary that exists but cannot create a namespace (AppArmor tightening, a
 * missing `bwrap-userns-restrict` exception, a deleted device node) must be
 * reported as unusable — never assumed working, never assumed broken.
 *
 * W1483 — the same one-shot smoke also MEASURES what the mount sequence actually
 * established: the namespace tokens that changed between the host and the probe
 * child, whether the root came out read-only, and whether `/tmp` is a private
 * tmpfs. `enforcement.ts` turns that evidence into `full` / `partial` per
 * provider, so "bwrap started but an isolation did not take effect" is a
 * reported fact instead of something each caller re-derives from booleans.
 *
 * The result is memoized per process (the probe costs two short `execFileSync`s)
 * and is injectable, so policy tests never touch the host.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { whichInPath } from "../platform/exec.js";
import { buildBwrapArgv, DEFAULT_BWRAP_OPTIONS } from "./bwrap-argv.js";
import { countUidThreads } from "./limits.js";

/** Env var: explicit `bwrap` path (skips the PATH search). */
export const ENV_SANDBOX_BWRAP = "CELESTEA_SANDBOX_BWRAP";

/**
 * One-shot device smoke: read a device node that only exists if order is right.
 *
 * W1483 appends the isolation evidence to the SAME run — a second `execFileSync`
 * would be another full bwrap startup for facts this child can print for free.
 * `ok` still leads, so `includes("ok")` remains the usability verdict, and every
 * evidence line is prefixed so it can never be mistaken for it.
 */
/**
 * The smoke script as a single `sh -c` payload: the device reads (W274), then
 * the W1483 isolation evidence. One line per fact group, joined with `;` so the
 * payload survives being embedded in an argv element verbatim.
 */
function deviceSmokeScript(): string {
  return [
    "exec 3</dev/zero 2>/dev/null && exec 4</dev/null && printf ok",
    "for ns in mnt pid net ipc uts user cgroup; do printf ' ns=%s:%s' \"$ns\" \"$(readlink /proc/self/ns/$ns 2>/dev/null || printf '?')\"; done",
    "root=; tmp=",
    "while read -r _dev mnt _type opts _rest; do [ \"$mnt\" = / ] && root=${opts%%,*}; [ \"$mnt\" = /tmp ] && tmp=$_type; done < /proc/self/mounts",
    "printf ' root=%s tmp=%s\\n' \"${root:-?}\" \"${tmp:-?}\"",
  ].join("; ");
}
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
  /**
   * W1483: namespace tokens the smoke child observed as DIFFERENT from the host
   * (`mnt`, `pid`, `net`, …).
   *
   * OPTIONAL on purpose: an injected probe (tests, embeddings) may not have run
   * a smoke at all. Absent = no observation, and `enforcement.ts` then reports
   * the namespace promises as gaps — an unverified run is never `full`.
   */
  readonly namespaceEvidence?: readonly string[];
  /** W1483: the smoke child saw `/` mounted read-only. Absent = not observed. */
  readonly readonlyRootObserved?: boolean;
  /** W1483: the smoke child saw a tmpfs mounted at `/tmp`. Absent = not observed. */
  readonly tmpPrivateObserved?: boolean;
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
  namespaceEvidence: readonly string[];
  readonlyRootObserved: boolean;
  tmpPrivateObserved: boolean;
}

function probeBwrap(env: NodeJS.ProcessEnv): BwrapProbe {
  const path = resolveBwrapPath(env);
  if (path === null) return reject("bwrap not found on PATH (set CELESTEA_SANDBOX_BWRAP to pin one)");
  const version = run(path, ["--version"]);
  if (!version.ok) return reject(`${path} --version failed: ${version.out}`, path);
  if (process.platform !== "linux") return reject(`${path} reported ${version.out}, but this is not Linux`, path);
  const smoke = run(path, [...buildBwrapArgv(null, DEFAULT_BWRAP_OPTIONS), "--", "/bin/sh", "-c", deviceSmokeScript()]);
  if (!smoke.out.includes("ok")) {
    return reject(`device smoke failed (argv order regression?): ${smoke.out || "(no output)"}`, path);
  }
  return { bwrapPath: path, bwrapVersion: version.out, bwrapUsable: true, bwrapRejectReason: null, ...smokeEvidence(smoke.out) };
}

function reject(reason: string, path: string | null = null): BwrapProbe {
  return {
    bwrapPath: path,
    bwrapVersion: null,
    bwrapUsable: false,
    bwrapRejectReason: reason,
    namespaceEvidence: [],
    readonlyRootObserved: false,
    tmpPrivateObserved: false,
  };
}

/**
 * W1483: read the isolation evidence back out of the smoke child's stdout.
 *
 * An unparsable line yields the ABSENT observation (empty set / false / false),
 * which `enforcement.ts` turns into gaps — never into an assumed `full`.
 */
export function smokeEvidence(output: string): Pick<BwrapProbe, "namespaceEvidence" | "readonlyRootObserved" | "tmpPrivateObserved"> {
  const evidence: string[] = [];
  for (const match of output.matchAll(/ ns=([a-z]+):(\S+)/g)) {
    const name = match[1];
    const token = match[2];
    if (name !== undefined && token !== undefined && token !== "?") evidence.push(name);
  }
  const root = / root=(\S+)/.exec(output)?.[1] ?? "";
  const tmp = / tmp=(\S+)/.exec(output)?.[1] ?? "";
  return {
    namespaceEvidence: evidence,
    // `ro` is the mount option bwrap's `--ro-bind / /` produces; anything else
    // (including an unreadable `?`) is NOT evidence of a read-only root.
    readonlyRootObserved: root.startsWith("ro"),
    tmpPrivateObserved: tmp === "tmpfs",
  };
}

function resolveBwrapPath(env: NodeJS.ProcessEnv): string | null {
  const pinned = env[ENV_SANDBOX_BWRAP];
  if (pinned !== undefined && pinned.trim() !== "") {
    const candidate = pinned.trim();
    return existsSync(candidate) ? candidate : null;
  }
  return whichSync("bwrap", env);
}

/**
 * PATH lookup that honours an explicitly passed env (no global mutation).
 *
 * W885: split per PLATFORM delimiter and, on Windows, with `PATHEXT`
 * suffixes — a Windows `PATH` is `;`-separated and its entries carry drive
 * letters, so the old `split(":")` produced meaningless results there
 * (W883 B13). `platform` is injectable so the win32 rule is testable on Linux.
 */
export function whichSync(bin: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  return whichInPath(bin, platform, env);
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
