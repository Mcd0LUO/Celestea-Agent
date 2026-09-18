/**
 * W9: a read-only permission makes the workspace non-writable for write_file
 * (the bwrap mount is the shell-side half; see sandbox/w9-rw-roots.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathGuardPolicy } from "./path-guard.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), "w9-ro-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.txt"), "x");
  return dir;
}

describe("W9 read-only path policy", () => {
  it("denies a workspace write under read-only and allows reads", () => {
    const dir = ws();
    const ro = new PathGuardPolicy({ workspace: dir, workspaceWritable: false });
    expect(ro.checkWrite(join(dir, "b.txt")).kind).toBe("deny");
    expect(ro.checkRead(join(dir, "a.txt")).kind).toBe("allow");
  });

  it("allows a workspace write when the permission is writable (default)", () => {
    const dir = ws();
    const rw = new PathGuardPolicy({ workspace: dir });
    expect(rw.checkWrite(join(dir, "b.txt")).kind).toBe("allow");
  });
});
