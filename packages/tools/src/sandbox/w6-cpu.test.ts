/**
 * W6: per-call cpu_sec reaches the rlimit plan on BOTH providers, is clamped to
 * the env cap, and the default (20s) is unchanged. A fake prlimit records argv.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { POSIX_SHELL } from "../testing/platform-gates.js";
import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig } from "./config.js";
import { DEFAULT_LIMITS, resolveCpuSec, type SandboxLimits } from "./limits.js";
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

describe("W6 per-call cpu_sec", () => {
  it("clamps above the cap, keeps the default, and reports the request (unit)", () => {
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

  it.skipIf(!POSIX_SHELL)("bwrap: the default stays 20 and above-cap is clamped to the env cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-bwrap-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const config = buildSandboxConfig({ workdir: dir, root: dir, maxCpuSec: 50 });
    const sandbox = new BwrapSandbox(config, { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    await sandbox.run({ command: "true" });
    await sandbox.run({ command: "true", cpuSec: 9999 });

    const record = readFileSync(prlimit.record, "utf8");
    expect(record).toContain("--cpu=20");
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
