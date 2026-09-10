/**
 * Sandbox configuration and spawn plumbing for the userspace implementation
 * (`crates/tools/src/sandbox.rs`, v1 userspace path).
 *
 * Everything an operator can tune is an env knob, read once per sandbox
 * construction; the child environment is an **allowlist** (never the whole host
 * environment, and deliberately never `HOME`: `~/.ssh`, `~/.aws`, `~/.gnupg`
 * must not ride along).
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SandboxConfig } from "@celestea/core";

import { envInt, envString } from "../env.js";

/** Env var: default kill deadline in milliseconds. */
export const ENV_SHELL_TIMEOUT_MS = "CELAESTEA_RUN_SHELL_TIMEOUT_MS";
/** Env var: upper bound accepted for a per-call `timeout_ms`. */
export const ENV_SHELL_MAX_TIMEOUT_MS = "CELESTEA_SHELL_MAX_TIMEOUT_MS";
/** Env var: per-stream output cap in bytes. */
export const ENV_SHELL_MAX_OUTPUT_BYTES = "CELAESTEA_RUN_SHELL_MAX_OUTPUT_BYTES";
/** Env var: fixed default workdir. */
export const ENV_SHELL_WORKDIR = "CELAESTEA_RUN_SHELL_WORKDIR";
/** Env var: canonical root every resolved workdir must stay inside. */
export const ENV_SHELL_ROOT = "CELAESTEA_RUN_SHELL_ROOT";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Host env vars passed through to the child (whitelist, not blacklist). */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PWD",
];

export interface SandboxConfigOverrides {
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  workdir?: string;
  root?: string;
  extraEnv?: ReadonlyArray<readonly [string, string]>;
}

/** Configuration from `CELAESTEA_RUN_SHELL_*` / `CELESTEA_SHELL_MAX_TIMEOUT_MS`. */
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const workdir = resolveOrCwd(envString(env, ENV_SHELL_WORKDIR) ?? process.cwd());
  return buildSandboxConfig({
    timeoutMs: positive(envInt(env, ENV_SHELL_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: positive(envInt(env, ENV_SHELL_MAX_TIMEOUT_MS), DEFAULT_MAX_TIMEOUT_MS),
    maxOutputBytes: positive(envInt(env, ENV_SHELL_MAX_OUTPUT_BYTES), DEFAULT_MAX_OUTPUT_BYTES),
    workdir,
    root: resolveOrCwd(envString(env, ENV_SHELL_ROOT) ?? gitToplevelOr(workdir)),
  });
}

/** Materialize a config, filling defaults (tests pin explicit knobs). */
export function buildSandboxConfig(overrides: SandboxConfigOverrides = {}): SandboxConfig {
  const workdir = resolveOrCwd(overrides.workdir ?? process.cwd());
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: overrides.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    workdir,
    root: resolveOrCwd(overrides.root ?? gitToplevelOr(workdir)),
    extraEnv: overrides.extraEnv ?? [],
  };
}

/** `{program, args}` of the platform shell (`sh -c` / `cmd.exe /C`). */
export function shellInvocation(command: string): { program: string; args: string[] } {
  if (process.platform === "win32") {
    return { program: process.env["ComSpec"] ?? "cmd.exe", args: ["/C", command] };
  }
  return { program: "/bin/sh", args: ["-c", command] };
}

/** Allowlisted host env plus explicit operator additions (never `HOME`). */
export function sanitizedEnv(
  config: SandboxConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  for (const [name, value] of config.extraEnv) out[name] = value;
  return out;
}

/** Walk up from `start` looking for a git marker (dir `.git` or a worktree file). */
export function gitToplevelOr(start: string): string {
  const pinned = resolveOrCwd(start);
  let current = pinned;
  for (;;) {
    if (statOrNull(join(current, ".git")) !== null) return current;
    const parent = dirname(current);
    if (parent === current) return pinned; // filesystem root: fully pinned
    current = parent;
  }
}

function resolveOrCwd(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function statOrNull(target: string) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}
