import { existsSync, readFileSync } from "node:fs";

import { loadTools } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { runCodeSpec } from "../tools/run-code.js";
import { assembleProgram, firstNonblankLineIndented, RUN_CODE_RUNNER, RUN_CODE_SDK } from "./sdk.js";

/** The Rust reference implementation (parity evidence; absent on a TS-only host). */
const RUST_SOURCE = "/src/celestea_harness/crates/tools/src/run_code.rs";

/** Extract one Rust raw-string constant (`const NAME: &str = r##"…"##;`). */
function rustBlock(source: string, name: string): string | null {
  const match = new RegExp(`(?:pub )?const ${name}: &str = r##"([\\s\\S]*?)"##;`).exec(source);
  return match?.[1] ?? null;
}

describe("assembleProgram", () => {
  it("wraps an indented body into async def main()", () => {
    const program = assembleProgram('    return tools.read_file(path="/x")');
    expect(program).toContain("async def main():");
    expect(program).toContain('    return tools.read_file(path="/x")');
    expect(program).toContain("__final__");
  });

  it("keeps a complete script that defines main (no double wrap)", () => {
    const program = assembleProgram("async def main():\n    return 1\n");
    expect(program).toContain("async def main():");
    expect(program).not.toContain("async def main():\n\nasync def main()");
    expect(program).toContain("__final__");
  });

  it("indents the whole body one level, keeping blank lines (Rust parity)", () => {
    const program = assembleProgram("    a = 1\n\n    return a");
    expect(program).toContain("async def main():\n        a = 1\n\n        return a\n");
  });

  it("classifies the two forms by the first non-blank line", () => {
    expect(firstNonblankLineIndented("\n\n\tfoo()")).toBe(true);
    expect(firstNonblankLineIndented("\n\nasync def main():\n    return 1")).toBe(false);
    expect(firstNonblankLineIndented("   \n\t")).toBe(false);
  });

  it("layers SDK + user code + runner in that order", () => {
    const program = assembleProgram("    return 1");
    expect(program.startsWith(RUN_CODE_SDK)).toBe(true);
    expect(program.endsWith(RUN_CODE_RUNNER)).toBe(true);
    const marker = program.indexOf("# ========================== user program");
    expect(marker).toBeGreaterThan(0);
    expect(marker).toBeLessThan(program.indexOf("async def main():\n"));
  });
});

describe("Rust SDK parity", () => {
  const source = existsSync(RUST_SOURCE) ? readFileSync(RUST_SOURCE, "utf8") : null;
  const skip = source === null;

  it.skipIf(skip)("re-encodes RUN_CODE_SDK byte for byte", () => {
    expect(RUN_CODE_SDK).toBe(rustBlock(source as string, "RUN_CODE_SDK"));
  });

  it.skipIf(skip)("re-encodes RUN_CODE_RUNNER byte for byte", () => {
    expect(RUN_CODE_RUNNER).toBe(rustBlock(source as string, "RUN_CODE_RUNNER"));
  });

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
