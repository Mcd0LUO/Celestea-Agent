/**
 * W885 — the shell ladder, the per-shell argv and the quoting rules.
 *
 * Everything here is INJECTED (`platform` / `env` / `which` / `exists`), so the
 * Windows branches run on a Linux host. No test in this file needs Windows.
 *
 * The POSIX half is a REGRESSION test in the strict sense: it asserts the exact
 * bytes the pre-W885 code produced (`/bin/sh`, `["-c", command]`), which is
 * the "Linux behaviour changes by zero bytes" requirement of this slice.
 */

import { describe, expect, it } from "vitest";

import { resolveShell, resolveShellKind, ShellNotFoundError, type ShellResolveInput } from "../platform/exec.js";
import { quoteCmd, quoteForShell, quoteWord, runCodeCommand, shellQuote } from "../platform/quote.js";

/** One backslash, one double quote: built so no literal is ambiguous here. */
const BS = "\\";
const DQ = '"';
const PATH_DIR = `C:${BS}tools`;

const GITBASH = `C:${BS}Program Files${BS}Git${BS}bin${BS}bash.exe`;
const LOCAL_GITBASH = `C:${BS}Users${BS}me${BS}AppData${BS}Local${BS}Programs${BS}Git${BS}bin${BS}bash.exe`;
const PWSH = `C:${BS}Program Files${BS}PowerShell${BS}7${BS}pwsh.exe`;
const CMD32 = `C:${BS}Windows${BS}System32${BS}cmd.exe`;
const PATH_BASH = `${PATH_DIR}${BS}bash.exe`;
const PATH_PWSH = `${PATH_DIR}${BS}pwsh.exe`;
const PATH_CMD = `${PATH_DIR}${BS}cmd.exe`;
const WINDOWS_ROOT = `C:${BS}Windows`;
const PROGRAM_FILES = `C:${BS}Program Files`;

/** A fake win32 host: `which` answers from `onPath`, `exists` from `installed`. */
function winHost(onPath: readonly string[], env: Record<string, string | undefined> = {}, installed: readonly string[] = []): ShellResolveInput {
  return {
    platform: "win32",
    env,
    which: (bin) => (onPath.includes(bin) ? `${PATH_DIR}${BS}${bin}` : null),
    exists: (path) => installed.includes(path),
  };
}

describe("W885 resolveShell · POSIX (byte-identical regression)", () => {
  it("answers /bin/sh -c <command> verbatim — the pre-W885 shape", () => {
    expect(resolveShell("echo hi", { platform: "linux" })).toEqual({ kind: "posix", path: "/bin/sh", argv: ["-c", "echo hi"] });
    expect(resolveShell('echo "a b"', { platform: "darwin" })).toEqual({ kind: "posix", path: "/bin/sh", argv: ["-c", 'echo "a b"'] });
    expect(resolveShell("printf '%s' 你好", { platform: "linux" }).argv).toEqual(["-c", "printf '%s' 你好"]);
    expect(resolveShell("ls /tmp | wc -l", { platform: "linux" }).argv).toEqual(["-c", "ls /tmp | wc -l"]);
  });

  it("ignores $SHELL — an exported SHELL must not change what runs", () => {
    expect(resolveShell("id", { platform: "linux", env: { SHELL: "/usr/bin/zsh" } }).path).toBe("/bin/sh");
  });

  it("treats a pinned bash on a POSIX host as the ordinary POSIX shell", () => {
    expect(resolveShellKind({ platform: "linux", env: { CELESTEA_SHELL: "/bin/bash" }, exists: () => true }).kind).toBe("posix");
  });
});

describe("W885 resolveShell · Windows ladder gitbash > pwsh > cmd", () => {
  it("picks gitbash when ALL THREE are installed (the user's priority)", () => {
    const input = winHost(["bash.exe", "pwsh.exe", "cmd.exe"], { ComSpec: PATH_CMD, SystemRoot: WINDOWS_ROOT });
    expect(resolveShell("dir", input)).toEqual({ kind: "gitbash", path: PATH_BASH, argv: ["-c", "dir"] });
  });

  it("picks gitbash from %ProgramFiles%\\Git\\bin with no PATH entry at all", () => {
    const input = winHost([], { ProgramFiles: PROGRAM_FILES }, [GITBASH]);
    expect(resolveShell("ls", input)).toEqual({ kind: "gitbash", path: GITBASH, argv: ["-c", "ls"] });
  });

  it("accepts the %LOCALAPPDATA% Git install (the per-user default)", () => {
    const localAppData = `C:${BS}Users${BS}me${BS}AppData${BS}Local`;
    const input = winHost([], { LOCALAPPDATA: localAppData }, [LOCAL_GITBASH]);
    expect(resolveShell("ls", input).path).toBe(LOCAL_GITBASH);
  });

  it("picks pwsh when gitbash is absent (PATH, then %ProgramFiles%\\PowerShell\\7)", () => {
    expect(resolveShell("gci", winHost(["pwsh.exe"], { ProgramFiles: PROGRAM_FILES }))).toEqual({
      kind: "pwsh",
      path: PATH_PWSH,
      argv: ["-NoProfile", "-NonInteractive", "-Command", "gci"],
    });
    const installed = winHost([], { ProgramFiles: PROGRAM_FILES }, [PWSH]);
    expect(resolveShell("gci", installed).path).toBe(PWSH);
  });

  it("picks cmd (%ComSpec%) when it is the only shell", () => {
    const input = winHost([], { ComSpec: CMD32 }, [CMD32]);
    expect(resolveShell("dir", input)).toEqual({ kind: "cmd", path: CMD32, argv: ["/d", "/s", "/c", "dir"] });
  });

  it("finds cmd.exe in %SystemRoot%\\System32 when PATH and %ComSpec% are silent", () => {
    const input = winHost([], { SystemRoot: WINDOWS_ROOT }, [CMD32]);
    expect(resolveShell("dir", input)).toEqual({ kind: "cmd", path: CMD32, argv: ["/d", "/s", "/c", "dir"] });
  });

  it("fails closed with a structured error when NO shell exists (never guesses)", () => {
    expect(() => resolveShell("dir", winHost([]))).toThrowError(ShellNotFoundError);
    try {
      resolveShell("dir", winHost([]));
      expect.unreachable("resolveShell must not resolve a shell that does not exist");
    } catch (error) {
      const shellError = error as ShellNotFoundError;
      expect(shellError.code).toBe("shell_not_found");
      expect(shellError.name).toBe("ShellNotFoundError");
      expect(shellError.message).toContain("no usable shell");
      expect(shellError.message).toContain("bash.exe");
      expect(shellError.message).toContain("pwsh.exe");
      expect(shellError.message).toContain("cmd.exe");
    }
  });
});

describe("W885 resolveShell · the CELESTEA_SHELL pin", () => {
  it("honours an explicit pin and derives the argv shape from the file name", () => {
    const pin = `C:${BS}bin${BS}pwsh.exe`;
    const pinned = resolveShell("Get-Date", { platform: "win32", env: { CELESTEA_SHELL: pin }, exists: () => true });
    expect(pinned).toEqual({ kind: "pwsh", path: pin, argv: ["-NoProfile", "-NonInteractive", "-Command", "Get-Date"] });
  });

  it("fails closed on a pin that does not exist", () => {
    const input = { platform: "win32", env: { CELESTEA_SHELL: `C:${BS}nope${BS}bash.exe` }, exists: () => false };
    expect(() => resolveShell("x", input)).toThrowError(/does not exist on this host/);
  });

  it("fails closed on a pin that is not a known shell", () => {
    const input = { platform: "win32", env: { CELESTEA_SHELL: `C:${BS}bin${BS}nushell.exe` }, exists: () => true };
    expect(() => resolveShell("x", input)).toThrowError(/not a recognised shell/);
  });
});

describe("W885 quoting · one command, three dialects", () => {
  const spaced = `C:${BS}Program Files${BS}nodejs${BS}node.exe`;
  const chinese = `C:${BS}用户${BS}我的 项目${BS}脚本.ts`;
  const embedded = `say ${DQ}hi${DQ}`;

  it("posix passes the command through untouched (the pre-W885 bytes)", () => {
    expect(quoteForShell("posix", spaced)).toBe(spaced);
    expect(quoteForShell("gitbash", spaced)).toBe(spaced);
    expect(quoteForShell("posix", embedded)).toBe(embedded);
  });

  it("pwsh wraps in single quotes and doubles an embedded one", () => {
    expect(quoteForShell("pwsh", spaced)).toBe(`'${spaced}'`);
    expect(quoteForShell("pwsh", "it's")).toBe("'it''s'");
    expect(quoteForShell("pwsh", chinese)).toBe(`'${chinese}'`);
  });

  it("cmd wraps in double quotes and escapes an embedded one", () => {
    expect(quoteForShell("cmd", spaced)).toBe(`${DQ}${spaced}${DQ}`);
    expect(quoteForShell("cmd", embedded)).toBe(`${DQ}say ${BS}${DQ}hi${BS}${DQ}${DQ}`);
    expect(quoteForShell("cmd", chinese)).toBe(`${DQ}${chinese}${DQ}`);
  });

  it("doubles a trailing backslash run so the closing quote still closes", () => {
    const dirEnding = `C:${BS}dir${BS}`;
    const wsEnding = `C:${BS}ws${BS}`;
    expect(quoteForShell("cmd", dirEnding)).toBe(`${DQ}${dirEnding}${BS}${DQ}`);
    expect(quoteCmd(wsEnding)).toBe(`${DQ}${wsEnding}${BS}${DQ}`);
    expect(quoteForShell("cmd", `a${DQ}b`)).toBe(`${DQ}a${BS}${DQ}b${DQ}`);
  });

  it("keeps the historical POSIX single-quote word rule for a word", () => {
    expect(shellQuote("/tmp/a b/c.ts")).toBe("'/tmp/a b/c.ts'");
    // POSIX: close the quotes, escape one quote, reopen -> 'it'\''s'
    expect(shellQuote("it's")).toBe(`'it'${BS}''s'`);
    expect(quoteWord("posix", "/tmp/a b.ts")).toBe("'/tmp/a b.ts'");
    expect(quoteWord("gitbash", "/tmp/a b.ts")).toBe("'/tmp/a b.ts'");
    expect(quoteWord("cmd", spaced)).toBe(`${DQ}${spaced}${DQ}`);
  });
});

describe("W885 runCodeCommand · the interpreter line per shell", () => {
  const scriptTs = `C:${BS}celestea${BS}run-code${BS}a.ts`;

  it("posix: byte-identical to the pre-W885 interpolation", () => {
    expect(runCodeCommand("posix", "python", "python3", "/tmp/p/run_code_1_0.py")).toBe("python3 -uB '/tmp/p/run_code_1_0.py'");
    expect(runCodeCommand("posix", "typescript", "/usr/bin/node", "/tmp/p/run_code_1_0.ts")).toBe("/usr/bin/node '/tmp/p/run_code_1_0.ts'");
  });

  it("pwsh: single-quoted interpreter and script path", () => {
    const spaced = `C:${BS}Program Files${BS}nodejs${BS}node.exe`;
    expect(runCodeCommand("pwsh", "typescript", spaced, scriptTs)).toBe(`'${spaced}' '${scriptTs}'`);
  });

  it("cmd: double-quoted interpreter and script path", () => {
    const spaced = `C:${BS}Program Files${BS}nodejs${BS}node.exe`;
    expect(runCodeCommand("cmd", "typescript", spaced, scriptTs)).toBe(`${DQ}${spaced}${DQ} ${DQ}${scriptTs}${DQ}`);
    const python = `C:${BS}Python314${BS}python.exe`;
    const scriptPy = `C:${BS}celestea${BS}run-code${BS}a.py`;
    expect(runCodeCommand("cmd", "python", python, scriptPy)).toBe(`${DQ}${python}${DQ} -uB ${DQ}${scriptPy}${DQ}`);
  });
});
