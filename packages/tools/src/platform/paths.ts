/**
 * W885 (Windows slice 1) — the injectable platform seam.
 *
 * `celestea-home.ts` (W880) set the pattern: a platform decision takes its
 * inputs as ARGUMENTS (`platform` / `env` / `homedir`) and stays a pure
 * function, so the win32 branch is unit-testable on a Linux host and the global
 * `process` is read only where a default is unavoidable. This module is that
 * seam for everything the sandbox/guard/broker layers need.
 *
 * It lives in `@celestea/tools` (not core): `probe.ts`, `path-guard.ts`,
 * `config.ts`, `child.ts` and `broker.ts` — the consumers — are all in this
 * package, the dependency direction stays L1 → L0, and core keeps its leaf
 * promise (W883 §6.2 P0-2 listed both locations as acceptable).
 */

import { posix, win32 } from "node:path";

/** Everything a platform decision may depend on (injectable; never global). */
export interface PlatformInput {
  /** Defaults to `process.platform` at the call site only. */
  platform?: NodeJS.Platform | string;
  /** Defaults to `process.env` at the call site only. */
  env?: Record<string, string | undefined>;
  /** Defaults to `os.homedir()` at the call site only. */
  homedir?: string;
}

/** true for the Windows platform id (the only place the literal lives). */
export function isWindows(platform: string = process.platform): boolean {
  return platform === "win32";
}

/**
 * The path implementation of a platform (same rule as `celestea-home.ts`):
 * deterministic across hosts, so a win32 test never touches the host's path
 * semantics.
 */
export function pathApi(platform: string = process.platform): typeof posix {
  return isWindows(platform) ? (win32 as typeof posix) : posix;
}

/** `PATH` list separator: `;` on Windows, `:` everywhere else. */
export function pathDelimiter(platform: string = process.platform): string {
  return isWindows(platform) ? ";" : ":";
}

/**
 * Executable suffixes tried when resolving a bare name on Windows. The real
 * rule is `PATHEXT` (plus an exact-name match first, which command lookup also
 * allows); the two ARE checked independently and must not be collapsed.
 */
export const WINDOWS_EXEC_SUFFIXES: readonly string[] = [".exe", ".cmd", ".bat", ".com"];

/**
 * The suffixes to try for `bin` on `platform`, from the injected env.
 *
 * `PATHEXT` is honoured when present (the operator's real resolution order) and
 * the defaults are used otherwise. The order inside the list is significant:
 * `.exe` before `.cmd` is what makes `bash.exe` win over a `bash.cmd`
 * shim, which matters for the gitbash > pwsh > cmd priority.
 */
export function execSuffixes(platform: string = process.platform, env: Record<string, string | undefined> = {}): readonly string[] {
  if (!isWindows(platform)) return [];
  const raw = env["PATHEXT"];
  const parsed = (raw ?? "").split(";").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  return parsed.length > 0 ? parsed : WINDOWS_EXEC_SUFFIXES;
}

/** A non-blank, trimmed env value; `undefined` when unset or blank. */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}
