/**
 * Command assembly + quoting per shell (W885) — the arg the CHILD sees must be
 * one string, whatever the shell.
 *
 * Three dialects, three rules, and they are not interchangeable:
 *
 * | shell   | argv shape                                              | quote rule |
 * |---------|---------------------------------------------------------|------------|
 * | posix   | `sh -c <command>`                                       | none — the command IS the argument (byte-identical to pre-W885) |
 * | gitbash | `bash -c <command>`                                     | POSIX single quotes (same as posix) |
 * | pwsh    | `pwsh -NoProfile -NonInteractive -Command <command>`     | single quotes; an embedded `'` doubles |
 * | cmd     | `cmd /d /s /c <command>`                                | double quotes; an embedded `"` is backslash-escaped, and a trailing backslash run doubles |
 *
 * The POSIX branch is deliberately a **pass-through**: W885's hard requirement
 * is that Linux behaviour does not change by a single byte, so no quoting is
 * introduced where there was none.
 *
 * Honest limitation (this host is Linux): cmd.exe's parser is not a regular
 * language and has no fully general escaping rule. [quoteCmd] implements the
 * documented "wrap in double quotes, escape an embedded quote, double a
 * trailing backslash" convention, which is correct for the lines this repo
 * builds (`<interpreter> <script path>`) and is unit-tested for the
 * meta-characters below — it is NOT a proof of cmd-safety for arbitrary user
 * commands. The same caveat applies to PowerShell's single-quote rule, which is
 * well-defined but only exercised here against strings, not against a real pwsh.
 */

import { isWindows } from "./paths.js";
import type { ShellKind } from "./exec.js";

/** POSIX: a literal single quote inside single quotes. */
const POSIX_QUOTE = String.raw`'\''`;
/** cmd.exe: a literal double quote inside a double-quoted argument. */
const CMD_QUOTE = String.raw`\"`;

/** Quote `value` for the given shell's parser (POSIX + gitbash: verbatim). */
export function quoteForShell(kind: ShellKind, value: string): string {
  if (kind === "cmd") return quoteCmd(value);
  if (kind === "pwsh") return `'${value.replace(/'/g, "''")}'`;
  return value;
}

/** Characters a POSIX shell passes through unchanged (no quoting needed). */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One shell WORD — an interpreter, a flag, a path — quoted for `kind`, and
 * quoted ONLY when the dialect needs it.
 *
 * The POSIX "only when needed" rule is what keeps the `run_code` line
 * byte-identical to pre-W885: `python3` and `/usr/bin/node` go through
 * verbatim exactly as they used to, while a word that WOULD be mangled (a space,
 * a quote, a glob) now gets the historical single-quote treatment instead of
 * being pasted in raw. pwsh and cmd quote unconditionally — their parsers have
 * no safe set to rely on.
 */
export function quoteWord(kind: ShellKind, word: string): string {
  if (kind === "cmd" || kind === "pwsh") return quoteForShell(kind, word);
  return SAFE_WORD.test(word) ? word : shellQuote(word);
}

/**
 * A path that is ALWAYS quoted for `kind`. The `run_code` script path has been
 * single-quoted on POSIX since before W885 (`broker.ts` `shellQuote`), so this
 * keeps those bytes exactly and gives cmd/pwsh their own dialect.
 */
export function quotePath(kind: ShellKind, path: string): string {
  if (kind === "cmd" || kind === "pwsh") return quoteForShell(kind, path);
  return shellQuote(path);
}

/**
 * POSIX single-quote a word so an absolute path with spaces stays one word
 * (pre-W885 `broker.ts` behaviour, preserved verbatim).
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, POSIX_QUOTE)}'`;
}

/**
 * cmd.exe double-quoting: wrap in `"…"`, escape an embedded quote, and double
 * a trailing run of backslashes (command-line quoting consumes them before the
 * closing quote).
 */
export function quoteCmd(value: string): string {
  const escaped = value.replace(/"/g, CMD_QUOTE);
  const trailing = /\\+$/.exec(escaped);
  const padded = trailing === null ? escaped : escaped + trailing[0];
  return `"${padded}"`;
}

/** Interpreters a `run_code` program can be executed with. */
export type RunCodeLanguageName = "typescript" | "python";

/** Python interpreters tried on POSIX, in order (`python3` keeps its priority). */
export const PYTHON_CANDIDATES_POSIX: readonly string[] = ["python3", "python"];
/** Python interpreters Windows actually ships (the `py` launcher included). */
export const PYTHON_CANDIDATES_WINDOWS: readonly string[] = ["python.exe", "python3.exe", "py.exe"];

/** The interpreter names to try, most preferred first, for `platform`. */
export function pythonCandidates(platform: string = process.platform): readonly string[] {
  return isWindows(platform) ? PYTHON_CANDIDATES_WINDOWS : PYTHON_CANDIDATES_POSIX;
}

/**
 * The full command line one `run_code` program is executed with, quoted for
 * `kind`. `interpreter` is an already-resolved absolute path or bare name
 * (see `resolveInterpreter` in `run-code/broker.ts`).
 */
export function runCodeCommand(kind: ShellKind, language: RunCodeLanguageName, interpreter: string, scriptPath: string): string {
  const flags = language === "python" ? " -uB" : "";
  return `${quoteWord(kind, interpreter)}${flags} ${quotePath(kind, scriptPath)}`;
}
