/**
 * W768 — the per-SESSION filesystem scope.
 *
 * A process serves several sessions, so a process-wide env knob
 * (`CELESTEA_TOOL_WORKDIR`) cannot describe any one of their workspaces: the
 * prompt named the session's workspace while `pwd` reported the directory the
 * service happened to be launched from. These tests pin the two halves that fix
 * it — the sandbox's cwd/root and the guard's writable root — and the fallback
 * for a session that has no workspace at all.
 */

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ToolInput } from "@celestea/core";

import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "../testing/tmp.test-util.js";
import { PathGuardPolicy } from "./path-guard.js";
import { sandboxConfigFromEnv, sessionSandboxConfig } from "../sandbox/config.js";

/** Two "workspaces", one operator-listed read root, one unlisted directory. */
const root = makeTempDir("scope");
const wsA = makeDir(root, "ws-a");
const wsB = makeDir(root, "ws-b");
const elsewhere = makeDir(root, "elsewhere");
const unlisted = makeDir(root, "unlisted");
writeFixture(wsA, "a.txt", "A");
writeFixture(wsB, "b.txt", "B");
writeFixture(elsewhere, "shared.txt", "S");
writeFixture(unlisted, "secret.txt", "X");

afterAll(() => cleanupTempDirs());

/** The service's real posture: a process workdir + operator read roots. */
const env: NodeJS.ProcessEnv = {
  CELAESTEA_RUN_SHELL_WORKDIR: wsB,
  CELESTEA_TOOL_WORKDIR: wsB,
  CELESTEA_TOOL_ROOTS: `${wsB}:${elsewhere}`,
};

const read = (target: string): ToolInput => ({ call_id: "c1", name: "read_file", args: { path: target } });
const write = (target: string): ToolInput => ({ call_id: "c2", name: "write_file", args: { path: target } });

describe("sandbox config scope (W768)", () => {
  it("keeps the env posture when there is no session scope", () => {
    const config = sandboxConfigFromEnv(env);
    expect(config.workdir).toBe(wsB);
    expect(sessionSandboxConfig(null, env)).toEqual(config);
  });

  it("runs a session in ITS workspace (cwd AND containment root)", () => {
    const config = sessionSandboxConfig({ workspace: wsA }, env);
    expect(config.workdir).toBe(wsA);
    expect(config.root).toBe(wsA);
    // The operator's limits are not the session's business.
    expect(config.timeoutMs).toBe(sandboxConfigFromEnv(env).timeoutMs);
    expect(config.maxOutputBytes).toBe(sandboxConfigFromEnv(env).maxOutputBytes);
  });
});

describe("path guard scope (W768)", () => {
  it("falls back to the env workspace without a session scope", () => {
    const policy = PathGuardPolicy.fromEnv(env);
    expect(policy.workspace).toBe(wsB);
    // ...and the env read roots are exactly what the operator declared.
    expect(policy.readRoots).toContain(elsewhere);
  });

  it("moves the writable workspace to the session's own root", async () => {
    const policy = PathGuardPolicy.fromEnv(env, {}, { workspace: wsA });
    expect(policy.workspace).toBe(wsA);
    expect(policy.writeRoots[0]).toBe(wsA);
    // In-workspace reads and writes stay allowed...
    expect(policy.checkRead(join(wsA, "a.txt"))).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(wsA, "new.txt"))).toEqual({ kind: "allow" });
    // ...reading the OTHER workspace stays allowed only because the operator
    // listed it as a read root...
    expect(policy.checkRead(join(wsB, "b.txt"))).toEqual({ kind: "allow" });
    // ...but writing into it is now refused (it is not this session's workspace)...
    expect(policy.checkWrite(join(wsB, "intrude.txt")).kind).toBe("deny");
    // ...and a directory outside EVERY root stays refused for both accesses.
    expect(policy.checkRead(join(unlisted, "secret.txt")).kind).toBe("deny");
    expect(policy.checkWrite(join(unlisted, "new.txt")).kind).toBe("deny");
  });

  it("keeps the grant roots append-only under a session scope", () => {
    const policy = PathGuardPolicy.fromEnv(env, { readRoots: [elsewhere] }, { workspace: wsA });
    expect(policy.readRoots[0]).toBe(wsA);
    expect(policy.readRoots).toContain(elsewhere);
    // Grants can ADD write roots; they still cannot remove the workspace.
    const withWrite = PathGuardPolicy.fromEnv(env, { writeRoots: [elsewhere] }, { workspace: wsA });
    expect(withWrite.writeRoots[0]).toBe(wsA);
    expect(withWrite.checkWrite(join(elsewhere, "granted.txt"))).toEqual({ kind: "allow" });
  });

  it("denies the same calls for a session whose scope is another workspace", () => {
    const policy = PathGuardPolicy.fromEnv(env, {}, { workspace: wsA });
    // The exact bug: a session in ws-a must not write into the process workdir.
    expect(policy.checkWrite(join(wsB, "from-a.txt")).kind).toBe("deny");
    const mirrored = PathGuardPolicy.fromEnv(env, {}, { workspace: wsB });
    expect(mirrored.checkWrite(join(wsB, "from-b.txt"))).toEqual({ kind: "allow" });
    expect(mirrored.checkWrite(join(wsA, "from-b.txt")).kind).toBe("deny");
  });
});
