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

import { CELESTEA_RUN_CODE_DIR, workspaceSubdir, type SandboxConfig } from "@celestea/core";

import { envInt, envString } from "../env.js";
import { resolveShell, type ShellResolveInput } from "../platform/exec.js";

/** Env var: default kill deadline in milliseconds. */
export const ENV_SHELL_TIMEOUT_MS = "CELAESTEA_RUN_SHELL_TIMEOUT_MS";
/** Env var: upper bound accepted for a per-call `timeout_ms`. */
export const ENV_SHELL_MAX_TIMEOUT_MS = "CELESTEA_SHELL_MAX_TIMEOUT_MS";
/** W6: env var for the upper bound accepted for a per-call `cpu_sec`. */
export const ENV_SHELL_MAX_CPU_SEC = "CELESTEA_SHELL_MAX_CPU_SEC";
/** Env var: per-stream output cap in bytes. */
export const ENV_SHELL_MAX_OUTPUT_BYTES = "CELAESTEA_RUN_SHELL_MAX_OUTPUT_BYTES";
/** Env var: fixed default workdir. */
export const ENV_SHELL_WORKDIR = "CELAESTEA_RUN_SHELL_WORKDIR";
/** Env var: canonical root every resolved workdir must stay inside. */
export const ENV_SHELL_ROOT = "CELAESTEA_RUN_SHELL_ROOT";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TIMEOUT_MS = 300_000;
/** W6: `cpu_sec` above this is CLAMPED to it (not rejected). */
export const DEFAULT_MAX_CPU_SEC = 600;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * W9112: the interpreter env that makes a PYTHON child speak UTF-8.
 *
 * Root cause of the silent data corruption this fixes (measured, Windows 11 /
 * Python 3.11): with no env, a Python child on Windows inherits the ANSI code
 * page — `sys.stdout.encoding == sys.stdin.encoding == "gbk"`, and
 * `locale.getpreferredencoding(False) == "cp936"`. The `run_code` protocol is
 * UTF-8 on the wire in BOTH directions, so:
 *
 * - the child writes GBK bytes to stdout, the broker decodes them as UTF-8
 *   (`safeUtf8`) and every Chinese character silently becomes U+FFFD — the JSON
 *   frame stays valid, so `error === null` and the corruption is invisible;
 * - the parent writes UTF-8 bytes to the child's stdin, Python decodes them as
 *   GBK, and `tools.read_file` answers mojibake (the opposite direction, same
 *   root cause);
 * - a character GBK cannot encode (emoji) raises `UnicodeEncodeError` instead.
 *
 * `PYTHONUTF8=1` is Python's official UTF-8 Mode (3.7+). It is the variable
 * chosen over `PYTHONIOENCODING=utf-8` because it fixes the WHOLE interpreter
 * and not only the three stdio streams (both measured):
 *
 * | `sys.stdout.encoding` | `locale.getpreferredencoding(False)` | bare `open(p, "w")` bytes |
 * |---|---|---|
 * | (nothing)              | `gbk` | `cp936` | GBK — corrupt |
 * | `PYTHONIOENCODING`     | `utf-8` | `cp936` | **GBK — still corrupt** |
 * | `PYTHONUTF8=1`         | `utf-8` | `utf-8` | UTF-8 |
 *
 * A program that writes its own file with plain `open()` is exactly the
 * "题库" case that was corrupted, so the stdio-only variable would have left the
 * most damaging path broken. UTF-8 Mode also sets `sys.flags.utf8_mode == 1`,
 * which is the honest, machine-checkable statement of "this child is UTF-8".
 *
 * Scope of the side effects (why this is safe): only a Python interpreter reads
 * the variable, so it is a no-op for a Node child and for `run_shell` commands;
 * and on POSIX `python3` already runs in UTF-8 mode, so a Linux/macOS child's
 * environment and behaviour are byte-for-byte unchanged. It is injected for
 * EVERY Windows sandbox child rather than only the `run_code` Python one
 * because the whole tools layer is UTF-8 end to end: a nested `python` launched
 * through `run_shell` hits the identical corruption, and leaving it on the ANSI
 * code page while the broker speaks UTF-8 would only move the bug one layer
 * down. See [windowsUtf8Env] for the pure seam and [sanitizedEnv] for how the
 * value reaches the child.
 */
export const PYTHON_UTF8_ENV: ReadonlyArray<readonly [string, string]> = [["PYTHONUTF8", "1"]];

/**
 * W9112: the extra child env a platform needs so a Python interpreter speaks
 * UTF-8 — the pure, injectable seam the POSIX-invariance test pins.
 *
 * Windows answers [PYTHON_UTF8_ENV]; every other platform answers an empty
 * list, so a Linux/macOS child environment is byte-for-byte what it was before
 * this change. `platform` is an argument (the W885 seam) so the win32 answer is
 * unit-tested on Linux.
 */
export function windowsUtf8Env(platform: string = process.platform): ReadonlyArray<readonly [string, string]> {
  return platform === "win32" ? PYTHON_UTF8_ENV : [];
}

/** Host env vars passed through to the child on POSIX (whitelist, not blacklist). */
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

/**
 * The same whitelist for Windows — **without which `cmd.exe` cannot start**.
 *
 * Windows report (2026-09-19, Windows 11 / Node 26): the POSIX list was the only
 * list, so the child received `PATH` and almost nothing else. `cmd.exe` finds its
 * own DLLs through `SystemRoot`, is re-found through `ComSpec`, resolves `foo`
 * to `foo.exe` through `PATHEXT`, and writes temp files through `TEMP`/`TMP` —
 * with none of those present, `run_shell` fails on Windows.
 *
 * Deliberately a CURATED list, never "pass the whole environment": the POSIX side
 * excludes `HOME` on purpose. `USERPROFILE`/`APPDATA` are the Windows spellings of
 * `HOME` and are included because Windows tooling expects them; a POSIX shell
 * simply does not read them, which is the only reason they were not listed.
 */
export const ENV_ALLOWLIST_WIN32: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "USERNAME",
  "USERDOMAIN",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "TZ",
  "TERM",
];

/**
 * The whitelist for a platform. `platform` is injectable so the Windows answer is
 * unit-tested on Linux (the W885 seam); production passes the host's.
 */
export function envAllowlist(platform: string = process.platform): readonly string[] {
  return platform === "win32" ? ENV_ALLOWLIST_WIN32 : ENV_ALLOWLIST;
}

/**
 * W768: the per-SESSION filesystem scope. One value, resolved by the HOST from
 * the session's own workspace record — never from a process-wide env knob —
 * because a process serves several sessions and `process.cwd()` cannot describe
 * more than one of them.
 *
 * `workspace` is both the default cwd of every spawned command and the root a
 * workdir must stay inside, so "where am I" and "what may I touch" cannot
 * disagree.
 */
export interface SessionFsScope {
  /** Absolute, canonical workspace root of the session being composed. */
  workspace: string;
}

export interface SandboxConfigOverrides {
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxCpuSec?: number;
  maxOutputBytes?: number;
  workdir?: string;
  root?: string;
  /** W880: override the run_code program directory (tests / embeddings). */
  programDir?: string;
  extraEnv?: ReadonlyArray<readonly [string, string]>;
  /**
   * W9112: the platform the config is built for; selects [windowsUtf8Env].
   * Defaults to the host's, and is injectable so the win32 branch is
   * unit-tested on Linux (the W885 seam).
   */
  platform?: string;
}

/**
 * Configuration from `CELAESTEA_RUN_SHELL_*` / `CELESTEA_SHELL_MAX_TIMEOUT_MS`.
 *
 * W768: `overrides` is how a session's OWN workspace replaces the process-wide
 * default. `workdir`/`root` are the only two knobs a session may set — the
 * limits stay operator policy — and with no override the env reading is byte for
 * byte what it always was (the fallback path for detached/legacy sessions).
 */
export function sandboxConfigFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: SandboxConfigOverrides = {}): SandboxConfig {
  const workdir = resolveOrCwd(overrides.workdir ?? envString(env, ENV_SHELL_WORKDIR) ?? process.cwd());
  return buildSandboxConfig({
    timeoutMs: positive(envInt(env, ENV_SHELL_TIMEOUT_MS), DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: positive(envInt(env, ENV_SHELL_MAX_TIMEOUT_MS), DEFAULT_MAX_TIMEOUT_MS),
    maxCpuSec: positive(envInt(env, ENV_SHELL_MAX_CPU_SEC), DEFAULT_MAX_CPU_SEC),
    maxOutputBytes: positive(envInt(env, ENV_SHELL_MAX_OUTPUT_BYTES), DEFAULT_MAX_OUTPUT_BYTES),
    workdir,
    root: resolveOrCwd(overrides.root ?? envString(env, ENV_SHELL_ROOT) ?? gitToplevelOr(workdir)),
    // W880: run_code programs live under CELESTEA_HOME, never in the workspace.
    programDir: overrides.programDir ?? workspaceSubdir(workdir, CELESTEA_RUN_CODE_DIR, { env }),
    // W9112: the platform seam travels with the overrides so a caller (tests)
    // can pin the win32 answer while running on Linux.
    ...(overrides.platform === undefined ? {} : { platform: overrides.platform }),
  });
}

/**
 * W768: the sandbox config of ONE session — the session's workspace as cwd and
 * root, the operator's limits unchanged. `null` scope = the env posture.
 */
export function sessionSandboxConfig(scope: SessionFsScope | null, env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  if (scope === null) return sandboxConfigFromEnv(env);
  return sandboxConfigFromEnv(env, { workdir: scope.workspace, root: scope.workspace });
}

/** Materialize a config, filling defaults (tests pin explicit knobs). */
export function buildSandboxConfig(overrides: SandboxConfigOverrides = {}): SandboxConfig {
  const workdir = resolveOrCwd(overrides.workdir ?? process.cwd());
  return {
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: overrides.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
    maxCpuSec: overrides.maxCpuSec ?? DEFAULT_MAX_CPU_SEC,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    workdir,
    root: resolveOrCwd(overrides.root ?? gitToplevelOr(workdir)),
    // Explicit construction (tests / embeddings) keeps the historical in-workspace
    // default; the ENV posture above is the one that uses CELESTEA_HOME.
    programDir: overrides.programDir ?? join(workdir, ".celestea", "run-code"),
    // W9112: the UTF-8 interpreter env rides on top of the operator's `extraEnv`.
    // It MUST travel in `extraEnv` rather than the host env the allowlist
    // filters: `sanitizedEnv` applies `extraEnv` AFTER the allowlist, so the
    // value reaches the child on every platform without depending on being
    // allow-listed (ENV_ALLOWLIST_WIN32 is a closed whitelist).
    extraEnv: [...windowsUtf8Env(overrides.platform), ...(overrides.extraEnv ?? [])],
  };
}

/**
 * `{program, args}` of the platform shell carrying exactly one command.
 *
 * W885: the decision moved into the injectable `resolveShell` ladder —
 * POSIX answers the literal `/bin/sh -c <command>` (byte-identical to the
 * pre-W885 code, asserted by `platform-exec.test.ts`), Windows walks
 * gitbash > pwsh > cmd. A host with no usable shell now fails closed with a
 * structured [ShellNotFoundError] instead of guessing `cmd.exe`; the
 * `input` seam is what lets the win32 ladder be unit-tested on Linux.
 */
export function shellInvocation(command: string, input: ShellResolveInput = {}): { program: string; args: string[] } {
  const shell = resolveShell(command, input);
  return { program: shell.path, args: [...shell.argv] };
}

/**
 * Allowlisted host env plus explicit operator additions (never `HOME`).
 *
 * `platform` selects the allowlist (see [envAllowlist]): Windows needs its own
 * names or the child shell cannot start.
 */
export function sanitizedEnv(
  config: SandboxConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of envAllowlist(platform)) {
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
