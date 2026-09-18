/**
 * `run_code` broker integration tests — the TYPESCRIPT matrix (W774).
 *
 * Same broker, same protocol, other runtime: every case below spawns the real
 * `node` (native type stripping) inside the real userspace sandbox and drives
 * the real line protocol through a real registry.
 */

import type { SessionEvent, Tool, ToolDecision, ToolExecOutcome, ToolInput } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { fnTool } from "../fn-tool.js";
import type { ToolRegistryImpl } from "../registry.js";
import { startBrokerHarness, type BrokerHarness } from "./broker.test-util.js";

// W839 (R3 B8 / W818-P1-1): probe at COLLECTION time so the runtime gate is a
// real describe.skipIf / it.skipIf. The old "if (!h.nodeReady) return"
// reported "no interpreter here" as PASSED; vitest now counts it SKIPPED.
const h: BrokerHarness = await startBrokerHarness();

afterAll(async () => {
  await h.cleanup();
});
const mount = (registry: ToolRegistryImpl, options: Parameters<BrokerHarness["mount"]>[1] = {}): Tool => h.mount(registry, options);
const run = (tool: Tool, callId: string, args: unknown): Promise<ToolExecOutcome> =>
  h.run(tool, callId, args) as Promise<ToolExecOutcome>;
const echoRegistry = (): ToolRegistryImpl => h.echoRegistry();
const leftoverScripts = (): Promise<string[]> => h.leftoverScripts();
describe.skipIf(!h.nodeReady)("run_code TypeScript (W774, default language)", () => {
  it("defaults to TypeScript and round-trips the four bridges", async () => {
    const events: SessionEvent[] = [];
    const tool = mount(echoRegistry(), { events: (event) => events.push(event) });
    const code = `
      const a = tools.read_file({ path: "/tmp/x.txt" });        // documented form
      const b = tools.run_shell({ command: "printf hi" });
      const c = await tools.list_dir({ path: "/tmp" });          // await is free
      const d = await tools.run_shell("printf bye");             // positional shortcut
      return { a, b, c, d, d_is_object: typeof d === "object", e: (d as any).echo, f: b["echo"] };
    `;
    const out = await run(tool, "rc-ts-echo", { code, description: "ts echo four sub-calls" });
    expect(out.value).toEqual({
      a: { echo: "read_file", args: { path: "/tmp/x.txt" } },
      b: { echo: "run_shell", args: { command: "printf hi" } },
      c: { echo: "list_dir", args: { path: "/tmp" } },
      d: { echo: "run_shell", args: { command: "printf bye" } },
      d_is_object: true,
      e: "run_shell",
      f: "run_shell",
    });
    expect(out.render).toBeNull();
    expect(events).toHaveLength(8);
    ["read_file", "run_shell", "list_dir", "run_shell"].forEach((name, index) => {
      expect(events[2 * index]).toMatchObject({ type: "tool_call", id: `rc-ts-echo:c${index + 1}`, name, parent_id: "rc-ts-echo" });
      expect(events[2 * index + 1]).toMatchObject({ type: "tool_result", id: `rc-ts-echo:c${index + 1}`, error: null });
    });
  });

  it("flows a guard denial back as a catchable ToolCallError", async () => {
    const registry = echoRegistry();
    const tool = mount(registry);
    registry.addGuard({
      check: async (input: ToolInput): Promise<ToolDecision> =>
        input.name === "run_code" ? { kind: "allow" } : { kind: "deny", reason: "policy says no" },
    });
    const code = `
      try {
        tools.read_file({ path: "/tmp/x" });
      } catch (error) {
        if (error instanceof ToolCallError) return "caught: " + error.message;
        return "wrong error type";
      }
      return "not caught";
    `;
    const out = await run(tool, "rc-ts-deny", { code });
    expect(out.value).toBe("caught: tool 'read_file' failed: denied: policy says no");
  });

  it("refuses the 21st sub-call without dispatching it", async () => {
    const events: SessionEvent[] = [];
    const tool = mount(echoRegistry(), { events: (event) => events.push(event) });
    const code = `
      try {
        for (let i = 0; i < 30; i += 1) tools.read_file({ path: "/x" });
      } catch (error) {
        return "caught: " + (error as Error).message;
      }
      return "no error";
    `;
    const out = await run(tool, "rc-ts-limit", { code });
    expect(out.value).toContain("sub-call limit exceeded (max 20)");
    expect(events).toHaveLength(40);
    expect(events[39]).toMatchObject({ type: "tool_result", id: "rc-ts-limit:c20" });
  });

  it("kills the program on the wall clock", async () => {
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-ts-timeout", { code: "while (true) {}\n", timeout_ms: 800 })).rejects.toThrow(
      /^run_code: code=timeout .*800ms/,
    );
  });

  it("turns an uncaught exception into {__error__} with a stack and the log tail", async () => {
    const tool = mount(echoRegistry());
    const code = `
      console.log("before boom");
      throw new RangeError("boom");
    `;
    const failure = await run(tool, "rc-ts-exc", { code }).catch((error: unknown) => error as Error);
    if (!(failure instanceof Error)) throw new Error("expected the program exception to reject");
    expect(failure.message).toMatch(/^RangeError: boom\n\[run_code\] logs:\n/);
    expect(failure.message).toContain("before boom");
    expect(failure.message).toContain("run-code/run_code_"); // W880: the stack names the assembled program under run-code/
    expect(failure.message).toContain("at main");
  });

  it("reports a non-serializable return value as a program error", async () => {
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-ts-nonjson", { code: "function main() { return 10n; }\n" })).rejects.toThrow(
      /BigInt/,
    );
  });

  it("reports a main-less program with a clear message", async () => {
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-ts-nomain", { code: "const x = 1;\n" })).rejects.toThrow(/no 'main' defined/);
  });

  it("cleans the temporary .ts program file from the session workdir", async () => {
    const tool = mount(echoRegistry());
    await run(tool, "rc-ts-clean", { code: "function main() { return 1; }\n" });
    expect(await leftoverScripts()).toEqual([]);
    await run(tool, "rc-ts-clean-timeout", { code: "while (true) {}\n", timeout_ms: 600 }).catch(() => undefined);
    expect(await leftoverScripts()).toEqual([]);
  });

  it("rejects an unknown language before spawning anything", async () => {
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-ts-lang", { code: "function main() { return 1; }\n", language: "ruby" })).rejects.toThrow(
      /'language' must be 'typescript' or 'python'/,
    );
  });

  it.skipIf(!h.pythonReady)("still runs Python when language is explicit (regression)", async () => {
    const tool = mount(echoRegistry());
    const out = await run(tool, "rc-py-explicit", {
      code: 'async def main():\n    return tools.read_file(path="/tmp/x")["echo"]\n',
      language: "python",
    });
    expect(out.value).toBe("read_file");
  });
});
