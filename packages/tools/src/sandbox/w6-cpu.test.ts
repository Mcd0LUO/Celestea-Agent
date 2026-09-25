/**
 * W6 + W1516: the effective `RLIMIT_CPU` of a call.
 *
 * W6 established that a per-call `cpu_sec` reaches the rlimit plan on BOTH
 * providers and is clamped to the env cap. W1516 (`docs/feature-sandbox-time-semantics.md`
 * §3.1) made the DEFAULT follow the call's wall clock instead of a fixed 20s:
 *
 *   cpuSec = clamp(ceil(wallClockMs/1000) + CPU_GRACE_SEC, 1, maxCpuSec)
 *
 * so the three sources are explicit `cpu_sec` > the foreground wall clock >
 * `maxCpuSec` (background only — it has no call-level wall clock). A fake
 * `prlimit` records the argv actually used, which is what A1/A2 assert.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { POSIX_SHELL } from "../testing/platform-gates.js";
import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig, DEFAULT_TIMEOUT_MS } from "./config.js";
import {
  CPU_GRACE_SEC,
  DEFAULT_LIMITS,
  deriveCpuSecFromWallClock,
  resolveCallCpuSec,
  resolveCpuSec,
  type SandboxLimits,
} from "./limits.js";
import type { HostProbe } from "./probe.js";
import { UserspaceSandbox } from "./userspace.js";

const NL = String.fromCharCode(10);
const LIMITS: SandboxLimits = { ...DEFAULT_LIMITS, nproc: 1024 };

function probeFor(dir: string): HostProbe {
  return {
    platform: "linux",
    bwrapPath: join(dir, "fake-bwrap"),
    bwrapVersion: "fake",
    bwrapUsable: true,
    bwrapRejectReason: null,
    prlimitPath: join(dir, "fake-prlimit"),
    shellUlimitWorks: false,
    uidThreads: 347,
  };
}

/** A fake prlimit: append "$@" to its own .args file, then exec after --. */
function writeFakePrlimit(dir: string): { path: string; record: string } {
  const path = join(dir, "fake-prlimit");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'echo "$@" >> "$0.args"',
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--" ]; then shift; break; fi',
      "  shift",
      "done",
      'exec "$@"',
      "",
    ].join(NL),
    { mode: 0o755 },
  );
  return { path, record: path + ".args" };
}

/** A fake bwrap: drop flags up to --, then exec the command. */
function writeFakeBwrap(dir: string): string {
  const path = join(dir, "fake-bwrap");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "while [ $# -gt 0 ]; do",
      '  if [ "$1" = "--" ]; then shift; break; fi',
      "  shift",
      "done",
      'exec "$@"',
      "",
    ].join(NL),
    { mode: 0o755 },
  );
  return path;
}

/**
 * Wait for the fake `prlimit` to have recorded `needle`.
 *
 * `spawn` resolves on the child's `spawn` event, NOT after the wrapper script has
 * run, so the record file is written asynchronously after the call returns —
 * reading it immediately is a race (it really did fail with ENOENT). Bounded poll
 * instead of a fixed sleep, so a broken plan fails fast rather than flaking.
 */
async function waitForRecord(record: string, needle: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(record, "utf8");
    } catch {
      text = "";
    }
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) {
      throw new Error(`the fake prlimit never recorded '${needle}' (record so far: ${JSON.stringify(text)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("W6 per-call cpu_sec", () => {
  it("clamps above the cap, keeps the base, and reports the request (unit)", () => {
    expect(resolveCpuSec(20, undefined, 600)).toEqual({ cpuSec: 20, clamped: false, requested: null });
    expect(resolveCpuSec(20, 7, 600)).toEqual({ cpuSec: 7, clamped: false, requested: 7 });
    expect(resolveCpuSec(20, 9999, 600)).toEqual({ cpuSec: 600, clamped: true, requested: 9999 });
  });

  // W885: the fake prlimit/bwrap are `#!/bin/sh` scripts — a POSIX host only.
  it.skipIf(!POSIX_SHELL)("bwrap: the per-call cpu enters the prlimit plan and the meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-bwrap-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 600 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const out = await sandbox.run({ command: "true", cpuSec: 7 });

    expect(out.exit_code).toBe(0);
    expect(readFileSync(prlimit.record, "utf8")).toContain("--cpu=7");
    expect(out.sandbox.cpu_sec).toBe(7);
  });

  it.skipIf(!POSIX_SHELL)("bwrap: the default follows the wall clock and above-cap is clamped to the env cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-bwrap-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 50 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    await sandbox.run({ command: "true" });
    await sandbox.run({ command: "true", cpuSec: 9999 });

    const record = readFileSync(prlimit.record, "utf8");
    // The effective wall clock here is `config.timeoutMs` (30s), so the derived
    // limit is ceil(30000/1000) + 5 = 35 — NOT the old fixed 20.
    expect(record).toContain(`--cpu=${deriveCpuSecFromWallClock(DEFAULT_TIMEOUT_MS, 50)}`);
    expect(record).toContain("--cpu=35");
    expect(record).toContain("--cpu=50");
  });

  it.skipIf(!POSIX_SHELL)("userspace: the per-call cpu enters the prlimit plan too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-user-"));
    const prlimit = writeFakePrlimit(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 600 });
    const sandbox = new UserspaceSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const out = await sandbox.run({ command: "true", cpuSec: 9 });

    expect(out.exit_code).toBe(0);
    expect(readFileSync(prlimit.record, "utf8")).toContain("--cpu=9");
    expect(out.sandbox.cpu_sec).toBe(9);
  });
});

/**
 * W1516 A1/A2 (pure): the derivation rule and the three sources, with no
 * process involved. `resolveCallCpuSec` is the single place the rule lives, so
 * these cases pin the arithmetic the providers then hand to `prlimit`.
 */
describe("W1516 §3.1 the derivation rule", () => {
  it("A1: derives ceil(wallClock/1000) + CPU_GRACE_SEC, clamped to maxCpuSec", () => {
    expect(CPU_GRACE_SEC).toBe(5);
    // The grace exists so the WALL CLOCK fires first (the honest code=timeout).
    expect(deriveCpuSecFromWallClock(30_000, 600)).toBe(35);
    expect(deriveCpuSecFromWallClock(120_000, 600)).toBe(125);
    // ceil, not floor: a 30.5s deadline must not round the CPU budget down.
    expect(deriveCpuSecFromWallClock(30_500, 600)).toBe(36);
    expect(deriveCpuSecFromWallClock(1, 600)).toBe(6);
    // The deployer ceiling always wins.
    expect(deriveCpuSecFromWallClock(120_000, 60)).toBe(60);
    // Never below 1, even for a misconfigured ceiling.
    expect(deriveCpuSecFromWallClock(0, 0)).toBe(1);
  });

  it("A1: a foreground call with no cpu_sec uses the derived value (source wall-clock)", () => {
    const call = { requested: undefined, maxCpuSec: 600, wallClockMs: 30_000 };
    expect(resolveCallCpuSec(call)).toEqual({ cpuSec: 35, clamped: false, requested: null, source: "wall-clock" });
  });

  it("A2: an explicit cpu_sec wins over the derivation and is still clamped", () => {
    // Explicit wins, even when it is far below what the wall clock would give.
    expect(resolveCallCpuSec({ requested: 7, maxCpuSec: 600, wallClockMs: 120_000 })).toEqual({
      cpuSec: 7,
      clamped: false,
      requested: 7,
      source: "explicit",
    });
    // Above the ceiling: CLAMPED (reported), never an error.
    expect(resolveCallCpuSec({ requested: 9999, maxCpuSec: 600, wallClockMs: 120_000 })).toEqual({
      cpuSec: 600,
      clamped: true,
      requested: 9999,
      source: "explicit",
    });
  });

  it("A8 (rule): a background call with no cpu_sec defaults to maxCpuSec", () => {
    // `wallClockMs: null` is how "there is no call-level wall clock" is expressed.
    expect(resolveCallCpuSec({ requested: undefined, maxCpuSec: 600, wallClockMs: null })).toEqual({
      cpuSec: 600,
      clamped: false,
      requested: null,
      source: "background",
    });
    // An explicit cpu_sec still wins for a background process too.
    expect(resolveCallCpuSec({ requested: 9, maxCpuSec: 600, wallClockMs: null })).toEqual({
      cpuSec: 9,
      clamped: false,
      requested: 9,
      source: "explicit",
    });
    // ...and is still clamped to the deployer's ceiling.
    expect(resolveCallCpuSec({ requested: 9999, maxCpuSec: 60, wallClockMs: null }).cpuSec).toBe(60);
  });
});

/**
 * W1516 A1/A8 on the REAL plan: the fake `prlimit` records what the provider
 * actually built, so these prove the derivation is wired into `run`/`spawn` and
 * not merely available as a function.
 */
describe("W1516 A1/A8 through the providers", () => {
  it.skipIf(!POSIX_SHELL)("A1: a foreground call with an explicit timeout_ms derives from THAT value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w1516-fore-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, timeoutMs: 30_000, maxTimeoutMs: 300_000, maxCpuSec: 600 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    // 90s wall clock -> ceil(90) + 5 = 95, NOT the config default's 35 and not 20.
    const out = await sandbox.run({ command: "true", timeoutMs: 90_000 });

    expect(out.sandbox.cpu_sec).toBe(95);
    expect(readFileSync(prlimit.record, "utf8")).toContain("--cpu=95");
  });

  it.skipIf(!POSIX_SHELL)("A8: spawn with no cpu_sec gets config.maxCpuSec, not 20", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w1516-bg-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 600 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const spawned = await sandbox.spawn({ command: "true" });

    expect(spawned.sandbox.cpu_sec).toBe(600);
    expect(await waitForRecord(prlimit.record, "--cpu=600")).toContain("--cpu=600");
    spawned.child.kill();
  });

  it.skipIf(!POSIX_SHELL)("A8: spawn still honours an explicit cpu_sec, clamped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w1516-bg2-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 60 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const explicit = await sandbox.spawn({ command: "true", cpuSec: 9 });
    const clamped = await sandbox.spawn({ command: "true", cpuSec: 9999 });

    const record = await waitForRecord(prlimit.record, "--cpu=60");
    expect(record).toContain("--cpu=9");
    expect(record).toContain("--cpu=60");
    expect(explicit.sandbox.cpu_sec).toBe(9);
    expect(clamped.sandbox.cpu_sec).toBe(60);
    explicit.child.kill();
    clamped.child.kill();
  });

  it.skipIf(!POSIX_SHELL)("A8: userspace spawn also defaults to maxCpuSec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w1516-bgu-"));
    const prlimit = writeFakePrlimit(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 600 });
    const sandbox = new UserspaceSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const spawned = await sandbox.spawn({ command: "true" });

    expect(spawned.sandbox.cpu_sec).toBe(600);
    expect(await waitForRecord(prlimit.record, "--cpu=600")).toContain("--cpu=600");
    spawned.child.kill();
  });
});
