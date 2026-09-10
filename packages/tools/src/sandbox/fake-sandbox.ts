/**
 * Fake `Sandbox` — a scripted, in-memory implementation of the seam.
 *
 * Purpose: prove the seam is genuinely replaceable (ARCHITECTURE.md §7.4) and
 * let the tool pipeline and the process registry be tested without spawning any
 * real process: stdout/stderr are synthetic streams, exits are scripted, and
 * `terminate()` can be made deliberately ignorable so the SIGKILL escalation
 * path is observable. It is a test double, not a production provider.
 */

import { PassThrough, Readable } from "node:stream";

import type {
  Sandbox,
  SandboxChild,
  SandboxConfig,
  SandboxExit,
  SandboxMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSpawnRequest,
  SandboxSpawned,
} from "@celestea/core";
import { SandboxError, USERSPACE_SANDBOX_META } from "@celestea/core";

import { buildSandboxConfig, type SandboxConfigOverrides } from "./config.js";

export interface FakeScript {
  stdout?: readonly string[];
  stderr?: readonly string[];
  exitCode?: number | null;
  /** ms before the child exits on its own; `Infinity` = never exits. */
  exitAfterMs?: number;
  /** true = `terminate()` is ignored (exercises the SIGKILL escalation). */
  ignoresSigterm?: boolean;
}

export interface FakeSandboxOptions {
  scripts?: readonly FakeScript[];
  fallback?: FakeScript;
  config?: SandboxConfigOverrides;
  meta?: SandboxMeta;
}

export interface FakeSpawnRecord {
  command: string;
  workdir: string | undefined;
  child: FakeChild;
}

/** Scripted child: synthetic pipes, scripted exit, observable signals. */
export class FakeChild implements SandboxChild {
  readonly pid: number;
  readonly stdin: PassThrough = new PassThrough();
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly written: string[] = [];
  termAttempts = 0;
  killAttempts = 0;
  private resolved: SandboxExit | null = null;
  private resolveWait: ((exit: SandboxExit) => void) | null = null;
  private readonly waited: Promise<SandboxExit>;
  private readonly script: FakeScript;

  constructor(pid: number, script: FakeScript) {
    this.pid = pid;
    this.script = script;
    this.stdout = Readable.from(script.stdout ?? []);
    this.stderr = Readable.from(script.stderr ?? []);
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString("utf8")));
    this.waited = new Promise<SandboxExit>((resolve) => {
      this.resolveWait = resolve;
    });
    const delayMs = script.exitAfterMs ?? 0;
    if (Number.isFinite(delayMs)) {
      const timer = setTimeout(() => this.settle({ code: script.exitCode ?? 0, signal: null }), delayMs);
      timer.unref?.();
    }
  }

  wait(): Promise<SandboxExit> {
    return this.waited;
  }

  terminate(): void {
    this.termAttempts += 1;
    if (this.script.ignoresSigterm === true) return;
    this.settle({ code: null, signal: "SIGTERM" });
  }

  kill(): void {
    this.killAttempts += 1;
    this.settle({ code: null, signal: "SIGKILL" });
  }

  private settle(exit: SandboxExit): void {
    if (this.resolved !== null) return;
    this.resolved = exit;
    this.resolveWait?.(exit);
  }
}

export interface FakeSandbox extends Sandbox {
  readonly spawns: FakeSpawnRecord[];
  readonly runs: string[];
  readonly lastChild: FakeChild | null;
}

export function createFakeSandbox(options: FakeSandboxOptions = {}): FakeSandbox {
  const config: SandboxConfig = buildSandboxConfig(options.config ?? {});
  const meta = options.meta ?? USERSPACE_SANDBOX_META;
  const scripts = [...(options.scripts ?? [])];
  const spawns: FakeSpawnRecord[] = [];
  const runs: string[] = [];
  let nextPid = 5000;
  const take = (): FakeScript => scripts.shift() ?? options.fallback ?? {};

  const child = (script: FakeScript): FakeChild => {
    nextPid += 1;
    return new FakeChild(nextPid, script);
  };

  return {
    config,
    spawns,
    runs,
    get lastChild(): FakeChild | null {
      return spawns.at(-1)?.child ?? null;
    },
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      const script = take();
      runs.push(request.command);
      const timeoutMs = request.timeoutMs ?? config.timeoutMs;
      const delayMs = script.exitAfterMs ?? 0;
      if (!Number.isFinite(delayMs) || delayMs > timeoutMs) {
        throw new SandboxError("timeout", `killed pid ? after ${timeoutMs}ms (stdout_captured_bytes=0 stderr_captured_bytes=0)`, {
          timeout_ms: timeoutMs,
        });
      }
      const stdout = clip((script.stdout ?? []).join(""), config.maxOutputBytes);
      const stderr = clip((script.stderr ?? []).join(""), config.maxOutputBytes);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code: script.exitCode ?? 0,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        sandbox: meta,
      };
    },
    async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
      const created = child(take());
      spawns.push({ command: request.command, workdir: request.workdir, child: created });
      return { child: created, sandbox: meta };
    },
  };
}

function clip(text: string, cap: number): { text: string; truncated: boolean } {
  return text.length <= cap ? { text, truncated: false } : { text: text.slice(0, cap), truncated: true };
}
