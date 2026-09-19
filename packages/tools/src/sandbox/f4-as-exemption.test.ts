/**
 * F4 step 2a -- the per-call RLIMIT_AS exemption.
 *
 * Chromium reserves an enormous VIRTUAL address space and dies (SIGTRAP/133)
 * under any `--as=` up to 32GiB; `noAddressSpaceLimit` omits ONLY that limit.
 * These tests pin three things mechanically:
 *   1. exempt => no `--as=` / `ulimit -v`;
 *   2. NOT exempt => the argv is byte-identical to the pre-F4 output;
 *   3. exempt => every OTHER limit (cpu/nproc/fsize/nofile/core) is still there.
 * (3) is the guard against "exempt AS" being miswritten as "disable rlimits".
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { POSIX_SHELL } from "../testing/platform-gates.js";
import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig } from "./config.js";
import { DEFAULT_LIMITS, type SandboxLimits } from "./limits.js";
import type { HostProbe } from "./probe.js";
import { applyLimits, rlimitDiagnostics, ulimitScript } from "./rlimit.js";
import { UserspaceSandbox } from "./userspace.js";

const NL = String.fromCharCode(10);
const LIMITS: SandboxLimits = { ...DEFAULT_LIMITS, nproc: 1024 };

function probeWith(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    platform: "linux",
    bwrapPath: "/usr/bin/bwrap",
    bwrapVersion: "bubblewrap 0.11.1\n",
    bwrapUsable: true,
    bwrapRejectReason: null,
    prlimitPath: "/usr/bin/prlimit",
    shellUlimitWorks: true,
    uidThreads: 347,
    ...overrides,
  };
}

function probeFor(dir: string): HostProbe {
  return { ...probeWith(), bwrapPath: join(dir, "fake-bwrap"), prlimitPath: join(dir, "fake-prlimit"), shellUlimitWorks: false };
}

/** A fake prlimit: append "$@" to its own .args file, then exec after --. */
function writeFakePrlimit(dir: string): { path: string; record: string } {
  const path = join(dir, "fake-prlimit");
  writeFileSync(
    path,
    ["#!/bin/sh", 'echo "$@" >> "$0.args"', "while [ $# -gt 0 ]; do", '  if [ "$1" = "--" ]; then shift; break; fi', "  shift", "done", 'exec "$@"', ""].join(NL),
    { mode: 0o755 },
  );
  return { path, record: path + ".args" };
}

/** A fake bwrap: drop flags up to --, then exec the command. */
function writeFakeBwrap(dir: string): string {
  const path = join(dir, "fake-bwrap");
  writeFileSync(
    path,
    ["#!/bin/sh", "while [ $# -gt 0 ]; do", '  if [ "$1" = "--" ]; then shift; break; fi', "  shift", "done", 'exec "$@"', ""].join(NL),
    { mode: 0o755 },
  );
  return path;
}

describe("F4 · applyLimits address-space exemption (pure)", () => {
  it("omits only --as= when exempt, keeping every other limit", () => {
    const plan = applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith(), { noAddressSpaceLimit: true });
    expect(plan.via).toBe("prlimit");
    expect(plan.program).toBe("/usr/bin/prlimit");
    expect(plan.args).toEqual(["--cpu=20", "--nproc=1024", "--fsize=268435456", "--nofile=256", "--core=0", "--", "/usr/bin/bwrap", "--unshare-all"]);
    expect(plan.args.some((arg) => arg.startsWith("--as="))).toBe(false);
  });

  it("keeps the default plan byte-identical when the flag is absent", () => {
    const expected = ["--cpu=20", "--as=2147483648", "--nproc=1024", "--fsize=268435456", "--nofile=256", "--core=0", "--", "/usr/bin/bwrap", "--unshare-all"];
    expect(applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith()).args).toEqual(expected);
    expect(applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith(), true).args).toEqual(expected);
    expect(applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith(), { enabled: true }).args).toEqual(expected);
    expect(applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith(), { noAddressSpaceLimit: false }).args).toEqual(expected);
  });

  it("omits ulimit -v but keeps the other ulimit builtins", () => {
    const plan = applyLimits("/usr/bin/bwrap", [], LIMITS, probeWith({ prlimitPath: null }), { noAddressSpaceLimit: true });
    expect(plan.via).toBe("shell-ulimit");
    const script = plan.args[1]!;
    expect(script).not.toContain("ulimit -v");
    expect(script).toContain("ulimit -t 20");
    expect(script).toContain("ulimit -u 1024");
    expect(script).toContain("ulimit -f 524288");
    expect(script).toContain("ulimit -n 256");
    expect(script).toContain("ulimit -c 0");
    expect(script).toContain('exec "$0" "$@"');
  });

  it("leaves ulimitScript unchanged by default and only drops -v when exempt", () => {
    expect(ulimitScript(LIMITS)).toBe("ulimit -t 20; ulimit -v 2097152; ulimit -u 1024; ulimit -f 524288; ulimit -n 256; ulimit -c 0");
    expect(ulimitScript(LIMITS, true)).toBe("ulimit -t 20; ulimit -u 1024; ulimit -f 524288; ulimit -n 256; ulimit -c 0");
  });

  it("the legacy boolean false still disables every limit", () => {
    const untouched = { program: "/bin/sh", args: ["-c", "true"], via: "none" };
    expect(applyLimits("/bin/sh", ["-c", "true"], LIMITS, probeWith(), false)).toEqual(untouched);
    expect(applyLimits("/bin/sh", ["-c", "true"], LIMITS, probeWith(), { enabled: false, noAddressSpaceLimit: true })).toEqual(untouched);
  });

  it("rlimitDiagnostics makes the exemption observable", () => {
    expect(rlimitDiagnostics(probeWith(), true, false)).toEqual({ via: "prlimit", rlimits_enabled: true, address_space_limited: true });
    expect(rlimitDiagnostics(probeWith(), true, true)).toEqual({ via: "prlimit", rlimits_enabled: true, address_space_limited: false });
    expect(rlimitDiagnostics(probeWith(), false, false)).toEqual({ via: "none", rlimits_enabled: false, address_space_limited: false });
  });
});

describe("F4 · providers pass the flag into the real plan", () => {
  it.skipIf(!POSIX_SHELL)("bwrap: exempted call has no --as=, default call still does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-bwrap-"));
    const prlimit = writeFakePrlimit(dir);
    writeFakeBwrap(dir);
    const sandbox = new BwrapSandbox(buildSandboxConfig({ workdir: dir, root: dir }), { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const plain = await sandbox.run({ command: "true" });
    const exempt = await sandbox.run({ command: "true", noAddressSpaceLimit: true });

    const lines = readFileSync(prlimit.record, "utf8").trim().split(NL);
    expect(lines[0]).toContain("--as=2147483648");
    expect(lines[1]).not.toContain("--as=");
    expect(lines[1]).toContain("--cpu=20");
    expect(lines[1]).toContain("--nproc=1024");
    expect(lines[1]).toContain("--fsize=268435456");
    expect(lines[1]).toContain("--nofile=256");
    expect(lines[1]).toContain("--core=0");
    // The model-visible contract must not grow a new field.
    expect(plain.sandbox).not.toHaveProperty("address_space_limited");
    expect(exempt.sandbox).not.toHaveProperty("address_space_limited");
  });

  it.skipIf(!POSIX_SHELL)("userspace: exempted call has no --as=, default call still does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-user-"));
    const prlimit = writeFakePrlimit(dir);
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: dir, root: dir }), { probe: probeFor(dir), limits: LIMITS, rlimits: true });

    const plain = await sandbox.run({ command: "true" });
    const exempt = await sandbox.run({ command: "true", noAddressSpaceLimit: true });

    const lines = readFileSync(prlimit.record, "utf8").trim().split(NL);
    expect(lines[0]).toContain("--as=2147483648");
    expect(lines[1]).not.toContain("--as=");
    expect(lines[1]).toContain("--cpu=20");
    expect(plain.sandbox).not.toHaveProperty("address_space_limited");
    expect(exempt.sandbox).not.toHaveProperty("address_space_limited");
  });
});

describe("F4 · describe() is the diagnostic path", () => {
  it("bwrap: reports whether AS is limited, per requested posture", () => {
    const sandbox = new BwrapSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: true });
    expect(sandbox.describe().address_space_limited).toBe(true);
    expect(sandbox.describe({ noAddressSpaceLimit: true }).address_space_limited).toBe(false);
    expect(sandbox.describe({ noAddressSpaceLimit: true }).rlimit_via).toBe("prlimit");
  });

  it("userspace: reports whether AS is limited, per requested posture", () => {
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: true });
    expect(sandbox.describe().address_space_limited).toBe(true);
    expect(sandbox.describe({ noAddressSpaceLimit: true }).address_space_limited).toBe(false);
  });

  it("with every rlimit disabled, AS is reported unlimited in both postures", () => {
    const bwrap = new BwrapSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: false });
    expect(bwrap.describe().address_space_limited).toBe(false);
    const userspace = new UserspaceSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: false });
    expect(userspace.describe().address_space_limited).toBe(false);
  });

  /**
   * W891: on a host with NO rlimit mechanism (Windows, or a bare Linux without
   * prlimit and without shell ulimit) the userspace fallback still RUNS, but the
   * degradation must be a fact on the diagnostic result — before this the only
   * trace was a stderr line nobody parses.
   */
  it("userspace: rlimits_applied is false when the host has no mechanism", () => {
    const bare = probeWith({ prlimitPath: null, shellUlimitWorks: false });
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: bare, limits: LIMITS, rlimits: true });
    expect(sandbox.describe().rlimit_via).toBe("none");
    expect(sandbox.describe().rlimits_applied).toBe(false);
  });

  it("userspace: rlimits_applied is true when a mechanism exists", () => {
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: true });
    expect(sandbox.describe().rlimits_applied).toBe(true);
  });

  it("userspace: rlimits_applied is false when the operator disabled limits", () => {
    const sandbox = new UserspaceSandbox(buildSandboxConfig({ workdir: "/tmp", root: "/tmp" }), { probe: probeWith(), limits: LIMITS, rlimits: false });
    expect(sandbox.describe().rlimits_applied).toBe(false);
  });
});
