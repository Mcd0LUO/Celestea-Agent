/**
 * `SandboxChild` over a `node:child_process` child.
 *
 * The wrapper gives every sandbox provider the same handle shape (pid + three
 * streams + wait/terminate/kill), so the process registry never touches
 * provider internals. Signals target the whole **process group** when the child
 * was spawned detached — a shell that forked grandchildren must die with its
 * tree, not leave orphans behind.
 */

import type { ChildProcess } from "node:child_process";
import type { SandboxChild, SandboxExit } from "@celestea/core";

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
  if (process.platform === "win32") return false;
  try {
    // Negative pid targets the whole group: the child leads it (detached).
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // group already gone, or not ours to signal
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false; // already reaped
  }
}
