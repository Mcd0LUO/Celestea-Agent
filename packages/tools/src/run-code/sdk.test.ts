import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTools } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { runCodeSpec } from "../tools/run-code.js";
import { assembleProgram, firstNonblankLineIndented, RUN_CODE_RUNNER, RUN_CODE_RUNNER_TS, RUN_CODE_SDK, RUN_CODE_SDK_TS } from "./sdk.js";
import { TS_PROGRAM_RUNTIME } from "./broker.js";

describe("assembleProgram (python)", () => {
  it("wraps an indented body into async def main()", () => {
    const program = assembleProgram('    return tools.read_file(path="/x")', "python");
    expect(program).toContain("async def main():");
    expect(program).toContain('    return tools.read_file(path="/x")');
    expect(program).toContain("__final__");
  });

  it("keeps a complete script that defines main (no double wrap)", () => {
    const program = assembleProgram("async def main():\n    return 1\n", "python");
    expect(program).toContain("async def main():");
    expect(program).not.toContain("async def main():\n\nasync def main()");
    expect(program).toContain("__final__");
  });

  it("indents the whole body one level, keeping blank lines (Rust parity)", () => {
    const program = assembleProgram("    a = 1\n\n    return a", "python");
    expect(program).toContain("async def main():\n        a = 1\n\n        return a\n");
  });

  it("classifies the two forms by the first non-blank line", () => {
    expect(firstNonblankLineIndented("\n\n\tfoo()")).toBe(true);
    expect(firstNonblankLineIndented("\n\nasync def main():\n    return 1")).toBe(false);
    expect(firstNonblankLineIndented("   \n\t")).toBe(false);
  });

  it("layers SDK + user code + runner in that order", () => {
    const program = assembleProgram("    return 1", "python");
    expect(program.startsWith(RUN_CODE_SDK)).toBe(true);
    expect(program.endsWith(RUN_CODE_RUNNER)).toBe(true);
    const marker = program.indexOf("# ========================== user program");
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(program.indexOf("async def main():\n"));
  });
});

describe("RUN_CODE_SDK preamble contract", () => {
  it("keeps the dual-interface + await + attr-dict contract in the preamble", () => {
    expect(RUN_CODE_SDK).toContain("class ToolCallError(Exception)");
    expect(RUN_CODE_SDK).toContain("class _AttrDict(dict)");
    expect(RUN_CODE_SDK).toContain("class _Value:");
    expect(RUN_CODE_SDK).toContain("if False:\n            yield\n        return self._v");
    expect(RUN_CODE_SDK).toContain('_bridge_call("run_shell"');
    expect(RUN_CODE_RUNNER).toContain('"__final__": _plain(_final_value)');
    expect(RUN_CODE_RUNNER).toContain('"__error__"');
  });
});

describe("runCodeSpec vs contracts/tools.json", () => {
  const contract = loadTools().tools.find((tool) => tool.name === "run_code");

  it("matches the frozen engine spec exactly (description + parameters)", () => {
    const spec = runCodeSpec();
    expect(contract).toBeDefined();
    expect(spec.name).toBe("run_code");
    expect(spec.description).toBe(contract?.description);
    expect(spec.parameters).toEqual(contract?.parameters);
  });

  it("documents the SDK surface and the three hard limits", () => {
    const { description } = runCodeSpec();
    for (const needle of ["ToolCallError", "read_file", "write_file", "list_dir", "run_shell"]) {
      expect(description).toContain(needle);
    }
    expect(description).toContain("sub-calls");
    expect(description).toContain("65536");
    expect(description).toContain("120000");
    expect(description).toContain("262144");
  });
});

describe("assembleProgram (typescript, W774)", () => {
  it("wraps an indented body into async function main() without re-indenting it", () => {
    const program = assembleProgram('    return tools.read_file({ path: "/x" });', "typescript");
    expect(program).toContain("async function main() {");
    expect(program).toContain('    return tools.read_file({ path: "/x" });');
    expect(program).toContain("__final__");
  });

  it("keeps a complete script that defines main (no double wrap)", () => {
    const program = assembleProgram("function main(): unknown {\n  return 1;\n}\n", "typescript");
    expect(program).toContain("function main(): unknown {");
    expect(program).not.toContain("async function main() {\nfunction main()");
    expect(program).toContain("__final__");
  });

  it("layers SDK + user code + runner in that order, with the // marker", () => {
    const program = assembleProgram("    return 1;", "typescript");
    expect(program.startsWith(RUN_CODE_SDK_TS)).toBe(true);
    expect(program.endsWith(RUN_CODE_RUNNER_TS)).toBe(true);
    const marker = program.indexOf("// ========================== user program");
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(program.indexOf("async function main() {"));
  });

  it("keeps the Python path byte-for-byte unchanged (same call, other language)", () => {
    const py = assembleProgram("    return 1", "python");
    expect(py.startsWith(RUN_CODE_SDK)).toBe(true);
    expect(py).toContain("# ========================== user program");
    expect(py.endsWith(RUN_CODE_RUNNER)).toBe(true);
    expect(py).not.toContain("__final__: value === undefined");
  });
});

describe("RUN_CODE_SDK_TS protocol contract (W774)", () => {
  it("speaks the SAME frame vocabulary as the Python SDK (language-neutral broker)", () => {
    const both = RUN_CODE_SDK_TS + RUN_CODE_RUNNER_TS;
    for (const frame of ["id: requestId", "tool: tool", "args:", "__final__", "__error__"]) {
      expect(both).toContain(frame);
    }
    // The broker classifies a line by these keys only: no new frame names.
    expect(RUN_CODE_SDK_TS).toContain("JSON.stringify({ id: requestId, tool: tool");
    expect(RUN_CODE_RUNNER_TS).toContain("JSON.stringify({ __final__:");
  });

  it("exposes the four bridges, ToolCallError and synchronous stdlib-only I/O", () => {
    for (const bridge of ["read_file", "write_file", "list_dir", "run_shell"]) {
      expect(RUN_CODE_SDK_TS).toContain(`${bridge}(...args: unknown[])`);
    }
    expect(RUN_CODE_SDK_TS).toContain("class ToolCallError extends Error");
    expect(RUN_CODE_SDK_TS).toContain("_readSync(0, chunk");
    expect(RUN_CODE_SDK_TS).toContain("StringDecoder");
    expect(RUN_CODE_SDK_TS).toContain('import { readSync as _readSync } from "node:fs"');
    // No third-party import can ever sneak in: every import is a node: builtin.
    for (const line of RUN_CODE_SDK_TS.split("\n").filter((l) => l.startsWith("import "))) {
      expect(line).toContain('from "node:');
    }
  });

  it("throws at EOF instead of hanging (the bridge contract)", () => {
    expect(RUN_CODE_SDK_TS).toContain("the parent broker closed the reply channel (run aborted)");
    expect(RUN_CODE_SDK_TS).toContain("if (line === null) {");
  });

  it("reports undefined as null and echoes main() being awaited", () => {
    expect(RUN_CODE_RUNNER_TS).toContain("value === undefined ? null : value");
    expect(RUN_CODE_RUNNER_TS).toContain("return await (entry as () => unknown)()");
    expect(RUN_CODE_RUNNER_TS).toContain("process.exitCode = 1");
  });
});

describe("RUN_CODE_SDK_TS over a REAL pipe (W774)", () => {
  it("answers the first bridge call, then THROWS at EOF instead of hanging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "celestea-sdk-ts-"));
    const file = join(dir, "program.ts");
    const body = `
      const first = tools.read_file({ path: "/x" });
      let caught = "";
      try {
        tools.read_file({ path: "/y" });
      } catch (error) {
        caught = (error as Error).message;
      }
      return { first, caught };
    `;
    writeFileSync(file, assembleProgram(body, "typescript"), "utf8");

    const child = spawn(TS_PROGRAM_RUNTIME, [file], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let pending = "";
    let answered = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl < 0) break;
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lines.push(line);
        // Act as the broker: answer the FIRST request, then close the channel
        // (that is exactly what happens when pumpLines returns).
        if (answered === 0) {
          const request = JSON.parse(line) as { id: number; tool: string; args: unknown };
          answered += 1;
          expect(request).toMatchObject({ tool: "read_file", args: { path: "/x" } });
          child.stdin.write(`${JSON.stringify({ id: request.id, ok: true, value: { n: 1 } })}\n`);
          child.stdin.end();
        }
      }
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("the SDK hung on EOF instead of throwing"));
      }, 15_000);
      child.on("exit", (exit) => {
        clearTimeout(killer);
        resolve(exit);
      });
    });
    rmSync(dir, { recursive: true, force: true });

    expect(answered).toBe(1);
    expect(code).toBe(0);
    const final = lines.find((line) => line.includes("__final__"));
    expect(final).toBeDefined();
    expect(JSON.parse(String(final))["__final__"]).toEqual({
      first: { n: 1 },
      caught: "tool 'read_file' failed: the parent broker closed the reply channel (run aborted)",
    });
  }, 20_000);
});
