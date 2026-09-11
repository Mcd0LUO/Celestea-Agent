import type { Tool, ToolDecision, ToolGuard, ToolInput, ToolSpec } from "@celestea/core";
import { describe, expect, it } from "vitest";

import { fnTool } from "./fn-tool.js";
import { createToolRegistry, humanRender, ToolRegistryImpl } from "./registry.js";

function toolSpec(name: string, required: string[] = []): ToolSpec {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: { path: { type: "string" } }, required, additionalProperties: false },
  };
}

function tool(name: string, execute: (args: unknown) => Promise<unknown>, required: string[] = []): Tool {
  return fnTool(toolSpec(name, required), execute);
}

function guard(decision: ToolDecision, seen?: string[]): ToolGuard {
  return {
    check: async (input: ToolInput): Promise<ToolDecision> => {
      seen?.push(input.name);
      return decision;
    },
  };
}

const input = (name: string, args: unknown): ToolInput => ({ call_id: "c1", name, args });

describe("ToolRegistryImpl.dispatch", () => {
  it("runs the tool and returns the structured result", async () => {
    const registry = createToolRegistry([tool("echo", async (args) => args)]);
    const out = await registry.dispatch(input("echo", { path: "a" }));
    expect(out).toEqual({
      call_id: "c1",
      value: { path: "a" },
      render: null,
      error: null,
      decision: { kind: "allow" },
    });
  });

  it("reports an unknown tool without running a guard", async () => {
    const seen: string[] = [];
    const registry = createToolRegistry([], [guard({ kind: "allow" }, seen)]);
    const out = await registry.dispatch(input("nope", {}));
    expect(out.error).toBe("unknown tool: nope");
    // W738: a call the seam REFUSED is a deny — never an `allow` (which would
    // tell the caller and the audit log that a rejected call passed).
    expect(out.decision).toEqual({ kind: "deny", reason: "unknown tool: nope" });
    expect(seen).toEqual([]);
  });

  it("validates args against the spec before the guard chain runs", async () => {
    const seen: string[] = [];
    let executed = false;
    const registry = createToolRegistry(
      [tool("read_file", async () => (executed = true), ["path"])],
      [guard({ kind: "deny", reason: "toolguard: code=path_forbidden msg=\"x\"" }, seen)],
    );
    const out = await registry.dispatch(input("read_file", {}));
    expect(out.error).toBe("toolargs: code=schema msg=\"missing required property 'path'\"");
    expect(out.value).toBeNull();
    expect(seen).toEqual([]);
    expect(executed).toBe(false);
    // W738: a schema-rejected call is a deny with the very error as its reason.
    expect(out.decision).toEqual({ kind: "deny", reason: out.error });
  });

  it("short-circuits on a deny before executing, keeping the contract shape", async () => {
    let executed = false;
    const deny: ToolDecision = { kind: "deny", reason: "toolguard: code=path_forbidden msg=\"outside\"" };
    const registry = createToolRegistry([tool("write_file", async () => (executed = true))], [guard(deny)]);
    const out = await registry.dispatch(input("write_file", {}));
    expect(out.error).toBe("denied: toolguard: code=path_forbidden msg=\"outside\"");
    expect(out.decision).toEqual(deny);
    expect(out.render).toBeNull();
    expect(executed).toBe(false);
  });

  it("keeps the FIRST non-allow decision (a later allow never un-denies)", async () => {
    const registry = createToolRegistry(
      [tool("read_file", async () => "ok")],
      [guard({ kind: "allow" }), guard({ kind: "ask", reason: "needs approval" }), guard({ kind: "allow" })],
    );
    const out = await registry.dispatch(input("read_file", {}));
    expect(out.error).toBe("ask: needs approval");
    expect(out.decision).toEqual({ kind: "ask", reason: "needs approval" });
  });

  it("captures a throwing guard as a structured deny", async () => {
    const boom: ToolGuard = {
      check: async () => {
        throw new Error("guard exploded");
      },
    };
    const registry = createToolRegistry([tool("read_file", async () => "ok")], [boom]);
    const out = await registry.dispatch(input("read_file", {}));
    expect(out.error).toBe('denied: toolguard: code=guard_error msg="guard exploded"');
  });

  it("denies (never allows) a call rejected by the schema, and keeps the tool unrun", async () => {
    let executed = false;
    const registry = createToolRegistry([tool("write_file", async () => (executed = true), ["path"])]);
    const out = await registry.dispatch({ call_id: "c9", name: "write_file", args: { path: 42 } });
    expect(out.decision).toMatchObject({ kind: "deny" });
    if (out.decision?.kind === "deny") expect(out.decision.reason).toContain("toolargs: code=schema");
    expect(out.error?.startsWith("toolargs: code=schema")).toBe(true);
    expect(out.value).toBeNull();
    expect(executed).toBe(false);
  });

  it("denies (never allows) a call to a tool that is not registered", async () => {
    const registry = createToolRegistry([tool("read_file", async () => "ok")]);
    const out = await registry.dispatch({ call_id: "c10", name: "write_file", args: { path: "a" } });
    expect(out.decision).toEqual({ kind: "deny", reason: "unknown tool: write_file" });
  });

  it("captures a tool failure instead of throwing across the seam", async () => {
    const registry = createToolRegistry([
      tool("read_file", async () => {
        throw new Error("read_file: code=io msg=\"ENOENT\"");
      }),
    ]);
    const out = await registry.dispatch(input("read_file", {}));
    expect(out.error).toBe('read_file: code=io msg="ENOENT"');
    expect(out.decision).toEqual({ kind: "allow" });
    expect(out.value).toBeNull();
  });

  it("prefers a tool-authored render over the generic one", async () => {
    const authored: Tool = {
      spec: () => toolSpec("run_shell"),
      execute: async () => ({ stdout: "hi", exit_code: 0 }),
      executeWith: async () => ({ value: { stdout: "hi", exit_code: 0 }, render: "custom view" }),
    };
    const registry = createToolRegistry([authored]);
    const out = await registry.dispatch(input("run_shell", {}));
    expect(out.render).toBe("custom view");
  });

  it("falls back to the generic rendering of a stream-shaped value", async () => {
    const registry = createToolRegistry([tool("run_shell", async () => ({ stdout: "hi\n", stderr: "", exit_code: 3 }))]);
    const out = await registry.dispatch(input("run_shell", {}));
    expect(out.render).toBe("exit_code: 3\nstdout: hi");
  });

  it("sorts schemas by name and keeps the registration order for names()", () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool("write_file", async () => "ok"));
    registry.register(tool("read_file", async () => "ok"));
    expect(registry.schemas().map((s) => s.name)).toEqual(["read_file", "write_file"]);
    expect(registry.names()).toEqual(["write_file", "read_file"]);
    expect(registry.get("read_file")).toBeDefined();
    expect(registry.get("missing")).toBeUndefined();
  });
});

describe("humanRender", () => {
  it("condenses only stream-shaped objects", () => {
    expect(humanRender({ stdout: "a", exit_code: 0 })).toBe("exit_code: 0\nstdout: a");
    expect(humanRender({ exit_code: null, stdout: "" })).toBeNull();
    expect(humanRender("plain text")).toBeNull();
    expect(humanRender([1, 2])).toBeNull();
  });
});
