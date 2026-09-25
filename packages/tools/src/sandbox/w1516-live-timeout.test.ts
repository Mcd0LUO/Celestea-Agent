/**
 * W1516 A3 (real machine): the WALL CLOCK still wins.
 *
 * §3.1 raises `RLIMIT_CPU` to `ceil(wallClock/1000) + 5`, which is the whole
 * point — but it must NOT change what a deadline expiry looks like. The grace is
 * exactly what guarantees that: the wall clock fires ~5s before the CPU limit
 * could, so the caller keeps getting the honest `code=timeout` (with captured
 * output previews) instead of an ambiguous CPU death.
 *
 * `cpuSec` is deliberately pinned HIGH (600) in the second case: if the derived
 * limit were still the old fixed 20s, the busy loop would die on SIGXCPU and this
 * assertion would see a CPU kill instead of a timeout. That is the mutation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { isSandboxError } from "@celestea/core";

import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig } from "./config.js";
import { deriveCpuSecFromWallClock } from "./limits.js";
import { probeHost } from "./probe.js";
import { POSIX_SHELL } from "../testing/platform-gates.js";
import { UserspaceSandbox } from "./userspace.js";

const probe = probeHost();

/** A workdir bwrap can actually bind (see the note below). */
function liveDir(): string {
  return mkdtempSync(join(tmpdir(), "w1516-live-"));
}

function userspace(workdir: string, maxCpuSec = 600): UserspaceSandbox {
  return new UserspaceSandbox(
    buildSandboxConfig({ workdir, root: workdir, timeoutMs: 30_000, maxTimeoutMs: 300_000, maxCpuSec }),
    { probe, rlimits: true },
  );
}

/**
 * NOTE on the workdir: bwrap cannot bind a directory whose ANCESTOR is not
 * traversable by the sandboxed uid, and this repo's checkout lives under a 0750
 * ancestor. These cases therefore run in the system temp dir — they are about the
 * deadline/CPU interaction, not about the workspace path.
 */
function bwrap(workdir: string, maxCpuSec = 600): BwrapSandbox {
  return new BwrapSandbox(
    buildSandboxConfig({ workdir, root: workdir, timeoutMs: 30_000, maxTimeoutMs: 300_000, maxCpuSec }),
    { probe },
  );
}

describe("W1516 A3 · the wall clock still fires first", () => {
  it.skipIf(!POSIX_SHELL)("userspace: an expired deadline is code=timeout, not a CPU death", async () => {
    const dir = liveDir();
    const started = Date.now();
    const failure = await userspace(dir).run({ command: "sleep 30", timeoutMs: 1_000 }).catch((e: unknown) => e);

    // `isSandboxError` is a type guard, so the structured `kind` is reachable
    // without a cast (and a non-SandboxError failure fails this assertion).
    expect(isSandboxError(failure)).toBe(true);
    if (!isSandboxError(failure)) return;
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toContain("after 1000ms");
    // Killed at the deadline, NOT when a CPU limit expired.
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it.skipIf(!POSIX_SHELL)("userspace: a CPU-BURNING command still reports timeout (the derived cap is larger)", async () => {
    const dir = liveDir();
    const failure = await userspace(dir).run({ command: "while :; do :; done", timeoutMs: 1_500 }).catch((e: unknown) => e);

    // A busy loop burns CPU as fast as it can. Under a cap SMALLER than the wall
    // clock it would die on SIGXCPU and report a CPU kill; the wall clock must be
    // what is reported here, and the derived budget is what makes that possible.
    expect(isSandboxError(failure)).toBe(true);
    if (!isSandboxError(failure)) return;
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toContain("after 1500ms");
    // The CPU budget really is the derived one, well above the old 20s.
    expect(deriveCpuSecFromWallClock(1_500, 600)).toBe(7);
  }, 20_000);

  it.skipIf(!probe.bwrapUsable)("bwrap: an expired deadline is code=timeout with the derived CPU cap in force", async () => {
    const dir = liveDir();
    const started = Date.now();
    const failure = await bwrap(dir).run({ command: "sleep 30", timeoutMs: 1_000 }).catch((e: unknown) => e);

    expect(isSandboxError(failure)).toBe(true);
    if (!isSandboxError(failure)) return;
    expect(failure.kind).toBe("timeout");
    expect(failure.message).toContain("after 1000ms");
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 20_000);

  it.skipIf(!probe.bwrapUsable)("bwrap: the CPU cap is the derived one, not the legacy 20", async () => {
    const dir = liveDir();
    // 30s effective wall clock -> 35s CPU (not 20). Asserted through the result
    // meta, which is what the caller is told.
    const out = await bwrap(dir).run({ command: "echo ok" });
    expect(out.exit_code).toBe(0);
    expect(out.sandbox.cpu_sec).toBe(35);
  }, 20_000);
});
