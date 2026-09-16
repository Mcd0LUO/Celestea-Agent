/**
 * W824 guard probes (W812 P0-1 + P0-2, re-confirmed by W822 /tmp/w822-p0.mts).
 *
 * P0-1: a dangling symlink as the FINAL write component escaped the workspace
 *       (resolveWriteTarget lexically re-appended it). Must be denied.
 * P0-2: a relative path was arbitrated against the session workspace but opened
 *       against process.cwd(). Must be resolved against the workspace first.
 *
 * These are the acceptance probes: they fail on HEAD and pass after the fix.
 */

import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Tool, ToolSpec } from "@celestea/core";

import { createToolRegistry } from "../registry.js";
import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "../testing/tmp.test-util.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { PathGuard, PathGuardPolicy } from "./path-guard.js";
import { isInside, resolveWriteTarget } from "./paths.js";

afterAll(() => cleanupTempDirs());

const policyFor = (workspace: string): PathGuard => new PathGuard(new PathGuardPolicy({ workspace }));

describe("W824 guard P0-1: dangling symlink write escape", () => {
  it("denies a write whose final component links outside to a missing target", async () => {
    const root = makeTempDir("w824-link");
    const ws = makeDir(root, "ws");
    const outside = makeDir(root, "outside");
    symlinkSync(join(outside, "new.txt"), join(ws, "link"));

    const resolved = resolveWriteTarget("link", ws);
    expect(resolved).not.toBeNull();
    expect(isInside(resolved as string, ws)).toBe(false);

    const registry = createToolRegistry([writeFileTool()], [policyFor(ws)]);
    const out = await registry.dispatch({ call_id: "c1", name: "write_file", args: { path: "link", content: "ESC" } });
    expect(out.error).not.toBeNull();
    expect(out.error).toMatch(/denied|path_forbidden/);
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });
});

describe("W824 guard P0-2: relative paths are workspace-relative, never cwd-relative", () => {
  it("read_file reads the workspace file, not a same-named cwd file", async () => {
    const root = makeTempDir("w824-rel");
    const ws = makeDir(root, "ws");
    const cwd = makeDir(root, "cwd");
    writeFixture(ws, "secret.txt", "WS-SECRET");
    writeFixture(cwd, "secret.txt", "CWD-SECRET");
    const registry = createToolRegistry([readFileTool()], [policyFor(ws)]);
    const before = process.cwd();
    try {
      process.chdir(cwd);
      const out = await registry.dispatch({ call_id: "c2", name: "read_file", args: { path: "secret.txt" } });
      expect(out.error).toBeNull();
      expect(out.value).toBe("WS-SECRET");
      expect(out.value).not.toBe("CWD-SECRET");
    } finally {
      process.chdir(before);
    }
  });

  it("does not fall through to a cwd file when the workspace target is missing", async () => {
    const root = makeTempDir("w824-rel-miss");
    const ws = makeDir(root, "ws");
    const cwd = makeDir(root, "cwd");
    writeFixture(cwd, "secret.txt", "CWD-SECRET");
    const registry = createToolRegistry([readFileTool()], [policyFor(ws)]);
    const before = process.cwd();
    try {
      process.chdir(cwd);
      const out = await registry.dispatch({ call_id: "c3", name: "read_file", args: { path: "secret.txt" } });
      expect(out.value).not.toBe("CWD-SECRET");
      expect(out.error).not.toBeNull();
    } finally {
      process.chdir(before);
    }
  });

  it("write_file lands in the workspace even when cwd differs", async () => {
    const root = makeTempDir("w824-write");
    const ws = makeDir(root, "ws");
    const cwd = makeDir(root, "cwd");
    const registry = createToolRegistry([writeFileTool()], [policyFor(ws)]);
    const before = process.cwd();
    try {
      process.chdir(cwd);
      const out = await registry.dispatch({ call_id: "c4", name: "write_file", args: { path: "out.txt", content: "X" } });
      expect(out.error).toBeNull();
    } finally {
      process.chdir(before);
    }
    expect(existsSync(join(ws, "out.txt"))).toBe(true);
    expect(existsSync(join(cwd, "out.txt"))).toBe(false);
  });

  it("normalizes every path-bearing fs tool argument before execution", async () => {
    const root = makeTempDir("w824-all");
    const ws = makeDir(root, "ws");
    const seen = new Map<string, string>();
    const names = ["read_file", "write_file", "list_dir", "read_image"];
    const registry = createToolRegistry(
      names.map((name) => captureTool(name, seen)),
      [policyFor(ws)],
    );
    for (const name of names) {
      const out = await registry.dispatch({ call_id: "c5", name, args: { path: "rel/file.txt" } });
      expect(out.error, name).toBeNull();
    }
    for (const name of names) {
      expect(seen.get(name), name).toBe(join(ws, "rel/file.txt"));
    }
  });
});

function captureTool(name: string, seen: Map<string, string>): Tool {
  const spec: ToolSpec = {
    name,
    description: name,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  return {
    spec: () => spec,
    execute: async (args) => {
      const path = (args as { path?: unknown }).path;
      if (typeof path === "string") seen.set(name, path);
      return "ok";
    },
  };
}
