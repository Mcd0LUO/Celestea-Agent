// @vitest-environment node
/**
 * W9112 — a PYTHON `run_code` child must speak UTF-8, and a protocol line that
 * does not must fail VISIBLY instead of corrupting data silently.
 *
 * The bug (measured on Windows 11 / Python 3.11): with no env, a Python child
 * inherits the ANSI code page — `sys.stdout.encoding == sys.stdin.encoding ==
 * "gbk"`, `locale.getpreferredencoding(False) == "cp936"`. The `run_code`
 * protocol is UTF-8 on the wire in BOTH directions, so a Chinese payload became
 * U+FFFD while `error === null` (the JSON frame stayed valid), and a character
 * GBK cannot encode (emoji) raised `UnicodeEncodeError`.
 *
 * The fix is the `PYTHONUTF8=1` UTF-8 Mode variable, injected at the CHILD-ENV
 * layer (`sandbox/config.ts` `windowsUtf8Env` → `extraEnv` → `sanitizedEnv`),
 * never by patching the SDK with `sys.stdout.reconfigure()`.
 *
 * These cases run the REAL interpreter inside the REAL userspace sandbox and
 * drive the real line protocol, exactly like `broker.test.ts`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type { Sandbox, Tool, ToolExecOutcome } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { ProcessRegistry } from "../process/registry.js";
import { ToolRegistryImpl } from "../registry.js";
import {
  PYTHON_UTF8_ENV,
  buildSandboxConfig,
  sanitizedEnv,
  windowsUtf8Env,
} from "../sandbox/config.js";
import { userspaceSandboxWith } from "../sandbox/userspace.js";
import { readFileTool } from "../tools/read-file.js";
import { runShellTool } from "../tools/run-shell.js";
import { writeFileTool } from "../tools/write-file.js";
import { resolveInterpreter } from "./broker.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";
import { LineReader, isMalformedUtf8, safeUtf8 } from "./lines.js";

const h: BrokerHarness = await startBrokerHarness();
const sandbox: Sandbox = h.sandbox;
const dir = h.dir;

afterAll(async () => {
  await h.cleanup();
});

/** The Chinese corpus the real report used, plus an emoji GBK cannot encode. */
const CHINESE = "中文题库：第一题";
const EMOJI = "中文题库🎯✅";

/** A registry wired to the REAL read_file / write_file / run_shell tools. */
function realRegistry(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registry.register(writeFileTool());
  registry.register(readFileTool());
  registry.register(runShellTool({ sandbox, processes: new ProcessRegistry() }));
  return registry;
}

const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h.run(tool, callId, args) as Promise<ToolExecOutcome>;

/** One Python program body that writes `content` through the write_file bridge. */
function writeProgram(path: string, content: string): string {
  return [
    "async def main():",
    `    r = tools.write_file(path=${JSON.stringify(path)}, content=${JSON.stringify(content)})`,
    "    return r",
    "",
  ].join("\n");
}

describe.skipIf(!h.pythonReady)("W9112 Python run_code speaks UTF-8 (Windows ANSI code page)", () => {
  it("① write_file round-trips PURE CHINESE byte-for-byte (the silent corruption)", async () => {
    const path = join(dir, "w9112-chinese.txt");
    const tool = h.mount(realRegistry());
    const out = await run(tool, "w9112-cn", {
      code: writeProgram(path, CHINESE),
      language: "python",
    });
    // The bridge answered "ok" — no error at all before the fix, which is exactly
    // what made this the data-destroying path.
    expect(out.value).toBe("ok");
    const bytes = await readFile(path);
    expect(bytes.toString("hex")).toBe(Buffer.from(CHINESE, "utf8").toString("hex"));
    expect(bytes.toString("utf8")).toBe(CHINESE);
    expect(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false); // no U+FFFD
  });

  it("② write_file round-trips EMOJI without UnicodeEncodeError", async () => {
    const path = join(dir, "w9112-emoji.txt");
    const tool = h.mount(realRegistry());
    const out = await run(tool, "w9112-emoji", {
      code: writeProgram(path, EMOJI),
      language: "python",
    });
    expect(out.value).toBe("ok");
    const bytes = await readFile(path);
    expect(bytes.toString("utf8")).toBe(EMOJI);
    expect(bytes.toString("hex")).toBe(Buffer.from(EMOJI, "utf8").toString("hex"));
  });

  it("③ read_file answers Chinese byte-for-byte (the opposite direction, stdin)", async () => {
    const path = join(dir, "w9112-read.txt");
    await writeFile(path, CHINESE, "utf8");
    const tool = h.mount(realRegistry());
    // Two assertions, because they pin different facts:
    //  - `text` is what the broker finally delivers (the value the model sees);
    //  - `child_roundtrip` is what the CHILD itself held after decoding the
    //    reply. The stdin direction has a nasty property — the child decodes the
    //    UTF-8 reply as GBK and then re-encodes its mojibake to GBK on stdout,
    //    and for some strings those two wrongs CANCEL, so the broker-side value
    //    alone is not a reliable negative control. Comparing INSIDE the child
    //    (returning an ASCII boolean) is, and it is what actually goes red when
    //    the UTF-8 env is removed.
    const code = [
      "async def main():",
      `    text = tools.read_file(path=${JSON.stringify(path)})`,
      `    return {"text": text, "child_roundtrip": text == ${JSON.stringify(CHINESE)}}`,
      "",
    ].join("\n");
    const out = await run(tool, "w9112-read", { code, language: "python" });
    const value = out.value as { text: string; child_roundtrip: boolean };
    expect(value.text).toBe(CHINESE);
    expect(value.child_roundtrip, "the CHILD must decode the reply as UTF-8").toBe(true);
    expect(String(value.text)).not.toContain("\uFFFD");
  });

  it("④ run_shell stdout is UTF-8 for a NESTED python child too", async () => {
    const nested = join(dir, "w9112-nested.py");
    await writeFile(nested, "import sys\nsys.stdout.write(" + JSON.stringify(CHINESE) + ")\n", "utf8");
    const python = resolveInterpreter("python").replace(/\\/g, "/");
    const command = `'${python}' '${nested.replace(/\\/g, "/")}'`;
    const tool = h.mount(realRegistry());
    const code = [
      "async def main():",
      `    r = tools.run_shell(command=${JSON.stringify(command)})`,
      '    return {"stdout": r["stdout"], "exit_code": r["exit_code"], "stderr": r["stderr"]}',
      "",
    ].join("\n");
    const out = await run(tool, "w9112-shell", { code, language: "python" });
    const value = out.value as { stdout: string; exit_code: number; stderr: string };
    expect(value.exit_code).toBe(0);
    expect(value.stdout).toBe(CHINESE);
  });

  it("⑤ the child's stdio IS UTF-8 (the outcome that prevents corruption)", async () => {
    const tool = h.mount(realRegistry());
    const code = [
      "async def main():",
      "    import sys, locale",
      '    return {"stdout": sys.stdout.encoding, "stdin": sys.stdin.encoding,',
      '            "stderr": sys.stderr.encoding, "utf8_mode": sys.flags.utf8_mode,',
      '            "preferred": locale.getpreferredencoding(False)}',
      "",
    ].join("\n");
    const out = await run(tool, "w9112-enc", { code, language: "python" });
    const value = out.value as Record<string, unknown>;
    // Compare the CODEC, not its spelling: CPython's normalizer answers "utf-8"
    // while glibc's nl_langinfo answers "UTF-8" on Linux. The bug was about which
    // codec is in force, so the assertion must not depend on the capitalisation.
    // "UTF-8" / "utf_8" / "utf8" are all the SAME codec (codecs.lookup agrees);
    // only the spelling differs by platform. Normalising them cannot mask
    // corruption: every genuinely wrong codec (cp936/gbk/cp1252/ascii/…) keeps a
    // distinct name and still fails below.
    const codec = (v: unknown): string =>
      String(v).toLowerCase().replace(/_/g, "-").replace(/^utf8$/, "utf-8");
    expect(codec(value["stdout"])).toBe("utf-8");
    expect(codec(value["stdin"])).toBe("utf-8");
    expect(codec(value["stderr"])).toBe("utf-8");
    // The decisive difference from PYTHONIOENCODING: the DEFAULT open() encoding
    // is UTF-8 too, so a program writing its own file is not left corrupt.
    expect(codec(value["preferred"])).toBe("utf-8");
    // sys.flags.utf8_mode is the WINDOWS MECHANISM, not a cross-platform
    // invariant — and pinning it here is what turned BOTH ubuntu CI jobs red
    // (node 24 and 26) while windows stayed green:
    //   · win32: WE switch it on by injecting PYTHONUTF8=1 → 1;
    //   · POSIX: the locale is already UTF-8, so the encodings above are utf-8
    //     while utf8_mode is 0 (it is the bare C/POSIX locale that auto-enables
    //     UTF-8 mode, not our env). Asserting 1 there asserts an implementation
    //     detail of the OTHER platform.
    // The POSIX half of "we do not inject the variable" is pinned by the
    // platform-scoped test below, where it belongs.
    if (process.platform === "win32") expect(value["utf8_mode"]).toBe(1);
  });
});

describe.skipIf(!h.pythonReady)("W9112 malformed protocol lines fail visibly (no silent U+FFFD)", () => {
  it("a program that writes raw GBK bytes on stdout is refused with code=protocol", async () => {
    const tool = h.mount(realRegistry());
    const code = [
      "async def main():",
      "    import sys",
      '    sys.stdout.buffer.write(bytes([0xd6, 0xd0, 0xce, 0xc4]) + b"\\n")',
      "    sys.stdout.buffer.flush()",
      '    return "unreachable"',
      "",
    ].join("\n");
    const failure = await run(tool, "w9112-raw", { code, language: "python" }).catch(
      (error: unknown) => error as Error,
    );
    if (!(failure instanceof Error)) throw new Error("expected the malformed line to reject");
    expect(failure.message).toMatch(/^run_code: code=protocol/);
    expect(failure.message).toContain("d6d0cec4");
  });
});

describe("W9112 UTF-8 detection (pure)", () => {
  it("flags invalid UTF-8 and accepts valid text, including a literal U+FFFD", () => {
    expect(isMalformedUtf8(Buffer.from(CHINESE, "utf8"))).toBe(false);
    expect(isMalformedUtf8(Buffer.from("\uFFFD", "utf8"))).toBe(false);
    expect(isMalformedUtf8(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(true); // GBK 中文
    expect(isMalformedUtf8(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(isMalformedUtf8(Buffer.alloc(0))).toBe(false);
  });

  /**
   * W9205 — the tail of a `\n`-terminated line must be COMPLETE.
   *
   * The W9112 shape asserted `isMalformedUtf8(Buffer.from([0xe4, 0xb8])) === false`
   * with the comment "cut tail, not corruption". That was the defect written down
   * as an expectation: the child DID terminate this line, so the bytes really are
   * an incomplete character, and `safeUtf8` then decoded them to "" / U+FFFD
   * while the broker reported success. The tolerance belongs to the byte BUDGET,
   * not to the protocol — see the `tolerateIncompleteTail` case below.
   */
  it("treats an INCOMPLETE trailing sequence as corruption (the whole-buffer default)", () => {
    expect(isMalformedUtf8(Buffer.from([0xe4, 0xb8]))).toBe(true); // truncated 中
    expect(isMalformedUtf8(Buffer.from([0xc3]))).toBe(true); // lone 2-byte lead
    expect(isMalformedUtf8(Buffer.from([0xf0, 0x9f, 0x8e]))).toBe(true); // truncated 4-byte
    // ...and the silent corruption it used to cause is now impossible to miss:
    // the decoder still returns replacement text, which is exactly WHY the
    // detector must reject the bytes rather than let them reach the value.
    expect(safeUtf8(Buffer.from([0xe4, 0xb8]))).toBe("");
  });

  it("forgives an incomplete tail ONLY when the caller cut the line (byte budget)", () => {
    // The same bytes are an artifact when `LineReader` cut them itself...
    expect(isMalformedUtf8(Buffer.from([0xe4, 0xb8]), true)).toBe(false);
    // ...but real corruption inside the complete prefix is still corruption.
    expect(isMalformedUtf8(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), true)).toBe(true);
    expect(isMalformedUtf8(Buffer.from([0xff, 0xfe]), true)).toBe(true);
  });

  it("a LineReader marks a GBK line malformed but leaves a valid one alone", async () => {
    const gbk = new PassThrough();
    const gbkReader = new LineReader(gbk, 1024);
    gbk.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));
    const bad = await gbkReader.next(200);
    expect(bad).toMatchObject({ malformed: true, truncated: false });
    expect((bad as { malformedHex: string }).malformedHex).toBe("d6d0cec4");

    const ok = new PassThrough();
    const okReader = new LineReader(ok, 1024);
    ok.write(Buffer.from(CHINESE + "\n", "utf8"));
    expect(await okReader.next(200)).toMatchObject({ text: CHINESE, malformed: false, malformedHex: "" });
  });

  it("a byte-budget cut inside a multi-byte character is NOT malformed", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream, 4);
    stream.write(Buffer.from("中文题库\n", "utf8"));
    const line = await reader.next(200);
    // 4 bytes = exactly one complete 3-byte character plus one continuation; the
    // cut tail is dropped, never reported as corruption.
    expect(line).toMatchObject({ truncated: true, malformed: false });
  });

  /**
   * W9205 — the end-to-end half of the fix: a line the child TERMINATED with
   * `\n` but whose body ends mid-character is corruption, and the reader must
   * say so instead of handing up replacement text.
   *
   * The byte budget here is generous (1024), so `cut` is false and the reader
   * has no excuse to forgive the tail — this is the case the W9205 report
   * measured as "error stayed null while every Chinese character became U+FFFD".
   */
  it("marks a \n-terminated line with an incomplete trailing character as malformed", async () => {
    const stream = new PassThrough();
    const reader = new LineReader(stream, 1024);
    stream.write(Buffer.from([0xe4, 0xb8, 0x0a])); // truncated 中 + newline
    const line = await reader.next(200);
    expect(line).toMatchObject({ malformed: true, truncated: false });
    expect((line as { malformedHex: string }).malformedHex).toBe("e4b8");
  });
});

describe("W9112 child-env injection is platform-scoped (POSIX invariance)", () => {
  it("windowsUtf8Env answers PYTHONUTF8 only on win32", () => {
    expect(windowsUtf8Env("win32")).toEqual([["PYTHONUTF8", "1"]]);
    expect(windowsUtf8Env("win32")).toEqual([...PYTHON_UTF8_ENV]);
    expect(windowsUtf8Env("linux")).toEqual([]);
    expect(windowsUtf8Env("darwin")).toEqual([]);
  });

  it("⑥ a POSIX config's child env is byte-for-byte the pre-change allowlist", () => {
    const hostEnv = { PATH: "/usr/bin:/bin", HOME: "/home/me", SECRET: "nope", LANG: "C" };
    const posix = buildSandboxConfig({ platform: "linux", workdir: dir, root: dir });
    expect(posix.extraEnv).toEqual([]);
    const child = sanitizedEnv(posix, hostEnv, "linux");
    expect(child["PYTHONUTF8"]).toBeUndefined();
    // The exact historical set: allowlisted names with non-empty values, no more.
    expect(Object.keys(child).sort()).toEqual(["LANG", "PATH"]);
    // ...and the win32 config adds exactly the one variable.
    const win = buildSandboxConfig({ platform: "win32", workdir: dir, root: dir });
    expect(win.extraEnv).toEqual([["PYTHONUTF8", "1"]]);
    expect(sanitizedEnv(win, hostEnv, "win32")["PYTHONUTF8"]).toBe("1");
  });

  it("an operator extraEnv value still wins over the injected default", () => {
    const config = buildSandboxConfig({ platform: "win32", workdir: dir, root: dir, extraEnv: [["PYTHONUTF8", "0"]] });
    expect(sanitizedEnv(config, {}, "win32")["PYTHONUTF8"]).toBe("0");
  });

  it("the harness sandbox carries the platform-appropriate env (host gate)", () => {
    const expected = process.platform === "win32" ? "1" : undefined;
    const config = userspaceSandboxWith({ workdir: dir, root: dir }).config;
    expect(config.extraEnv.find(([name]) => name === "PYTHONUTF8")?.[1]).toBe(expected);
  });
});
