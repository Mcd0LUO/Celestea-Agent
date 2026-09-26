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

  /**
   * W9205 — a `"/"` READ root opens READS ONLY.
   *
   * The W9110 shape fed both lists into one combined flag, so a caller that
   * named `"/"` as a read root silently acquired write access over the whole
   * host. Read and write are separate capabilities now, and this is the
   * assertion that keeps them separate.
   */
  it("a '/' READ root does NOT open writes", () => {
    const readWide = new PathGuardPolicy({ workspace, readRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(readWide.allPathsRead).toBe(true);
    expect(readWide.allPathsWrite).toBe(false);
    // The combined summary must stay honest: only ONE half is open.
    expect(readWide.allPaths).toBe(false);
    expect(readWide.checkRead(outsideFile)).toEqual({ kind: "allow" });
    expect(readWide.checkWrite(join(outside, "celestea-w9205-read-only.txt")).kind).toBe("deny");
    // ...and the mirror image: a '/' WRITE root does not open reads.
    const writeWide = new PathGuardPolicy({ workspace, writeRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(writeWide.allPathsRead).toBe(false);
    expect(writeWide.allPathsWrite).toBe(true);
    expect(writeWide.checkRead(outsideFile).kind).toBe("deny");
    expect(writeWide.checkWrite(join(outside, "celestea-w9205-write-only.txt"))).toEqual({ kind: "allow" });
  });

  it("POSIX is byte-identical: the sentinel IS the host root, so '/' keeps working", () => {
    // Requirement ③ — the POSIX answer must not move. On POSIX the sentinel and
    // the host root are the same string, so the old spelling keeps its exact
    // meaning and the roots list keeps its exact bytes.
    //
    // W9205: that identity is exactly why the spelling can no longer be the
    // source of truth — the two readings DO collide on POSIX. See the
    // "workspace === '/'" cases below; the byte itself is unchanged.
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

/**
 * W9205 (P0) — the workspace can NEVER manufacture the capability.
 *
 * Root cause of the reported P0: `ALL_PATHS_ROOT` is `"/"`, `readRoots` always
 * begins with the workspace, and the constructor asked `hasAllPathsRoot` about
 * that COMPOSED list. So `workspace === "/"` made `allPaths` true and a policy
 * declared `workspaceWritable: false` answered `checkWrite("/etc/cron.d/evil")`
 * with `allow` — a read-only session with full-disk write access.
 *
 * The name is fixed, not the coincidence: the spelling is read off the DECLARED
 * lists only, so no workspace value can imply it. `"/"` is a real workspace on
 * POSIX (and `path.win32.resolve("/")` is the current drive root), so both
 * spellings are asserted.
 */
describe("W9205 the workspace cannot imply allPaths", () => {
  it("workspace === '/' + read-only denies every write (the reported P0)", () => {
    const policy = new PathGuardPolicy({ workspace: "/", workspaceWritable: false });
    expect(policy.allPaths).toBe(false);
    expect(policy.allPathsRead).toBe(false);
    expect(policy.allPathsWrite).toBe(false);
    // The exact call from the report: no /etc write, no matter the workspace.
    expect(policy.checkWrite("/etc/cron.d/evil").kind).toBe("deny");
    expect(policy.checkWrite("/etc/shadow").kind).toBe("deny");
    // Reads stay bounded too — the workspace IS "/" here, which is the whole
    // point: "/" as a workspace is an ordinary (if very wide) read root.
    expect(policy.readRoots).toEqual(["/"]);
  });

  it("workspace === '/' + read-only + a VALID root list still denies writes", () => {
    // The production composition: a declared read root AND a read-only baseline.
    // Before the fix the workspace alone was enough; now nothing here may write.
    const policy = PathGuardPolicy.fromEnv(
      { CELESTEA_TOOL_WORKDIR: "/", CELESTEA_TOOL_ROOTS: outside },
      { workspaceWritable: false },
    );
    expect(policy.allPaths).toBe(false);
    expect(policy.checkWrite("/etc/cron.d/evil").kind).toBe("deny");
    expect(policy.checkWrite(join(outside, "celestea-w9205-ws-root.txt")).kind).toBe("deny");
  });

  it("a '/' READ root + read-only denies writes (the second half of the P0)", () => {
    // The other route into the same bug: the operator/engine lists "/" as a
    // READ root. Reads open; writes must not.
    const policy = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, { readRoots: [ALL_PATHS_ROOT], workspaceWritable: false });
    expect(policy.allPathsWrite).toBe(false);
    expect(policy.checkWrite("/etc/cron.d/evil").kind).toBe("deny");
    expect(policy.checkWrite(join(outside, "celestea-w9205-read-root.txt")).kind).toBe("deny");
  });
});

/**
 * W9205 (P0) — `fromEnv` must forward `workspaceWritable` on EVERY exit.
 *
 * `fromEnv` has three exits (no env roots / empty list / valid list). The third
 * one dropped `workspaceWritable`, and `undefined` reads as "writable" in the
 * constructor — so a READ-ONLY session became writable again as soon as
 * `CELESTEA_TOOL_ROOTS` named one usable directory. That is the PRODUCTION case:
 * `scripts/run-studio-ts.sh` always sets the variable.
 *
 * All three exits are asserted TOGETHER on purpose: the bug was one copy of a
 * three-times-repeated literal, so a test that checks only the path it happened
 * to be written against cannot see the next drift.
 */
describe("W9205 fromEnv forwards workspaceWritable on every exit", () => {
  /** The read-only baseline (`store/permissions.ts` read-only preset). */
  const readOnly = { workspaceWritable: false } as const;

  it("valid root list: read-only denies the workspace write (the production path)", () => {
    const policy = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: outside }, readOnly);
    expect(policy.failClosedReason).toBeNull();
    expect(policy.writeRoots).toEqual([]);
    expect(policy.checkWrite(join(workspace, "celestea-w9205-ro.txt")).kind).toBe("deny");
    // The env root is still a READ root, and still not writable.
    expect(policy.checkRead(outsideFile)).toEqual({ kind: "allow" });
    expect(policy.checkWrite(join(outside, "celestea-w9205-ro-out.txt")).kind).toBe("deny");
  });

  it("no env roots: read-only denies the workspace write (the historical exit)", () => {
    const policy = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace }, readOnly);
    expect(policy.writeRoots).toEqual([]);
    expect(policy.checkWrite(join(workspace, "celestea-w9205-ro-none.txt")).kind).toBe("deny");
  });

  it("empty root list: read-only denies the workspace write (the fail-closed exit)", () => {
    const policy = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: " , " }, readOnly);
    expect(policy.failClosedReason).toContain("lists no directory");
    expect(policy.writeRoots).toEqual([]);
    // Fail-closed wins, so the denial code is the roots one — but it is a DENY.
    expect(policy.checkWrite(join(workspace, "celestea-w9205-ro-empty.txt")).kind).toBe("deny");
  });

  it("a writable baseline is unaffected (the fix must not narrow anything)", () => {
    const policy = PathGuardPolicy.fromEnv({ CELESTEA_TOOL_WORKDIR: workspace, CELESTEA_TOOL_ROOTS: outside }, { workspaceWritable: true });
    expect(policy.writeRoots).toEqual([workspace]);
    expect(policy.checkWrite(join(workspace, "celestea-w9205-rw.txt"))).toEqual({ kind: "allow" });
  });
});
