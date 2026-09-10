/**
 * Provider-neutral process plumbing: spawn → capture → deadline → reap.
 *
 * Every sandbox provider (`userspace`, `bwrap`) differs only in *what* it
 * execs; the hard parts are identical and live here so the two paths cannot
 * drift:
 * - the child leads its own **process group** (`detached`), so a timeout
 *   SIGKILLs the whole tree, not just the leader;
 * - each stream is drained to EOF while buffering at most `maxOutputBytes`
 *   (a chatty child can never deadlock on a full pipe);
 * - a timeout surfaces as a structured `SandboxError` carrying the captured
 *   byte counts and output previews.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import type { SandboxChild, SandboxConfig, SandboxMeta, SandboxRunResult } from "@celestea/core";
import { SandboxError } from "@celestea/core";

import { TIMED_OUT, withTimeout } from "./async.js";
import { signalTree, wrapChild } from "./child.js";

/** Grace allowed for a SIGKILLed child to be reaped before we stop waiting. */
export const REAP_GRACE_MS = 5_000;

export interface SpawnPlan {
  program: string;
  args: readonly string[];
  workdir: string;
  env: Record<string, string>;
  /** Extra fds passed to the child after stdio (index 3, 4, …). */
  extraFds?: readonly number[];
  /** stdin is piped for background children (`process_control` writes lines). */
  withStdin: boolean;
  /** Human-readable command for spawn-failure messages. */
  label: string;
}

export function validateSandboxConfig(config: SandboxConfig): void {
  if (config.maxOutputBytes <= 0) throw new SandboxError("config", "maxOutputBytes must be > 0");
  if (config.timeoutMs <= 0) throw new SandboxError("config", "timeoutMs must be > 0");
  if (config.maxTimeoutMs <= 0) throw new SandboxError("config", "maxTimeoutMs must be > 0");
}

export function resolveTimeout(config: SandboxConfig, override: number | undefined): number {
  if (override === undefined) return config.timeoutMs;
  if (override < 1) throw new SandboxError("arg", `timeoutMs must be >= 1, got ${override}`);
  if (override > config.maxTimeoutMs) {
    throw new SandboxError("arg", `timeoutMs=${override} exceeds the sandbox maximum ${config.maxTimeoutMs}ms`);
  }
  return override;
}

/** Spawn the plan; rejects with a structured `spawn` error, never a bare throw. */
export function spawnPlan(plan: SpawnPlan): Promise<ChildProcess> {
  const stdio: Array<"ignore" | "pipe" | number> = [
    plan.withStdin ? "pipe" : "ignore",
    "pipe",
    "pipe",
    ...(plan.extraFds ?? []),
  ];
  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(plan.program, [...plan.args], {
      cwd: plan.workdir,
      env: plan.env,
      stdio,
      detached: true,
    });
    child.once("spawn", () => resolve(child));
    child.once("error", (error) => {
      reject(new SandboxError("spawn", `failed to start '${preview(plan.label, 256)}': ${error.message}`));
    });
  });
}

/** Enforce the deadline, cap both streams, and report the effective meta. */
export async function captureRun(
  config: SandboxConfig,
  child: ChildProcess,
  timeoutMs: number,
  meta: SandboxMeta,
): Promise<SandboxRunResult> {
  const sandboxed = wrapChild(child, { detached: true });
  const outPromise = readCapped(child.stdout, config.maxOutputBytes);
  const errPromise = readCapped(child.stderr, config.maxOutputBytes);
  const exit = await withTimeout(sandboxed.wait(), timeoutMs);
  if (exit === TIMED_OUT) throw await timeoutFailure(sandboxed, outPromise, errPromise, timeoutMs);
  const [stdout, stderr] = await Promise.all([outPromise, errPromise]);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exit_code: exit.code,
    stdout_truncated: stdout.truncated,
    stderr_truncated: stderr.truncated,
    sandbox: meta,
  };
}

async function timeoutFailure(
  sandboxed: SandboxChild,
  outPromise: Promise<CappedText>,
  errPromise: Promise<CappedText>,
  timeoutMs: number,
): Promise<SandboxError> {
  sandboxed.kill();
  await withTimeout(sandboxed.wait(), REAP_GRACE_MS);
  const stdout = await outPromise;
  const stderr = await errPromise;
  const detail = {
    pid: sandboxed.pid,
    timeout_ms: timeoutMs,
    stdout_captured: stdout.bytes,
    stderr_captured: stderr.bytes,
  };
  return new SandboxError(
    "timeout",
    `killed pid ${sandboxed.pid ?? "?"} after ${timeoutMs}ms (stdout_captured_bytes=${stdout.bytes} stderr_captured_bytes=${stderr.bytes} stdout_preview="${preview(stdout.text, 512)}" stderr_preview="${preview(stderr.text, 512)}")`,
    detail,
  );
}

export interface CappedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * Drain a stream to EOF while buffering at most `cap` bytes. Bytes past the cap
 * are read and discarded (never buffered) so a chatty child can still finish
 * and its exit code stays observable.
 */
export async function readCapped(stream: Readable | null, cap: number): Promise<CappedText> {
  if (stream === null) return { text: "", bytes: 0, truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = cap - size;
      if (buffer.length < room) {
        chunks.push(buffer);
        size += buffer.length;
        continue;
      }
      if (room > 0) chunks.push(buffer.subarray(0, room));
      size = cap;
      truncated = true;
    }
  } catch {
    // A killed child tears its pipes down mid-read; the bytes captured so far
    // are still the honest answer (the Rust path drains to EOF the same way).
    return { text: Buffer.concat(chunks).toString("utf8"), bytes: size, truncated };
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: size, truncated };
}

/** Single-line, truncated preview for error messages (Rust `preview`). */
export function preview(text: string, max: number): string {
  const folded = text.replace(/\r?\n/g, "\\n");
  return folded.length > max ? `${folded.slice(0, max)}…` : folded;
}

/** Signal the whole process group of a detached child (best effort). */
export function killDetached(child: ChildProcess, signal: NodeJS.Signals): void {
  signalTree(child, { detached: true }, signal);
}
