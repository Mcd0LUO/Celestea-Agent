/**
 * `run_code` broker integration tests (W255 P0 matrix).
 *
 * Every case below spawns a **real** `python3` inside the real userspace
 * sandbox and drives the real line protocol; the sub-call registry is a real
 * `ToolRegistryImpl` (schema validation + guard chain + execute), so what is
 * asserted here is the production pipeline, not a mock of it.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sandbox, SessionEvent, Tool, ToolGuard, ToolSpec } from "@celestea/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fnTool } from "../fn-tool.js";
import { PathGuard } from "../guard/path-guard.js";
import { assembleTools } from "../plugin.js";
import { ToolRegistryImpl } from "../registry.js";
import { userspaceSandboxWith } from "../sandbox/userspace.js";
import { readFileTool } from "../tools/read-file.js";
import { RegistryHandle, runCodeTool, runCodeToolWithHandle } from "../tools/run-code.js";
import { MAX_SUB_OUTPUT_BYTES } from "./limits.js";

let dir = "";
let sandbox: Sandbox;
let pythonReady = false;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "celestea-run-code-"));
  sandbox = userspaceSandboxWith({
    workdir: dir,
    root: dir,
    timeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    maxOutputBytes: 64 * 1024,
  });
  const probe = await sandbox.run({ command: "python3 -c 'print(1)'" });
  pythonReady = probe.exit_code === 0 && probe.stdout === "1\n";
  if (!pythonReady) console.warn("[run_code] skip: python3 unavailable in the sandbox right now");
});

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

// ---- test doubles ------------------------------------------------------------

function echoSpec(name: string): ToolSpec {
  return {
    name,
    description: `${name} echo (run_code test double)`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        command: { type: "string" },
        content: { type: "string" },
        workdir: { type: "string" },
        timeout_ms: { type: "integer" },
      },
      additionalProperties: false,
    },
  };
}

/** Echo registry: every whitelisted tool answers `{echo: name, args}`. */
function echoRegistry(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const name of ["read_file", "write_file", "list_dir", "run_shell"]) {
    registry.register(fnTool(echoSpec(name), async (args) => ({ echo: name, args })));
  }
  return registry;
}

/** Shell-shaped registry: `run_shell` answers the run_shell result dict. */
function shellRegistry(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registry.register(fnTool(echoSpec("read_file"), async (args) => ({ echo: "read_file", args })));
  registry.register(
    fnTool(echoSpec("run_shell"), async () => ({
      stdout: "hi\n",
      stderr: "",
      exit_code: 0,
      stdout_truncated: false,
      stderr_truncated: false,
    })),
  );
  return registry;
}

/** Register the tool, then bind the handle to that same registry (production wiring). */
function mount(registry: ToolRegistryImpl, options: { events?: (event: SessionEvent) => void } = {}): Tool {
  const { tool, handle } = runCodeToolWithHandle({
    sandbox,
    ...(options.events === undefined ? {} : { events: options.events }),
  });
  registry.register(tool);
  handle.set(registry);
  return tool;
}

async function run(tool: Tool, callId: string, args: unknown) {
  if (tool.executeWith === undefined) throw new Error("run_code must override executeWith");
  return tool.executeWith({ call_id: callId, name: "run_code", args });
}

const skip = (): boolean => !pythonReady;

/** `run_code_*.py` files the broker left behind in `<workdir>/.celestea`. */
async function leftoverScripts(): Promise<string[]> {
  const entries = await readdir(join(dir, ".celestea")).catch(() => [] as string[]);
  return entries.filter((name) => name.startsWith("run_code_"));
}

// ---- the P0 matrix -----------------------------------------------------------

describe("run_code parent broker", () => {
  it("round-trips four sub-calls (kwargs, positional dict, await) and logs nested events", async () => {
    if (skip()) return;
    const events: SessionEvent[] = [];
    const tool = mount(echoRegistry(), { events: (event) => events.push(event) });
    const code = `
async def main():
    a = tools.read_file(path="/tmp/x.txt")          # kwargs form
    b = tools.run_shell({"command": "printf hi"})   # positional-dict form
    c = tools.list_dir(path="/tmp")
    d = await tools.run_shell(command="printf bye") # await form, dict result
    e = d.echo                                      # attr access on an awaited dict
    f = b.get("echo")                               # .get passthrough on the wrapper
    return {"a": a, "b": b, "c": c, "d": d, "d_is_dict": isinstance(d, dict), "e": e, "f": f}
`;
    const out = await run(tool, "rc-echo", { code, description: "echo four sub-calls" });
    expect(out.value).toEqual({
      a: { echo: "read_file", args: { path: "/tmp/x.txt" } },
      b: { echo: "run_shell", args: { command: "printf hi" } },
      c: { echo: "list_dir", args: { path: "/tmp" } },
      d: { echo: "run_shell", args: { command: "printf bye" } },
      d_is_dict: true,
      e: "run_shell",
      f: "run_shell",
    });
    expect(out.render).toBeNull();

    expect(events).toHaveLength(8);
    const names = ["read_file", "run_shell", "list_dir", "run_shell"];
    names.forEach((name, index) => {
      const call = events[2 * index];
      const result = events[2 * index + 1];
      expect(call).toMatchObject({ type: "tool_call", id: `rc-echo:c${index + 1}`, name, parent_id: "rc-echo" });
      expect(result).toMatchObject({ type: "tool_result", id: `rc-echo:c${index + 1}`, error: null, parent_id: "rc-echo" });
    });
  });

  it("flows a guard denial back as a catchable ToolCallError and still logs the row", async () => {
    if (skip()) return;
    const events: SessionEvent[] = [];
    const registry = echoRegistry();
    const denySubCalls: ToolGuard = {
      check: async (input) => (input.name === "run_code" ? { kind: "allow" } : { kind: "deny", reason: "policy says no" }),
    };
    const tool = mount(registry, { events: (event) => events.push(event) });
    registry.addGuard(denySubCalls);

    const code = `
async def main():
    try:
        tools.read_file(path="/tmp/x")
    except ToolCallError as e:
        return "caught: " + str(e)
    return "not caught"
`;
    const out = await run(tool, "rc-deny", { code });
    expect(out.value).toBe("caught: tool 'read_file' failed: denied: policy says no");
    expect(out.render).toBeNull();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "tool_result", id: "rc-deny:c1", error: "denied: policy says no", parent_id: "rc-deny" });
  });

  it("refuses the 21st sub-call without dispatching or logging it", async () => {
    if (skip()) return;
    const events: SessionEvent[] = [];
    const tool = mount(echoRegistry(), { events: (event) => events.push(event) });
    const code = `
async def main():
    try:
        for _ in range(30):
            tools.read_file(path="/x")
    except ToolCallError as e:
        return "caught: " + str(e)
    return "no error"
`;
    const out = await run(tool, "rc-limit", { code });
    expect(out.value).toContain("caught: ");
    expect(out.value).toContain("sub-call limit exceeded (max 20)");
    expect(events).toHaveLength(40);
    expect(events[0]).toMatchObject({ id: "rc-limit:c1" });
    expect(events[38]).toMatchObject({ type: "tool_call", id: "rc-limit:c20" });
    expect(events[39]).toMatchObject({ type: "tool_result", id: "rc-limit:c20" });
  });

  it("truncates an oversized sub-call result with a warning in the render", async () => {
    if (skip()) return;
    const registry = new ToolRegistryImpl();
    registry.register(fnTool(echoSpec("read_file"), async () => "x".repeat(300_000)));
    const tool = mount(registry);

    const code = `
async def main():
    v = tools.read_file(path="/big")
    return len(v)
`;
    const out = await run(tool, "rc-budget", { code });
    expect(out.value).toBe(MAX_SUB_OUTPUT_BYTES);
    expect(out.render).toContain("sub-call output budget");
    expect(out.render).toContain("dropped");
  });

});

describe("run_code broker limits and failures", () => {
  it("caps program stdout logs at 64KiB without touching the final value", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    const code = `
async def main():
    print("x" * 100000, flush=True)
    return "done"
`;
    const out = await run(tool, "rc-logs", { code });
    expect(out.value).toBe("done");
    expect(out.render?.startsWith("x")).toBe(true);
    expect(out.render).toContain("stdout logs truncated at 65536 bytes");
    expect((out.render ?? "").length).toBeLessThanOrEqual(65_536 + 128);
  });

  it("keeps s.stdout == s['stdout'] before and after await", async () => {
    if (skip()) return;
    const tool = mount(shellRegistry());
    const code = `
async def main():
    s = tools.run_shell(command="echo hi")
    d = await tools.run_shell(command="echo hi")
    return {
        "before": s.stdout == s["stdout"],
        "after": d.stdout == d["stdout"],
        "get": s.get("stdout") == s.stdout,
        "strip": d.stdout.strip(),
        "keys": sorted(s.keys()),
    }
`;
    const out = await run(tool, "rc-attr", { code });
    expect(out.value).toEqual({
      before: true,
      after: true,
      get: true,
      strip: "hi",
      keys: ["exit_code", "stderr", "stdout", "stderr_truncated", "stdout_truncated"].sort(),
    });
  });

  it("kills the program on the wall clock and reports a structured timeout", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-timeout", { code: "while True:\n    pass\n", timeout_ms: 800 })).rejects.toThrow(
      /^run_code: code=timeout .*800ms/,
    );
  });

  it("refuses non-whitelisted tools at the parent (defense in depth)", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    const code = `
import json, sys
async def main():
    out = []
    for i, name in enumerate(["http_request", "run_code"], start=1):
        print(json.dumps({"id": i, "tool": name, "args": {}}), flush=True)
        reply = json.loads(sys.stdin.readline())
        out.append(reply.get("error"))
    try:
        tools.http_request(url="http://x")
        out.append("attr-missing")
    except AttributeError:
        out.append("attr-ok")
    return out
`;
    const out = await run(tool, "rc-wl", { code });
    expect(out.value).toEqual([
      "tool 'http_request' not exposed in run_code SDK",
      "tool 'run_code' not exposed in run_code SDK",
      "attr-ok",
    ]);
  });

  it("turns an uncaught program exception into the error plus a bounded log tail", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    const code = `
async def main():
    print("before boom")
    raise ValueError("boom")
`;
    const failure = await run(tool, "rc-exc", { code }).catch((error: unknown) => error as Error);
    if (!(failure instanceof Error)) throw new Error("expected the program exception to reject");
    expect(failure.message).toMatch(/^ValueError: boom\n\[run_code\] logs:\n/);
    expect(failure.message).toContain("before boom");
    expect(failure.message).toContain("Traceback (most recent call last)");
    expect(failure.message).toContain('raise ValueError("boom")');
  });

  it("cleans the temporary program file from the session workdir (also on timeout)", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    await run(tool, "rc-clean", { code: "async def main():\n    return 1\n" });
    expect(await leftoverScripts()).toEqual([]);
    await run(tool, "rc-clean-timeout", { code: "while True:\n    pass\n", timeout_ms: 600 }).catch(
      () => undefined,
    );
    expect(await leftoverScripts()).toEqual([]);
  });

  it("reports a non-JSON return value as a program error", async () => {
    if (skip()) return;
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-nonjson", { code: "async def main():\n    return object()\n" })).rejects.toThrow(
      /not JSON serializable/,
    );
  });
});

describe("run_code argument + wiring contracts", () => {
  it("rejects missing / empty code and an over-cap timeout_ms as structured errors", async () => {
    const tool = mount(echoRegistry());
    await expect(run(tool, "rc-a1", {})).rejects.toThrow(/missing 'code' \(expected string\)/);
    await expect(run(tool, "rc-a2", { code: "   \n" })).rejects.toThrow(/run_code: code=invalid_arg/);
    await expect(run(tool, "rc-a3", { code: "return 1", timeout_ms: 999_999 })).rejects.toThrow(
      /exceeds the run_code maximum 120000ms/,
    );
  });

  it("fails closed when the registry handle was never bound", async () => {
    const tool = runCodeTool({ sandbox, handle: new RegistryHandle() });
    await expect(run(tool, "rc-unbound", { code: "return 1" })).rejects.toThrow(/code=registry/);
    await expect(tool.execute({ code: "return 1" })).rejects.toThrow(/dispatched without a call id/);
  });

  it("mounts run_code in assembleTools and binds it to the assembly registry", () => {
    const mounted = assembleTools({ sandbox, guard: null });
    expect(mounted.registry.get("run_code")).toBeDefined();
    expect(mounted.runCode).not.toBeNull();
    expect(mounted.registry.schemas().map((spec) => spec.name)).toContain("run_code");
    const off = assembleTools({ sandbox, guard: null, runCode: false });
    expect(off.registry.get("run_code")).toBeUndefined();
    expect(off.runCode).toBeNull();
  });

  it("reads a real file through the real guard inside an assembled pipeline", async () => {
    if (skip()) return;
    const path = join(dir, "notes.txt");
    await writeFile(path, "first line\nsecond line\n", "utf8");
    const registry = assembleTools({ sandbox, guard: null, tools: [readFileTool()], runCode: {} });
    const out = await registry.registry.dispatch({
      call_id: "rc-e2e",
      name: "run_code",
      args: { code: `async def main():\n    text = tools.read_file(path="${path}")\n    return text.splitlines()[0]\n` },
    });
    expect(out.error).toBeNull();
    expect(out.value).toBe("first line");

    const guarded = new ToolRegistryImpl();
    guarded.register(readFileTool());
    guarded.addGuard(PathGuard.fromEnv({ CELESTEA_TOOL_WORKDIR: dir }));
    const tool = mount(guarded);
    const sub = await run(tool, "rc-guard-ok", { code: `async def main():\n    return tools.read_file(path="${path}")\n` });
    expect(sub.value).toBe("first line\nsecond line\n");
  });
});
