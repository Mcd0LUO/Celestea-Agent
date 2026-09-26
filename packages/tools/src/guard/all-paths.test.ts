/**
 * W9110 — `allPaths` is a CAPABILITY, not a path (the Windows P0).
 *
 * Reported symptom: under Full Access a session could read/write the workspace
 * and the session's own drive root, but NOTHING on any other drive. Root cause:
 * `allPaths` was expressed as the SESSION directory's volume root
 * (`filesystemRoot(sessionDir)` = `C:\\`), and Windows has one root per volume —
 * so a single string root could only ever name one of them.
 *
 * These tests pin the fix at the guard, which is the ONLY path-isolation
 * enforcement point on Windows (bwrap is POSIX-only; the userspace fallback does
 * no path isolation). The win32 half runs for real on Windows and is a VISIBLE
 * skip on a single-volume host.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeDir, makeTempDir, writeFixture } from "../testing/tmp.test-util.js";
import { ALL_PATHS_ROOT, PathGuardPolicy } from "./path-guard.js";

const workspace = makeTempDir("allpaths-ws");
const outside = makeDir(makeTempDir("allpaths-out"), "elsewhere");
const outsideFile = writeFixture(outside, "secret.txt", "outside");
/** Probe dirs minted on other volumes so they can be reclaimed. */
const foreign: string[] = [];
afterAll(() => {
  for (const dir of foreign.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupTempDirs();
});

/** Try to mint a throwaway dir directly on `root`; null when the volume cannot. */
function probeVolume(root: string): string | null {
  try {
    const dir = mkdtempSync(join(root, "celestea-w9110-"));
    foreign.push(dir);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Every volume this host really lets us write to, as directories. win32 probes
 * drive letters (a missing/read-only drive just fails); POSIX probes the usual
 * mount points and only counts a genuinely different `parse().root`.
 */
function usableVolumes(): string[] {
  const hostRoot = parse(tmpdir()).root;
  const found: string[] = [];
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = letter + ":\\";
      if (root.toLowerCase() === hostRoot.toLowerCase()) continue;
      const dir = probeVolume(root);
      if (dir !== null) found.push(dir);
    }
    return found;
  }
  for (const candidate of ["/mnt", "/media", "/Volumes", "/run/media"]) {
    if (!existsSync(candidate)) continue;
    if (parse(candidate).root === hostRoot) continue;
    found.push(candidate);
  }
  return found;
}

describe("W9110 allPaths — the capability covers every volume", () => {
  it("allows a real path on a volume OTHER than the session's (the reported P0)", (ctx) => {
    const other = usableVolumes()[0];
    if (other === undefined) {
      ctx.skip("this host exposes a single writable volume; the cross-drive case cannot be built here");
      return;
    }
    const target = join(other, "celestea-w9110-other.txt");
    writeFileSync(target, "w9110-other-volume\n");
    // The two paths really are on different volumes — that IS the case the old
    // shape (session drive root) could never reach.
    expect(parse(target).root).not.toBe(parse(workspace).root);
    const policy = new PathGuardPolicy({ workspace, allPaths: true, workspaceWritable: false });
    expect(policy.checkRead(target)).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(other, "celestea-w9110-made.txt"))).toEqual({ kind: "allow" });
    rmSync(target, { force: true });
  });

  it("allows paths on TWO different volumes through ONE policy", (ctx) => {
    const others = usableVolumes();
    if (others.length === 0) {
      ctx.skip("this host exposes a single writable volume; the two-drive case cannot be built here");
      return;
    }
    const policy = new PathGuardPolicy({ workspace, allPaths: true });
    // The session's own volume and every other one, all through the same policy.
    expect(policy.checkRead(outsideFile)).toEqual({ kind: "allow" });
    for (const dir of others) {
      const file = join(dir, "celestea-w9110-two.txt");
      writeFileSync(file, "two\n");
      expect(policy.checkRead(file), file).toEqual({ kind: "allow" });
      expect(policy.checkWrite(join(dir, "celestea-w9110-two-made.txt")), dir).toEqual({ kind: "allow" });
      rmSync(file, { force: true });
    }
  });

  it("keeps the session's volume root a BOUNDED root — the old shape cannot reach another volume", (ctx) => {
    const other = usableVolumes()[0];
    if (other === undefined) {
      ctx.skip("single-volume host: 'another drive' is not expressible");
      return;
    }
    const target = join(other, "celestea-w9110-bounded.txt");
    writeFileSync(target, "bounded\n");
    // The exact W891 composition: the session's drive root as both roots.
    const bounded = new PathGuardPolicy({ workspace, readRoots: [parse(workspace).root], writeRoots: [parse(workspace).root], workspaceWritable: false });
    expect(bounded.allPaths).toBe(false);
    expect(bounded.checkRead(target).kind).toBe("deny");
    expect(bounded.checkWrite(target).kind).toBe("deny");
    rmSync(target, { force: true });
  });

  it("is carried by the sentinel root alone (callers that only pass roots still say it)", () => {
    const viaRoots = new PathGuardPolicy({ workspace, readRoots: [ALL_PATHS_ROOT], writeRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(viaRoots.allPaths).toBe(true);
    expect(viaRoots.checkRead(outsideFile)).toEqual({ kind: "allow" });
    expect(viaRoots.checkWrite(join(outside, "celestea-w9110-sentinel.txt"))).toEqual({ kind: "allow" });
    // ...and through the production wiring (grants view -> fromEnv).
    const viaEnv = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { allPaths: true, workspaceWritable: false });
    expect(viaEnv.allPaths).toBe(true);
    expect(viaEnv.checkWrite(join(outside, "celestea-w9110-env.txt"))).toEqual({ kind: "allow" });
  });

  it("POSIX is byte-identical: the sentinel IS the host root, so '/' keeps working", () => {
    // Requirement ③ — the POSIX answer must not move. On POSIX the sentinel and
    // the host root are the same string, so the old spelling keeps its exact
    // meaning and the roots list keeps its exact bytes.
    expect(ALL_PATHS_ROOT).toBe("/");
    if (process.platform !== "win32") expect(parse(workspace).root).toBe(ALL_PATHS_ROOT);
    const wide = new PathGuardPolicy({ workspace, readRoots: [ALL_PATHS_ROOT], writeRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(wide.readRoots).toEqual([workspace, ALL_PATHS_ROOT]);
    expect(wide.writeRoots).toEqual([ALL_PATHS_ROOT]);
    expect(wide.checkRead(outsideFile)).toEqual({ kind: "allow" });
    expect(wide.checkWrite(join(outside, "celestea-w9110-posix.txt"))).toEqual({ kind: "allow" });
    // An unresolvable path still passes through to the tool (unchanged).
    expect(wide.checkRead(join(workspace, "missing.txt"))).toEqual({ kind: "allow" });
  });
});

describe("W9110 allPaths — the security boundary is NOT widened", () => {
  it("a path-limited baseline (write-read) still denies outside the workspace on EVERY volume", (ctx) => {
    // Requirement ④ — the restricted baseline is the control. It must refuse the
    // workspace's own volume AND any other volume, so this suite can never go
    // green by widening everything.
    const restricted = new PathGuardPolicy({ workspace, workspaceWritable: true });
    expect(restricted.allPaths).toBe(false);
    expect(restricted.checkRead(outsideFile).kind).toBe("deny");
    expect(restricted.checkWrite(join(outside, "celestea-w9110-ro.txt")).kind).toBe("deny");
    const other = usableVolumes()[0];
    if (other === undefined) {
      ctx.skip("single-volume host: the second-volume half of the control cannot be built");
      return;
    }
    const target = join(other, "celestea-w9110-ro-other.txt");
    writeFileSync(target, "ro\n");
    expect(restricted.checkRead(target).kind).toBe("deny");
    expect(restricted.checkWrite(target).kind).toBe("deny");
    rmSync(target, { force: true });
  });

  it("a read-only baseline denies both accesses (allPaths off)", () => {
    const ro = new PathGuardPolicy({ workspace, readRoots: [], writeRoots: [], workspaceWritable: false });
    expect(ro.allPaths).toBe(false);
    expect(ro.checkRead(outsideFile).kind).toBe("deny");
    expect(ro.checkWrite(join(outside, "celestea-w9110-never.txt")).kind).toBe("deny");
  });

  it("fail-closed still WINS over allPaths (a broken CELESTEA_TOOL_ROOTS denies everything)", () => {
    const broken = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: "/nonexistent-root-xyz" },
      { allPaths: true },
    );
    expect(broken.allPaths).toBe(true);
    expect(broken.checkRead(outsideFile).kind).toBe("deny");
    expect(broken.checkWrite(join(outside, "celestea-w9110-broken.txt")).kind).toBe("deny");
    if (broken.checkRead(outsideFile).kind === "deny") {
      expect((broken.checkRead(outsideFile) as { reason: string }).reason).toContain("code=tool_roots_invalid");
    }
  });

  it("is opt-in: an ordinary policy never widens by accident", () => {
    expect(new PathGuardPolicy({ workspace }).allPaths).toBe(false);
    expect(new PathGuardPolicy({ workspace, readRoots: [outside] }).allPaths).toBe(false);
    expect(new PathGuardPolicy({ workspace, writeRoots: [outside] }).allPaths).toBe(false);
    expect(PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }).allPaths).toBe(false);
  });
});
