/**
 * F4 step 2b: the memory backstop for an RLIMIT_AS-exempted browser.
 *
 * Exempting RLIMIT_AS (step 2a) removes the sandbox's only virtual-memory
 * bound, so this module re-establishes a REAL one, in this order:
 *
 *   1. **cgroup v2 memory.max** — exact and kernel-enforced, but only when the
 *      service's cgroup is delegated (writable). Measured on the target host:
 *      /sys/fs/cgroup is read-only (mkdir -> EACCES), so this path is attempted
 *      and honestly reported as unavailable.
 *   2. **bounded RSS watchdog** — sample the process tree's VmRSS on an interval
 *      and SIGKILL the tree when it exceeds the cap. This is BOUNDED but not
 *      instantaneous: a fast allocator can overshoot by one sampling window.
 *   3. **none** — no /proc, no pid: reported as "none" with the reason. Never
 *      silently claimed as protected.
 *
 * The guard is deliberately injectable (readRssKb / killTree / cgroupRoot) so
 * the watchdog logic is unit-tested without allocating real memory.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isWindows } from "../platform/paths.js";
import { taskkillTree } from "../sandbox/child.js";

export type MemoryGuardKind = "cgroup-v2" | "rss-watchdog" | "none";

/** What backstop is actually in force (reported in every browser result). */
export interface MemoryGuardStatus {
  kind: MemoryGuardKind;
  limit_mb: number | null;
  detail: string;
  /** true once the watchdog killed the tree for exceeding the cap. */
  killed: boolean;
}

export interface MemoryGuard {
  status(): MemoryGuardStatus;
  dispose(): void;
}

export interface MemoryGuardOptions {
  pid: number | null;
  limitMb: number;
  /** Default "/sys/fs/cgroup". */
  cgroupRoot?: string;
  /** Override the current cgroup path (tests). Default: read /proc/self/cgroup. */
  cgroupPath?: string | null;
  /** VmRSS in KiB for the whole tree; null = unreadable. */
  readRssKb?: (pid: number) => number | null;
  /** SIGKILL the whole tree. */
  killTree?: (pid: number) => void;
  intervalMs?: number;
}

/** Default cap: 1 GiB of RSS for one browser tree. */
export const DEFAULT_BROWSER_MEMORY_MB = 1024;
/** Default sampling window. */
export const DEFAULT_RSS_INTERVAL_MS = 500;

/** Arm the strongest available backstop; always returns a truthful status. */
export function armMemoryGuard(options: MemoryGuardOptions): MemoryGuard {
  const pid = options.pid;
  const limitMb = options.limitMb;
  if (pid === null || pid === undefined) return noneGuard("no pid: nothing to watch");
  const cgroup = tryCgroupGuard(pid, limitMb, options);
  if (cgroup !== null) return cgroup;
  return rssGuard(pid, limitMb, options);
}

/** Attempt cgroup v2 memory.max; null when the hierarchy is not writable. */
function tryCgroupGuard(pid: number, limitMb: number, options: MemoryGuardOptions): MemoryGuard | null {
  const root = options.cgroupRoot ?? "/sys/fs/cgroup";
  const path = options.cgroupPath === undefined ? readOwnCgroupPath() : options.cgroupPath;
  if (path === null) return null;
  const dir = join(root, path, "celestea-browser-" + pid);
  try {
    mkdirSync(dir, { recursive: false });
    writeFileSync(join(dir, "memory.max"), String(limitMb * 1024 * 1024));
    writeFileSync(join(dir, "cgroup.procs"), String(pid));
  } catch {
    // Not delegated / read-only / already exists: clean up and fall back.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return null;
  }
  const status: MemoryGuardStatus = {
    kind: "cgroup-v2",
    limit_mb: limitMb,
    detail: "cgroup v2 memory.max=" + limitMb + "MiB at " + dir + " (kernel-enforced)",
    killed: false,
  };
  return {
    status: () => ({ ...status }),
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the kernel keeps the cgroup until the last task leaves */
      }
    },
  };
}

/** Read this process's own cgroup v2 path from /proc/self/cgroup. */
export function readOwnCgroupPath(procRoot = "/proc"): string | null {
  try {
    const text = readFileSync(join(procRoot, "self", "cgroup"), "utf8");
    for (const line of text.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3 && parts[0] === "0") return parts[2] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Bounded RSS watchdog: sample, kill on overshoot, report the window. */
function rssGuard(pid: number, limitMb: number, options: MemoryGuardOptions): MemoryGuard {
  const readRss = options.readRssKb ?? readTreeRssKb;
  const killTree = options.killTree ?? defaultKillTree;
  const intervalMs = options.intervalMs ?? DEFAULT_RSS_INTERVAL_MS;
  let killed = false;
  let lastKb: number | null = null;
  const timer = setInterval(() => {
    if (killed) return;
    const kb = readRss(pid);
    lastKb = kb;
    if (kb !== null && kb / 1024 > limitMb) {
      killed = true;
      killTree(pid);
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref();
  return {
    status: () => ({
      kind: "rss-watchdog",
      limit_mb: limitMb,
      detail:
        "cgroup v2 memory.max unavailable (read-only hierarchy); sampling the tree's VmRSS every " +
        intervalMs +
        "ms against a " +
        limitMb +
        "MiB cap" +
        (lastKb === null ? "" : " (last sample " + Math.round(lastKb / 1024) + "MiB)"),
      killed,
    }),
    dispose: () => clearInterval(timer),
  };
}

function noneGuard(detail: string): MemoryGuard {
  return {
    status: () => ({ kind: "none", limit_mb: null, detail, killed: false }),
    dispose: () => undefined,
  };
}

/** Sum VmRSS (KiB) over the pid and every descendant, bounded. */
export function readTreeRssKb(pid: number, procRoot = "/proc", maxPids = 2000): number | null {
  const seen = new Set<number>();
  const queue = [pid];
  let total = 0;
  let read = 0;
  while (queue.length > 0 && seen.size < maxPids) {
    const current = queue.shift() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    const kb = readVmRssKb(current, procRoot);
    if (kb !== null) {
      total += kb;
      read += 1;
    }
    for (const child of childPids(current, procRoot)) queue.push(child);
  }
  return read === 0 ? null : total;
}

function readVmRssKb(pid: number, procRoot: string): number | null {
  try {
    const text = readFileSync(join(procRoot, String(pid), "status"), "utf8");
    for (const line of text.split("\n")) {
      if (!line.startsWith("VmRSS:")) continue;
      const value = Number(line.replace(/[^0-9]/g, ""));
      return Number.isFinite(value) ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Direct children of a pid via /proc/<pid>/task/<tid>/children. */
function childPids(pid: number, procRoot: string): number[] {
  const out: number[] = [];
  const taskDir = join(procRoot, String(pid), "task");
  let tasks: string[];
  try {
    tasks = readdirSync(taskDir);
  } catch {
    return out;
  }
  for (const tid of tasks) {
    try {
      const text = readFileSync(join(taskDir, tid, "children"), "utf8").trim();
      if (text === "") continue;
      for (const token of text.split(/\s+/)) {
        const child = Number(token);
        if (Number.isInteger(child) && child > 0) out.push(child);
      }
    } catch {
      /* the task vanished mid-scan */
    }
  }
  return out;
}

function defaultKillTree(pid: number): void {
  // W891: on Windows there is no POSIX process group (and no /proc), so the
  // group branch is skipped entirely rather than attempted-and-caught; taskkill
  // walks the real parent-child chain instead.
  if (isWindows()) {
    if (taskkillTree(pid)) return;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a group leader */
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
