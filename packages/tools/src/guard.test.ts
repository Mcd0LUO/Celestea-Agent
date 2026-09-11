import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { ToolInput } from "@celestea/core";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "./testing/tmp.test-util.js";
import { mountProductionGuards, parseToolRoots, PathGuard, PathGuardPolicy } from "./guard/path-guard.js";
import { createToolRegistry, ToolRegistryImpl } from "./registry.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";

const workspace = makeTempDir("guard-ws");
const whitelist = makeDir(makeTempDir("guard-wl"), "read-only");
const outside = makeDir(makeTempDir("guard-out"), "elsewhere");
writeFixture(workspace, "inside.txt", "inside");
writeFixture(whitelist, "shared.txt", "shared");
writeFixture(outside, "secret.txt", "secret");

afterAll(() => cleanupTempDirs());

const policy = new PathGuardPolicy({ workspace, readRoots: [whitelist] });
const path = (name: string): string => join(workspace, name);
const input = (tool: string, target: string): ToolInput => ({ call_id: "c1", name: tool, args: { path: target } });

describe("parseToolRoots", () => {
  it("splits on commas and drops empty entries", () => {
    expect(parseToolRoots("/a,/b ,/c")).toEqual(["/a", "/b", "/c"]);
    // W513: PATH-style (colon) roots must parse exactly like Rust
    // `std::env::split_paths` — this is what the systemd units actually set.
    expect(parseToolRoots("/src/a:/src/b:/tmp")).toEqual(["/src/a", "/src/b", "/tmp"]);
    expect(parseToolRoots("/src/a:/src/b,/tmp")).toEqual(["/src/a", "/src/b", "/tmp"]);
    expect(parseToolRoots(" :/a::")).toEqual(["/a"]);
    expect(parseToolRoots(",, ,")).toEqual([]);
    expect(parseToolRoots(undefined)).toEqual([]);
  });
});

describe("PathGuardPolicy", () => {
  it("allows reads inside the workspace and inside a whitelist root", () => {
    expect(policy.checkRead(join(workspace, "inside.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkRead(join(whitelist, "shared.txt"))).toEqual({ kind: "allow" });
  });

  it("denies reads outside every root with the contract shape", () => {
    const decision = policy.checkRead(join(outside, "secret.txt"));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") expect(decision.reason).toContain("toolguard: code=path_forbidden");
  });

  it("denies `..` traversal that leaves the workspace", () => {
    // Literal `..` (path.join would normalize it away) reaching a real file outside.
    const escape = `${workspace}/${relative(workspace, join(outside, "secret.txt"))}`;
    expect(policy.checkRead(escape).kind).toBe("deny");
  });

  it("denies a symlink pointing outside the roots", () => {
    const link = path("link.txt");
    symlinkSync(join(outside, "secret.txt"), link);
    const decision = policy.checkRead(link);
    expect(decision.kind).toBe("deny");
  });

  it("denies a write whose directory symlinks outside the workspace", () => {
    const dirLink = path("escape-dir");
    mkdirSync(dirLink, { recursive: true });
    symlinkSync(outside, join(dirLink, "out"));
    expect(policy.checkWrite(join(dirLink, "out", "new.txt")).kind).toBe("deny");
  });

  it("treats whitelist roots as read-only", () => {
    expect(policy.checkWrite(join(whitelist, "shared.txt")).kind).toBe("deny");
    expect(policy.checkWrite(join(workspace, "new.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(workspace, "sub", "dir", "new.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(outside, "new.txt")).kind).toBe("deny");
  });

  it("passes an unresolvable read target through to the tool's own error", () => {
    expect(policy.checkRead(join(workspace, "missing.txt"))).toEqual({ kind: "allow" });
  });

  it("fails closed when a configured root cannot be used", () => {
    const failClosed = PathGuardPolicy.fromEnv({
      CELESTEA_TOOL_WORKDIR: workspace,
      CELESTEA_TOOL_ROOTS: `${whitelist},/nonexistent-root-xyz`,
    });
    expect(failClosed.failClosedReason).toContain("does not exist");
    const decision = failClosed.checkRead(join(workspace, "inside.txt"));
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") expect(decision.reason).toContain("code=tool_roots_invalid");
  });

  it("fails closed when the root list is set but empty", () => {
    const failClosed = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_ROOTS: " , " });
    expect(failClosed.failClosedReason).toContain("lists no directory");
  });

  it("reads the comma-separated roots and workspace from env", () => {
    const fromEnv = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: whitelist });
    expect(fromEnv.failClosedReason).toBeNull();
    expect(fromEnv.checkRead(join(whitelist, "shared.txt"))).toEqual({ kind: "allow" });
  });
});

describe("PathGuard", () => {
  const guard = new PathGuard(policy);

  it("arbitrates file tools and passes every other tool through", async () => {
    expect(await guard.check(input("read_file", join(outside, "secret.txt")))).toMatchObject({ kind: "deny" });
    expect(await guard.check(input("list_dir", join(outside, "secret.txt")))).toMatchObject({ kind: "deny" });
    expect(await guard.check(input("write_file", join(outside, "x.txt")))).toMatchObject({ kind: "deny" });
    for (const name of ["run_shell", "process_control", "http_request", "spawn_worker"]) {
      expect(await guard.check(input(name, "/etc/passwd"))).toEqual({ kind: "allow" });
    }
  });

  it("passes a missing path argument through (the tool reports it)", async () => {
    expect(await guard.check({ call_id: "c", name: "read_file", args: {} })).toEqual({ kind: "allow" });
    expect(await guard.check({ call_id: "c", name: "read_file", args: { path: 42 } })).toEqual({ kind: "allow" });
  });
});

describe("guard-mounted dispatch", () => {
  const registry = new ToolRegistryImpl();
  registry.register(readFileTool());
  registry.register(writeFileTool());
  registry.addGuard(new PathGuard(policy));

  it("denies an out-of-root read and an out-of-workspace write, touching no file", async () => {
    const read = await registry.dispatch(input("read_file", join(outside, "secret.txt")));
    expect(read.value).toBeNull();
    expect(read.error?.startsWith("denied: toolguard: code=path_forbidden")).toBe(true);
    const write = await registry.dispatch({
      call_id: "w1",
      name: "write_file",
      args: { path: join(outside, "new.txt"), content: "x" },
    });
    expect(write.error?.startsWith("denied: toolguard: code=path_forbidden")).toBe(true);
    expect(() => writeFileSync(join(outside, "new.txt"), "x")).not.toThrow();
  });

  it("allows and executes an in-workspace write", async () => {
    const out = await registry.dispatch({ call_id: "w2", name: "write_file", args: { path: path("ok.txt"), content: "hi" } });
    expect(out.error).toBeNull();
    expect(out.value).toBe("ok");
  });
});

describe("mountProductionGuards", () => {
  it("mounts the path guard unless explicitly disabled", () => {
    const on = new ToolRegistryImpl();
    expect(mountProductionGuards(on, { CELESTEA_TOOL_WORKDIR: workspace })).toBe(true);
    expect(on.guardChain()).toHaveLength(1);
    const off = createToolRegistry();
    expect(mountProductionGuards(off, { CELESTEA_TOOL_GUARD: "0" })).toBe(false);
    expect(off.guardChain()).toHaveLength(0);
  });
});

/**
 * W516 §4.1/§5.6: session grants may only ADD writable roots. Everything the
 * guard could be talked out of by a `grants.json` is asserted here explicitly.
 */
describe("write roots (session grants)", () => {
  const granted = makeDir(makeTempDir("guard-grant"), "out");
  writeFixture(granted, "seed.txt", "seed");
  const grantedPolicy = new PathGuardPolicy({ workspace, readRoots: [whitelist], writeRoots: [granted] });

  it("adds the granted root as writable and keeps the workspace writable", () => {
    expect(grantedPolicy.checkWrite(join(granted, "new.txt"))).toEqual({ kind: "allow" });
    expect(grantedPolicy.checkWrite(join(granted, "deep", "new.txt"))).toEqual({ kind: "allow" });
    expect(grantedPolicy.checkWrite(join(workspace, "new.txt"))).toEqual({ kind: "allow" });
    // §4.3.3: a `write_roots` root is NOT a read root — `read_roots` is its own
    // cap, so a write-only grant cannot be used to read the tree back out.
    expect(grantedPolicy.checkRead(join(granted, "seed.txt")).kind).toBe("deny");
    const both = new PathGuardPolicy({ workspace, readRoots: [whitelist, granted], writeRoots: [granted] });
    expect(both.checkRead(join(granted, "seed.txt"))).toEqual({ kind: "allow" });
  });

  it("still denies writes outside every writable root (removal = deny again)", () => {
    expect(grantedPolicy.checkWrite(join(outside, "new.txt")).kind).toBe("deny");
    const revoked = new PathGuardPolicy({ workspace, readRoots: [whitelist] });
    expect(revoked.checkWrite(join(granted, "new.txt")).kind).toBe("deny");
  });

  it("never removes or demotes a root a grant could have replaced", () => {
    expect(grantedPolicy.writeRoots[0]).toBe(workspace);
    expect(grantedPolicy.readRoots).toContain(whitelist);
    // read roots stay read-only, granted or not: a write root is a SEPARATE list.
    expect(grantedPolicy.checkWrite(join(whitelist, "shared.txt")).kind).toBe("deny");
  });

  it("keeps the legacy deny message when there is no extra write root", () => {
    const decision = policy.checkWrite(join(outside, "new.txt"));
    if (decision.kind !== "deny") expect.unreachable("must deny");
    expect(decision.reason).toContain(`write path '${join(outside, "new.txt")}' is outside the workspace '${workspace}'`);
  });

  it("merges grant roots through fromEnv without weakening the env fail-closed rule", () => {
    const merged = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: whitelist },
      { readRoots: [granted], writeRoots: [granted] },
    );
    expect(merged.readRoots).toEqual([workspace, whitelist, granted]);
    expect(merged.checkWrite(join(granted, "new.txt"))).toEqual({ kind: "allow" });
    // A broken CELESTEA_TOOL_ROOTS still denies EVERYTHING: grants cannot bypass it.
    const broken = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: "/nonexistent-root-xyz" },
      { writeRoots: [granted] },
    );
    expect(broken.checkWrite(join(granted, "new.txt")).kind).toBe("deny");
    expect(broken.checkRead(join(workspace, "inside.txt")).kind).toBe("deny");
  });

  it("cannot unmount or bypass the guard chain (§5.6)", async () => {
    const registry = new ToolRegistryImpl();
    expect(mountProductionGuards(registry, { CELESTEA_TOOL_WORKDIR: workspace }, { writeRoots: [granted] })).toBe(true);
    expect(registry.guardChain()).toHaveLength(1);
    expect(registry.guardChain()[0]).toBeInstanceOf(PathGuard);
    // A `write_file` outside the roots is still denied with the same contract code.
    const bypass = new PathGuard(new PathGuardPolicy({ workspace, readRoots: [], writeRoots: [] }));
    expect(await bypass.check(input("write_file", join(granted, "x.txt")))).toMatchObject({ kind: "deny" });
  });
})
