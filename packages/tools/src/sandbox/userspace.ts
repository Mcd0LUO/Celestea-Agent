/**
 * `UserspaceSandbox` — the P2b implementation of the `Sandbox` seam.
 *
 * It is honest about what it is: a **userspace-lite** executor with no OS
 * isolation at all (no namespaces, no seccomp, no private /tmp). What it does
 * enforce — and what the tool contract depends on — is:
 * - a fixed workdir that must resolve inside the configured root;
 * - an allowlisted child environment (never the host environment, never HOME);
 * - a kill deadline that SIGKILLs the whole process group;
 * - per-stream output caps, with the truncation flag reported;
 * - structured failures (`run_shell-sandbox: code=timeout|workdir|arg|config|spawn`).
 *
 * The real OS-level isolation is P2c (W274's spike); it replaces this
 * implementation behind the same seam without touching `run_shell`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";

import type {
  Sandbox,
  SandboxChild,
  SandboxConfig,
  SandboxMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSpawnRequest,
  SandboxSpawned,
} from "@celestea/core";
import { SandboxError, USERSPACE_SANDBOX_META } from "@celestea/core";

import { isInside } from "../guard/paths.js";
import { TIMED_OUT, withTimeout } from "./async.js";
import { signalTree, wrapChild } from "./child.js";
import {
  buildSandboxConfig,
  type SandboxConfigOverrides,
  ENV_SHELL_ROOT,
  ENV_SHELL_WORKDIR,
  sandboxConfigFromEnv,
  sanitizedEnv,
  shellInvocation,
} from "./config.js";

/** The effective mode every result reports (never inferred by the caller). */
export const USERSPACE_META: SandboxMeta = USERSPACE_SANDBOX_META;

/** Grace allowed for a SIGKILLed child to be reaped before we stop waiting. */
const REAP_GRACE_MS = 5_000;

export class UserspaceSandbox implements Sandbox {
  readonly config: SandboxConfig;

  constructor(config: SandboxConfig = sandboxConfigFromEnv()) {
    this.config = config;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): UserspaceSandbox {
    return new UserspaceSandbox(sandboxConfigFromEnv(env));
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    validateConfig(this.config);
    const timeoutMs = resolveTimeout(this.config, request.timeoutMs);
    const workdir = await resolveWorkdir(this.config, request.workdir);
    const child = await spawnShell(this.config, request.command, workdir, false);
    return capture(this.config, child, timeoutMs);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateConfig(this.config);
    const workdir = await resolveWorkdir(this.config, request.workdir);
    const child = await spawnShell(this.config, request.command, workdir, true);
    return { child: wrapChild(child, { detached: true }), sandbox: USERSPACE_META };
  }
}

/** Factory used by the compose root (`userspaceSandbox()` = env-tuned default). */
export function userspaceSandbox(config?: SandboxConfig): UserspaceSandbox {
  return new UserspaceSandbox(config ?? sandboxConfigFromEnv());
}

/** Factory with explicit knobs (tests / embeddings). */
export function userspaceSandboxWith(overrides: SandboxConfigOverrides): UserspaceSandbox {
  return new UserspaceSandbox(buildSandboxConfig(overrides));
}

function validateConfig(config: SandboxConfig): void {
  if (config.maxOutputBytes <= 0) throw new SandboxError("config", "maxOutputBytes must be > 0");
  if (config.timeoutMs <= 0) throw new SandboxError("config", "timeoutMs must be > 0");
  if (config.maxTimeoutMs <= 0) throw new SandboxError("config", "maxTimeoutMs must be > 0");
}

function resolveTimeout(config: SandboxConfig, override: number | undefined): number {
  if (override === undefined) return config.timeoutMs;
  if (override < 1) throw new SandboxError("arg", `timeoutMs must be >= 1, got ${override}`);
  if (override > config.maxTimeoutMs) {
    throw new SandboxError("arg", `timeoutMs=${override} exceeds the sandbox maximum ${config.maxTimeoutMs}ms`);
  }
  return override;
}

/** Resolve the effective workdir: existing, canonical, inside `config.root`. */
export async function resolveWorkdir(config: SandboxConfig, override?: string): Promise<string> {
  const root = (await canonicalOf(config.root)) ?? resolve(config.root);
  const target = override === undefined ? config.workdir : await resolveOverride(config.workdir, override);
  if (override === undefined) await mkdir(target, { recursive: true }).catch(() => undefined);
  const resolved = await canonicalOf(target);
  if (resolved === null) {
    throw new SandboxError("workdir", `workdir '${target}' cannot be resolved`, { requested: target });
  }
  if (!isInside(resolved, root)) {
    throw new SandboxError(
      "workdir",
      `workdir '${target}' is outside the sandbox root '${root}' (widen with ${ENV_SHELL_ROOT} or adjust ${ENV_SHELL_WORKDIR})`,
      { requested: target, root },
    );
  }
  return resolved;
}

async function resolveOverride(workdir: string, override: string): Promise<string> {
  const target = isAbsolute(override) ? override : resolve(workdir, override);
  const info = await stat(target).catch(() => null);
  if (info === null) {
    throw new SandboxError("workdir", `workdir '${override}' does not exist`, { requested: override });
  }
  if (!info.isDirectory()) {
    throw new SandboxError("workdir", `workdir '${override}' is not a directory`, { requested: override });
  }
  return target;
}

async function canonicalOf(target: string): Promise<string | null> {
  return realpath(target).catch(() => null);
}

function spawnShell(config: SandboxConfig, command: string, workdir: string, withStdin: boolean): Promise<ChildProcess> {
  const { program, args } = shellInvocation(command);
  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: workdir,
      env: sanitizedEnv(config),
      stdio: [withStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
    child.once("spawn", () => resolve(child));
    child.once("error", (error) => reject(new SandboxError("spawn", `failed to start '${preview(command, 256)}': ${error.message}`)));
  });
}

async function capture(config: SandboxConfig, child: ChildProcess, timeoutMs: number): Promise<SandboxRunResult> {
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
    sandbox: USERSPACE_META,
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
function preview(text: string, max: number): string {
  const folded = text.replace(/\r?\n/g, "\\n");
  return folded.length > max ? `${folded.slice(0, max)}…` : folded;
}
