/**
 * `SandboxChild` over a `node:child_process` child.
 *
 * The wrapper gives every sandbox provider the same handle shape (pid + three
 * streams + wait/terminate/kill), so the process registry never touches
 * provider internals. Signals target the whole **process group** when the child
 * was spawned detached — a shell that forked grandchildren must die with its
 * tree, not leave orphans behind.
 */

import { execFileSync, type ChildProcess } from "node:child_process";
import type { SandboxChild, SandboxExit } from "@celestea/core";

import { isWindows } from "../platform/paths.js";

export interface WrapOptions {
  /** Child was spawned with `detached: true` (it leads its own process group). */
  detached: boolean;
}

export function wrapChild(child: ChildProcess, options: WrapOptions): SandboxChild {
  let settled: SandboxExit | null = null;
  let resolveWait: ((exit: SandboxExit) => void) | null = null;
  const waitPromise = new Promise<SandboxExit>((resolve) => {
    resolveWait = resolve;
  });
  const settle = (exit: SandboxExit): void => {
    if (settled !== null) return;
    settled = exit;
    resolveWait?.(exit);
  };
  // `close` (not `exit`) fires once the stdio pipes are drained, so a reader
  // that starts after `wait()` never loses buffered output.
  child.once("close", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => settle({ code: null, signal: error.name }));
  return {
    pid: child.pid ?? null,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    wait: () => waitPromise,
    terminate: () => signalTree(child, options, "SIGTERM"),
    kill: () => signalTree(child, options, "SIGKILL"),
  };
}

/** Best-effort signal of the child's whole process group (falls back to child). */
export function signalTree(child: ChildProcess, options: WrapOptions, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && options.detached && signalProcessGroup(pid, signal)) return;
  signalChild(child, signal);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (isWindows()) return taskkillTree(pid);
  try {
    // Negative pid targets the whole group: the child leads it (detached).
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // group already gone, or not ours to signal
  }
}

/**
 * W885 — Windows process-tree recycling, BEST EFFORT.
 *
 * Windows has no POSIX process group and Node's `child.kill()` signals only the
 * DIRECT child (W883 B10), so a `cmd.exe` that forked grandchildren would leak
 * them. `taskkill /T` walks the parent-child chain and is the only tool the OS
 * ships for this, but it is NOT an atomic boundary — standard Windows: a child
 * can re-parent or die between the walk and the kill (TOCTOU) — which is why the
 * real fix is a **Job Object** and is deferred to W885 slice 2 (Job Objects +
 * resource limits + the Windows sandbox provider).
 *
 * Slice-2 TODO: create the child inside a Job Object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so the tree dies atomically with the
 * parent, instead of racing `taskkill`. The behaviour here is therefore
 * "best-effort", never a guarantee.
 *
 * NOT verifiable on this host (Linux): the branch selection is unit-tested
 * (`child.test.ts` injects `platform`), the actual kill is not.
 */
export function taskkillTree(pid: number, platform: string = process.platform): boolean {
  if (!isWindows(platform)) return false;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: WINDOWS_TASKKILL_TIMEOUT_MS });
    return true;
  } catch {
    // taskkill missing, the pid already gone, or access denied: the caller
    // falls back to `child.kill()`, which still stops the direct child.
    return false;
  }
}

/** taskkill is a local, bounded operation; never let it stall a timeout path. */
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false; // already reaped
  }
}
