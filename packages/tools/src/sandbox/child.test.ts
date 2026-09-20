/**
 * W885 — the Windows tree-kill BRANCH SELECTION (not the kill itself).
 *
 * `taskkill /PID <pid> /T /F` is the only tree-kill Windows ships, and it is
 * inherently racy (a child may re-parent between the walk and the kill), so this
 * slice treats it as best effort and leaves the real fix (Job Objects) to W885
 * slice 2. What IS testable on a Linux host is the decision: the POSIX path must
 * never shell out, and the Windows branch must decline rather than throw when
 * taskkill cannot run (there is no taskkill here, which is exactly the fallback
 * case `signalTree` relies on).
 *
 * NOT verified on this host: that taskkill actually reaps a real Windows tree.
 */

import { describe, expect, it } from "vitest";

import { taskkillTree } from "./child.js";

describe("W885/W892 taskkillTree", () => {
  it("declines on POSIX — the group signal stays the only POSIX mechanism", () => {
    expect(taskkillTree(1, "linux")).toBe(false);
    expect(taskkillTree(1, "darwin")).toBe(false);
  });

  // W892: there is deliberately NO "taskkill is unavailable ⇒ false" case here.
  // On Linux taskkill is missing (ENOENT) so it returns false, but on Windows it
  // EXISTS and a dead pid is reported true ("the tree is already gone") — so the
  // assertion was platform-dependent. The real distinction is pinned with an
  // injected ENOENT runner in the case below.

  it("does NOT run taskkill at all on POSIX", () => {
    let runs = 0;
    expect(taskkillTree(1, "linux", { run: () => void runs++ })).toBe(false);
    expect(runs).toBe(0);
  });

  /**
   * W892: the old body returned true whenever execFileSync did not throw, so a
   * taskkill that ran but did not reap the tree was reported as success and the
   * child.kill() fallback never happened. These cases pin the new verdict.
   */
  it("reports success only after the process is actually gone", () => {
    let alive = true;
    let runs = 0;
    const ok = taskkillTree(42, "win32", {
      run: () => {
        runs++;
        if (runs >= 2) alive = false; // second attempt reaps it
      },
      alive: () => alive,
      sleep: () => undefined,
    });
    expect(ok).toBe(true);
    expect(runs).toBe(2);
  });

  it("retries a transient failure (access denied) before giving up", () => {
    let alive = true;
    const slept: number[] = [];
    let runs = 0;
    const denied = (): never => {
      runs++;
      if (runs >= 3) alive = false;
      const e = new Error("Access is denied.") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    const ok = taskkillTree(42, "win32", { run: denied, alive: () => alive, sleep: (ms) => slept.push(ms), delayMs: 10 });
    expect(ok).toBe(true);
    expect(runs).toBe(3);
    expect(slept).toEqual([10, 20]);
  });

  it("distinguishes 'taskkill missing' (false → caller falls back) from 'already gone' (true)", () => {
    const missing = (): never => {
      const e = new Error("spawnSync taskkill ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    // Mechanism unavailable: false, so signalTree falls back to child.kill().
    expect(taskkillTree(42, "win32", { run: missing, alive: () => true, sleep: () => undefined })).toBe(false);
    // Process already gone: true — the tree is reaped even though taskkill erred.
    const gone = (): never => {
      const e = new Error("not found") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    expect(taskkillTree(42, "win32", { run: gone, alive: () => false, sleep: () => undefined })).toBe(true);
  });

  it("gives up after the attempt budget when the process never dies", () => {
    let runs = 0;
    const ok = taskkillTree(42, "win32", { run: () => void runs++, alive: () => true, sleep: () => undefined, attempts: 3 });
    expect(ok).toBe(false);
    expect(runs).toBe(3);
  });
});
