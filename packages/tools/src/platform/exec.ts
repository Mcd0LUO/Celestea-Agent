/**
 * Shell resolution (W885) — WHICH shell runs a `run_shell` / `run_code` command.
 *
 * Product decision (W885): on Windows the priority is
 *
 *   gitbash > pwsh > cmd
 *
 * and the choice is **probe-based, never guessed**: every candidate is looked up
 * through the injected `which` / `exists` callbacks (defaults: the filesystem +
 * `PATH`), and when nothing is found the resolver **fails closed** with a
 * structured [ShellNotFoundError] instead of silently picking a shell the host
 * may not have.
 *
 * Linux behaviour is byte-identical to the pre-W885 code: the POSIX answer is
 * the literal `/bin/sh` with argv `["-c", command]` (W883 B8 anchored that
 * shape in `config.ts` / `bwrap-argv.ts`). `$SHELL` is deliberately NOT
 * consulted implicitly — that would change what runs on every Linux host that
 * exports it; an operator pins a shell explicitly with `CELESTEA_SHELL`.
 *
 * Pure and injectable: the platform / env / homedir inputs are arguments (the
 * `celestea-home.ts` pattern), so the win32 branches are unit-testable on
 * Linux.
 */

import { existsSync } from "node:fs";

import { envValue, execSuffixes, isWindows, pathApi, pathDelimiter, type PlatformInput } from "./paths.js";

/** Which family of shell the resolved executable belongs to. */
export type ShellKind = "posix" | "gitbash" | "pwsh" | "cmd";

/** A resolved shell: the executable plus the argv that carries one command. */
export interface ResolvedShell {
  readonly kind: ShellKind;
  /** Absolute executable path (or a bare name when a lookup returned one). */
  readonly path: string;
  /** Arguments after the program; the command body is ALWAYS the last element. */
  readonly argv: readonly string[];
}

/** Env var pinning one explicit shell executable (any platform, fail-closed). */
export const ENV_SHELL_PIN = "CELESTEA_SHELL";

/** Structured failure: no usable shell on this host (never a fallback guess). */
export class ShellNotFoundError extends Error {
  readonly code = "shell_not_found";

  constructor(message: string) {
    super(message);
    this.name = "ShellNotFoundError";
  }
}

/** Injectable lookups (tests simulate hosts without touching the filesystem). */
export interface ShellLookup {
  /** Resolve a bare executable name against PATH (win32: PATHEXT honoured). */
  which: (bin: string) => string | null;
  /** Does this absolute path exist? */
  exists: (path: string) => boolean;
}

export interface ShellResolveInput extends PlatformInput {
  which?: (bin: string) => string | null;
  exists?: (path: string) => boolean;
}

/** The argv shape of one shell carrying exactly one command string. */
export function shellArgv(kind: ShellKind, command: string): string[] {
  if (kind === "pwsh") return ["-NoProfile", "-NonInteractive", "-Command", command];
  if (kind === "cmd") return ["/d", "/s", "/c", command];
  // posix + gitbash both speak `sh -c`.
  return ["-c", command];
}

/**
 * Resolve the shell that should carry `command` on `platform`.
 *
 * Precedence: an explicit `CELESTEA_SHELL` pin > the platform ladder
 * (POSIX: `/bin/sh`; Windows: gitbash > pwsh > cmd). Nothing found ⇒ throws.
 */
export function resolveShell(command: string, input: ShellResolveInput = {}): ResolvedShell {
  const chosen = resolveShellKind(input);
  return { ...chosen, argv: shellArgv(chosen.kind, command) };
}

/**
 * The shell a command WOULD be given to, without a command (W885: `run_code`
 * needs the kind to quote its interpreter line before it has one).
 */
export function resolveShellKind(input: ShellResolveInput = {}): { kind: ShellKind; path: string } {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const lookup = lookupFor(platform, env, input);
  const pinned = envValue(env, ENV_SHELL_PIN);
  if (pinned !== undefined) return pinnedShell(pinned, platform, lookup);
  return isWindows(platform) ? resolveWindows(env, lookup) : resolvePosix();
}

/** The default lookups: real filesystem, PATH split per platform delimiter. */
export function lookupFor(platform: string, env: Record<string, string | undefined>, input: ShellResolveInput = {}): ShellLookup {
  const exists = input.exists ?? ((path: string) => existsSync(path));
  return { which: input.which ?? ((bin: string) => whichInPath(bin, platform, env, exists)), exists };
}

function resolvePosix(): { kind: ShellKind; path: string } {
  // Byte-for-byte the pre-W885 answer; `$SHELL` is intentionally ignored (see
  // the module header) so no existing Linux deployment changes behaviour.
  return { kind: "posix", path: "/bin/sh" };
}

function resolveWindows(env: Record<string, string | undefined>, lookup: ShellLookup): { kind: ShellKind; path: string } {
  const gitbash = findGitBash(env, lookup);
  if (gitbash !== null) return { kind: "gitbash", path: gitbash };
  const pwsh = findPwsh(env, lookup);
  if (pwsh !== null) return { kind: "pwsh", path: pwsh };
  const cmd = findCmd(env, lookup);
  if (cmd !== null) return { kind: "cmd", path: cmd };
  throw new ShellNotFoundError(
    "no usable shell on this Windows host: looked for bash.exe (Git for Windows: " +
      "%ProgramFiles%\\Git\\bin\\bash.exe, %ProgramFiles(x86)%\\Git\\bin\\bash.exe, " +
      "%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe, PATH), pwsh.exe (PATH, " +
      "%ProgramFiles%\\PowerShell\\7\\pwsh.exe) and cmd.exe (%ComSpec%, PATH, %SystemRoot%\\System32). " +
      "Install Git for Windows / PowerShell 7, or pin one with " + ENV_SHELL_PIN + ".",
  );
}

/** Git for Windows, in the order the user's priority implies. */
function findGitBash(env: Record<string, string | undefined>, lookup: ShellLookup): string | null {
  const onPath = lookup.which("bash.exe");
  if (onPath !== null) return onPath;
  return firstExisting(underRoots(env, GITBASH_ROOTS), lookup.exists);
}

function findPwsh(env: Record<string, string | undefined>, lookup: ShellLookup): string | null {
  const onPath = lookup.which("pwsh.exe");
  if (onPath !== null) return onPath;
  return firstExisting(underRoots(env, PWSH_ROOTS), lookup.exists);
}

/**
 * cmd.exe: `%ComSpec%` first (the OS's own answer), then PATH, then the
 * canonical `%SystemRoot%\\System32` location. Never invented beyond that.
 */
function findCmd(env: Record<string, string | undefined>, lookup: ShellLookup): string | null {
  const comspec = envValue(env, "ComSpec");
  if (comspec !== undefined && lookup.exists(comspec)) return comspec;
  const onPath = lookup.which("cmd.exe");
  if (onPath !== null) return onPath;
  return firstExisting(underRoots(env, CMD_ROOTS), lookup.exists);
}

/**
 * `[install-root env var, path under it]` pairs, in the order Git for Windows
 * actually uses. Program Files first (the machine-wide installer), then the
 * per-user default — the W883 §2.2 note that a Git installed "for me only"
 * lives under `%LOCALAPPDATA%\Programs`.
 */
const GITBASH_ROOTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["ProgramFiles", ["Git", "bin", "bash.exe"]],
  ["ProgramFiles(x86)", ["Git", "bin", "bash.exe"]],
  ["LOCALAPPDATA", ["Programs", "Git", "bin", "bash.exe"]],
];

/** PowerShell 7's documented install root (pwsh is never under Program Files (x86)). */
const PWSH_ROOTS: ReadonlyArray<readonly [string, readonly string[]]> = [["ProgramFiles", ["PowerShell", "7", "pwsh.exe"]]];

/** cmd.exe's canonical location when `%ComSpec%` and PATH are both silent. */
const CMD_ROOTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["SystemRoot", ["System32", "cmd.exe"]],
  ["windir", ["System32", "cmd.exe"]],
];

/** Absolute candidates for `[envVar, segments]` pairs under one install root. */
function underRoots(env: Record<string, string | undefined>, roots: ReadonlyArray<readonly [string, readonly string[]]>): string[] {
  const api = pathApi("win32");
  const out: string[] = [];
  for (const [key, segments] of roots) {
    const root = envValue(env, key);
    if (root !== undefined) out.push(api.join(root, ...segments));
  }
  return out;
}

function firstExisting(candidates: readonly string[], exists: (path: string) => boolean): string | null {
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  return null;
}

/**
 * An explicitly pinned shell (`CELESTEA_SHELL`). The kind is derived from the
 * file name so the argv shape matches; an unrecognised name is a structured
 * error rather than a silent guess.
 */
function pinnedShell(path: string, platform: string, lookup: ShellLookup): { kind: ShellKind; path: string } {
  if (!lookup.exists(path)) throw new ShellNotFoundError(ENV_SHELL_PIN + "='" + path + "' does not exist on this host");
  return { kind: kindOfExecutable(path, platform), path };
}

const PINNED_KINDS: ReadonlyMap<string, ShellKind> = new Map<string, ShellKind>([
  ["bash", "gitbash"],
  ["sh", "posix"],
  ["dash", "posix"],
  ["pwsh", "pwsh"],
  ["powershell", "pwsh"],
  ["cmd", "cmd"],
]);

/** `pwsh.exe` -> `pwsh`; the kind a pinned executable's argv shape follows. */
export function kindOfExecutable(path: string, platform: string = process.platform): ShellKind {
  const base = pathApi(platform).basename(path).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
  const kind = PINNED_KINDS.get(base);
  if (kind === undefined) {
    throw new ShellNotFoundError(ENV_SHELL_PIN + "='" + path + "' is not a recognised shell (expected sh, bash, dash, pwsh, powershell or cmd)");
  }
  // `bash` on a POSIX host is the ordinary POSIX shell; on Windows it is Git Bash.
  return kind === "gitbash" && !isWindows(platform) ? "posix" : kind;
}

/**
 * PATH lookup that honours the injected env and the platform's delimiter —
 * `;` plus `PATHEXT` suffixes on Windows, `:` with no suffixes elsewhere. A
 * value that looks like a path is checked directly (the pre-W885 rule).
 */
export function whichInPath(
  bin: string,
  platform: string = process.platform,
  env: Record<string, string | undefined> = {},
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (looksLikePath(bin, platform)) return exists(bin) ? bin : null;
  const api = pathApi(platform);
  for (const dir of searchPath(platform, env)) {
    if (dir === "") continue;
    for (const name of candidateNames(bin, platform, env)) {
      const candidate = api.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** The PATH entries to search (POSIX keeps the historical /usr/bin:/bin floor). */
function searchPath(platform: string, env: Record<string, string | undefined>): string[] {
  const raw = env["PATH"] ?? (isWindows(platform) ? "" : "/usr/bin:/bin");
  return raw.split(pathDelimiter(platform));
}

/** Exact name first, then the platform suffixes (Windows only). */
function candidateNames(bin: string, platform: string, env: Record<string, string | undefined>): string[] {
  if (pathApi(platform).extname(bin) !== "") return [bin];
  return [bin, ...execSuffixes(platform, env).map((suffix) => bin + suffix)];
}

function looksLikePath(bin: string, platform: string): boolean {
  if (isWindows(platform)) return pathApi(platform).isAbsolute(bin) || bin.includes("\\");
  return bin.includes("/");
}
