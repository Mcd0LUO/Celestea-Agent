/**
 * W9 permission-baseline tests (split from grants.test.ts to stay under the
 * 400-line file budget): the default full-access baseline, the
 * CELESTEA_PERMISSION_MAX capability clamp, and the grant OR-path for
 * unsandboxed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { effectiveGrantsOf } from "./runtime/engine-grants.js";
import type { GrantRecord } from "./store/grants.js";

const roots: string[] = [];
function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perm-" + name + "-"));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function sessionDir(name: string): string {
  const dir = tempDir(name);
  const session = join(dir, "ws", "s1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "cli-main.jsonl"), "");
  return session;
}
const HOME = process.env["HOME"] ?? "/home/nobody";
function envOf(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CELESTEA_WORKSPACES_FILE: join(dataDir, "workspaces.json"), HOME, ...extra };
}
const NOW = 1_700_000_500;
function grantEntry(cap: string, scope: Record<string, unknown>, extra: Record<string, unknown> = {}): GrantRecord {
  return { id: "g-" + cap.slice(0, 6), cap: cap as GrantRecord["cap"], scope, granted_at: 1_700_000_000, granted_by: "hand", expires_at: null, uses_left: null, note: "", ...extra } as GrantRecord;
}
function writeFile(session: string, grants: unknown[], sessionId = "ws/s1"): void {
  writeFileSync(join(session, "grants.json"), JSON.stringify({ version: 1, session: sessionId, updated_at: 1_700_000_000, grants }));
}

describe("W9 permission baseline", () => {
  it("defaults to full-access (network on) and clamps to CELESTEA_PERMISSION_MAX", () => {
    const dir = sessionDir("perm");
    const full = effectiveGrantsOf(dir, envOf(dir), NOW).grants;
    expect(full.network).toBe(true);
    expect(full.workspaceWritable).toBe(true);
    const clamped = effectiveGrantsOf(dir, envOf(dir, { CELESTEA_PERMISSION_MAX: "write-read" }), NOW).grants;
    expect(clamped.network).toBe(false);
    expect(clamped.workspaceWritable).toBe(true);
    const ro = effectiveGrantsOf(dir, envOf(dir, { CELESTEA_PERMISSION_MAX: "read-only" }), NOW).grants;
    expect(ro.workspaceWritable).toBe(false);
    expect(ro.toolDeny).toContain("write_file");
  });

  it("a grant can open unsandboxed when the preset leaves it off (env allows)", () => {
    const dir = sessionDir("perm-or");
    const dataDir = tempDir("data");
    const env = envOf(dataDir, { CELESTEA_GRANTS_ALLOW_UNSANDBOXED: "1", CELESTEA_PERMISSION_MAX: "write-read" });
    writeFile(dir, [grantEntry("unsandboxed", {}, { id: "g-u", expires_at: NOW + 600 })]);
    expect(effectiveGrantsOf(dir, env, NOW).grants.unsandboxed).toBe(true);
    const closed = envOf(dataDir, { CELESTEA_PERMISSION_MAX: "write-read" });
    expect(effectiveGrantsOf(dir, closed, NOW).grants.unsandboxed).toBe(false);
  });
  it("ignores a write_roots grant when the baseline is read-only", () => {
    const dir = sessionDir("perm-ro-grant");
    const dataDir = tempDir("data");
    const out = join(dataDir, "out");
    mkdirSync(out, { recursive: true });
    writeFile(dir, [grantEntry("write_roots", { roots: [out] }, { id: "g-w" })]);
    const env = envOf(dataDir, { CELESTEA_PERMISSION_MAX: "read-only" });
    const result = effectiveGrantsOf(dir, env, NOW);
    expect(result.grants.writeRoots).toEqual([]);
    expect(result.warnings.join(" | ")).toContain("read-only");
  });
});
