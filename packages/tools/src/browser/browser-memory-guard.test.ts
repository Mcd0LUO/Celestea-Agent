/**
 * F4 step 2b -- the memory backstop.
 *
 * The host's cgroup v2 hierarchy is read-only (measured: mkdir -> EACCES), so
 * the RSS watchdog is the backstop that actually arms in production. Both paths
 * are pinned here with injected readers/killers (no real memory is allocated).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { armMemoryGuard, readOwnCgroupPath, readTreeRssKb } from "./memory-guard.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("F4b memory guard", () => {
  it("uses cgroup v2 memory.max when the hierarchy is writable", () => {
    const root = mkdtempSync(join(tmpdir(), "f4b-cg-"));
    mkdirSync(join(root, "test.slice"));
    const guard = armMemoryGuard({ pid: 4242, limitMb: 128, cgroupRoot: root, cgroupPath: "test.slice" });
    expect(guard.status().kind).toBe("cgroup-v2");
    expect(guard.status().limit_mb).toBe(128);
    expect(guard.status().detail).toContain("memory.max=128MiB");
    expect(existsSync(join(root, "test.slice", "celestea-browser-4242", "memory.max"))).toBe(true);
    guard.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to a bounded RSS watchdog when cgroup v2 is not writable", async () => {
    let killed = 0;
    const guard = armMemoryGuard({
      pid: 4242,
      limitMb: 100,
      cgroupRoot: "/proc/does-not-exist",
      readRssKb: () => 200 * 1024,
      killTree: () => {
        killed += 1;
      },
      intervalMs: 5,
    });
    expect(guard.status().kind).toBe("rss-watchdog");
    await sleep(40);
    expect(killed).toBe(1);
    expect(guard.status().killed).toBe(true);
    guard.dispose();
  });

  it("never kills while the tree stays under the cap", async () => {
    let killed = 0;
    const guard = armMemoryGuard({
      pid: 4242,
      limitMb: 100,
      cgroupRoot: "/proc/does-not-exist",
      readRssKb: () => 10 * 1024,
      killTree: () => {
        killed += 1;
      },
      intervalMs: 5,
    });
    await sleep(30);
    expect(killed).toBe(0);
    expect(guard.status().killed).toBe(false);
    guard.dispose();
  });

  it("reports 'none' when there is no pid to watch", () => {
    const guard = armMemoryGuard({ pid: null, limitMb: 100 });
    expect(guard.status().kind).toBe("none");
    expect(guard.status().detail.length).toBeGreaterThan(0);
  });

  it("reads the real RSS of this process tree", (ctx) => {
    // W891: /proc is Linux-only; a silent `return` would count as PASSED, so
    // make the host limit a VISIBLE skip instead.
    if (process.platform !== "linux") {
      ctx.skip("VmRSS is read from /proc (Linux only)");
      return;
    }
    const kb = readTreeRssKb(process.pid);
    expect(kb).not.toBeNull();
    expect(kb as number).toBeGreaterThan(0);
  });

  it("reads this process's own cgroup path on Linux", (ctx) => {
    if (process.platform !== "linux") {
      ctx.skip("cgroup path is read from /proc/self/cgroup (Linux only)");
      return;
    }
    const path = readOwnCgroupPath();
    expect(typeof path).toBe("string");
    expect(path as string).toContain("/");
  });
});
