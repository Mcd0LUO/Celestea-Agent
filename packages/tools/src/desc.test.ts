/**
 * W779 T1 — every tool takes one optional `desc` UI label, and taking it
 * changes nothing else.
 *
 * The label is pure presentation: the specs declare it, the dispatch pipeline
 * accepts it like any other optional string, and no executor reads it. These
 * cases pin all three halves (declaration / acceptance / neutrality) plus the
 * deliberate absence of a `maxLength` — an over-long label must never turn a
 * working call into `toolargs: code=schema`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Sandbox, ToolSpec } from "@celestea/core";

import { DESC_DESCRIPTION, descParam } from "./desc.js";
import { assembleTools } from "./plugin.js";
import { createToolRegistry } from "./registry.js";
import { readFileTool } from "./tools/read-file.js";

/** The builtin specs of the composed registry — the source of `GET /api/tools` (W884 load_skill; B2 remember/forget; W1533 update_tasks). */
function builtinSpecs(): ToolSpec[] {
  return assembleTools({ guard: null, env: {}, sandbox: stubSandbox() }).registry.schemas();
}

/** A sandbox that never runs: only the specs are read here. */
function stubSandbox(): Sandbox {
  // W891: the host temp dir, not the POSIX-only "/tmp".
  const base = tmpdir();
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxCpuSec: 600, maxOutputBytes: 1024, workdir: base, root: base, programDir: join(base, "run-code"), extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W779: the desc check never executes a command"));
  return { config, run: refuse, spawn: refuse };
}

describe("W779 · the desc UI label is declared on every tool", () => {
  it("carries the identical optional desc on all 11 builtin specs", () => {
    const specs = builtinSpecs();
    expect(specs.map((s) => s.name)).toHaveLength(11);
    for (const spec of specs) {
      const properties = spec.parameters["properties"] as Record<string, unknown>;
      expect(properties["desc"], spec.name).toEqual(descParam());
      // Optional: never required, or an agent could not omit it.
      expect(spec.parameters["required"] as string[], spec.name).not.toContain("desc");
    }
  });

  it("keeps one frozen wording for the label (no per-tool drift)", () => {
    expect(DESC_DESCRIPTION).toBe(
      "Optional one-line label (max 80 chars) describing what this call is doing; shown on the tool card in the UI. Keep it short.",
    );
    expect(descParam()).toEqual({ type: "string", description: DESC_DESCRIPTION });
    // A fresh object each call: a spec is a value, never a shared mutable ref.
    expect(descParam()).not.toBe(descParam());
  });

  it("replaced run_code's never-consumed `description` argument with `desc`", () => {
    const runCode = builtinSpecs().find((s) => s.name === "run_code");
    const properties = runCode?.parameters["properties"] as Record<string, unknown>;
    expect(properties["desc"]).toEqual(descParam());
    expect(properties).not.toHaveProperty("description");
  });
});

describe("W779 · desc is accepted and ignored (behaviour zero-change)", () => {
  it("validates a string desc and still rejects a wrong-typed one", () => {
    const registry = createToolRegistry([readFileTool()]);
    return (async (): Promise<void> => {
      const bad = await registry.dispatch({ call_id: "c1", name: "read_file", args: { path: "/x", desc: 7 } });
      expect(bad.error ?? "").toContain("desc");
      // A refused call answers `value: null` — the tool never ran.
      expect(bad.value).toBeNull();
    })();
  });

  it("returns the same value with and without a desc (even a 200-char one)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "desc-label-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello\n");
    try {
      const registry = createToolRegistry([readFileTool()]);
      const plain = await registry.dispatch({ call_id: "c1", name: "read_file", args: { path: file } });
      const labelled = await registry.dispatch({ call_id: "c2", name: "read_file", args: { path: file, desc: "Read the greeting" } });
      const long = await registry.dispatch({ call_id: "c3", name: "read_file", args: { path: file, desc: "x".repeat(200) } });
      expect(plain.error).toBeNull();
      expect(labelled).toEqual({ ...plain, call_id: "c2" });
      // 80 chars is a display budget, not a schema rule: no `maxLength` exists in
      // the frozen validator subset, so a long label stays a working call.
      expect(long).toEqual({ ...plain, call_id: "c3" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
