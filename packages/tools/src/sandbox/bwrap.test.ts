/**
 * Provider-level unit tests: the argv contract, the seccomp blob, the
 * fail-closed policy. Nothing here spawns bwrap — the machine-dependent proofs
 * live in `bwrap-live.test.ts`.
 */

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { isSandboxError } from "@celestea/core";

import {
  BWRAP_PROVIDER,
  buildBwrapArgv,
  buildBwrapCommand,
  bwrapLabel,
  bwrapMeta,
  DEFAULT_BWRAP_OPTIONS,
  SECCOMP_FD,
  type BwrapOptions,
} from "./bwrap-argv.js";
import { BwrapSandbox } from "./bwrap.js";
import { buildSandboxConfig } from "./config.js";
import { BwrapSandbox as SandboxClass } from "./bwrap.js";
import { ENV_SANDBOX_FALLBACK, bwrapOptionsFromEnv, fallbackMode, selectSandboxDetailed } from "./provider.js";
import { UserspaceSandbox } from "./userspace.js";
import { buildSeccompFilter, instructionCount, openSeccompBlob, toBlobBytes } from "./seccomp.js";
import type { HostProbe } from "./probe.js";

const WORK = "/src/celestea_studio-ts";

function opts(overrides: Partial<BwrapOptions> = {}): BwrapOptions {
  return { ...DEFAULT_BWRAP_OPTIONS, ...overrides };
}

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

function config() {
  return buildSandboxConfig({ workdir: WORK, root: WORK, timeoutMs: 5_000, maxTimeoutMs: 10_000 });
}

describe("buildBwrapArgv — mount order is the W274 fix", () => {
  it("emits --unshare-all, then --ro-bind / /, --dev /dev, --proc /proc", () => {
    expect(buildBwrapArgv(WORK, opts()).slice(0, 9)).toEqual([
      "--unshare-all",
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ]);
  });

  it("keeps the read-only host root BEFORE the private devtmpfs (regression)", () => {
    const argv = buildBwrapArgv(WORK, opts({ shareTmp: true, shareNet: true, seccomp: true, maskDirs: ["/home"] }));
    const index = (flag: string): number => argv.indexOf(flag);
    expect(index("--ro-bind")).toBeLessThan(index("--dev"));
    expect(index("--dev")).toBeLessThan(index("--proc"));
    expect(index("--ro-bind")).toBeLessThan(index("--tmpfs")); // first tmpfs = /tmp or a mask
  });

  it("always carries --die-with-parent, whatever the options", () => {
    for (const shareNet of [false, true]) {
      for (const shareTmp of [false, true]) {
        for (const seccomp of [false, true]) {
          const argv = buildBwrapArgv(WORK, opts({ shareNet, shareTmp, seccomp }));
          expect(argv).toContain("--die-with-parent");
        }
      }
    }
  });

  it("isolates the network by default and shares it only on request", () => {
    expect(buildBwrapArgv(WORK, opts())).not.toContain("--share-net");
    expect(buildBwrapArgv(WORK, opts({ shareNet: true }))).toContain("--share-net");
  });

  it("gives /tmp a private tmpfs by default and binds the host /tmp on request", () => {
    const isolated = buildBwrapArgv(WORK, opts());
    expect(isolated.slice(isolated.indexOf("--tmpfs"))).toEqual(["--tmpfs", "/tmp", "--bind", WORK, WORK, "--chdir", WORK]);
    expect(buildBwrapArgv(WORK, opts({ shareTmp: true }))).not.toContain("--tmpfs");
  });

  it("binds and chdirs the workdir, and masks opt-in directories", () => {
    const argv = buildBwrapArgv(WORK, opts({ maskDirs: ["/home", "/root"] }));
    expect(argv.slice(-9)).toEqual([
      "--tmpfs",
      "/home",
      "--tmpfs",
      "/root",
      "--bind",
      WORK,
      WORK,
      "--chdir",
      WORK,
    ]);
    // the /tmp tmpfs comes first, the masks after it, the workdir bind last.
    expect(argv.indexOf("--bind")).toBeGreaterThan(argv.indexOf("--tmpfs", argv.indexOf("--tmpfs") + 1));
  });

  it("omits the workdir bind for the probe shape (workdir = null)", () => {
    const argv = buildBwrapArgv(null, opts());
    expect(argv).not.toContain("--bind");
    expect(argv).not.toContain("--chdir");
  });

  it("hands the seccomp blob to fd 3 and terminates the flag list with --", () => {
    const argv = buildBwrapCommand(WORK, opts({ seccomp: true }), "echo hi");
    expect(argv.slice(-6)).toEqual(["--seccomp", String(SECCOMP_FD), "--", "/bin/sh", "-c", "echo hi"]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", "echo hi"]);
    expect(SECCOMP_FD).toBe(3);
  });
});

describe("bwrapMeta", () => {
  it("reports the effective isolation instead of the requested one", () => {
    expect(bwrapMeta(opts())).toEqual({
      provider: BWRAP_PROVIDER,
      net_isolated: true,
      tmp_private: true,
      seccomp: false,
    });
    expect(bwrapMeta(opts({ shareNet: true, shareTmp: true, seccomp: true }))).toEqual({
      provider: "bwrap",
      net_isolated: false,
      tmp_private: false,
      seccomp: true,
    });
  });

  it("labels the isolation for spawn failures", () => {
    expect(bwrapLabel(opts())).toBe("bwrap[net-isolated,private-tmp]");
    expect(bwrapLabel(opts({ shareNet: true, shareTmp: true, seccomp: true, maskDirs: ["/home"] }))).toBe(
      "bwrap[share-net,host-tmp,seccomp,masked=1]",
    );
  });
});

describe("seccomp filter (pure TS cBPF)", () => {
  it("matches the engine instruction stream size", () => {
    expect(instructionCount()).toBe(322);
    expect(toBlobBytes().length).toBe(322 * 8);
  });

  it("serializes little-endian words with the engine's header and tail", () => {
    const blob = toBlobBytes();
    expect(blob.subarray(0, 8).toString("hex")).toBe("2000000004000000"); // LD arch
    expect(blob.subarray(8, 16).toString("hex")).toBe("150000023e0000c0"); // JEQ AUDIT_ARCH_X86_64
    expect(blob.subarray(-24, -16).toString("hex")).toBe("15000001b3010000"); // JEQ clone3
    expect(blob.subarray(-16, -8).toString("hex")).toBe("0600000026000500"); // RET ENOSYS
    expect(blob.subarray(-8).toString("hex")).toBe("0600000001000500"); // RET EPERM
    expect(buildSeccompFilter()[4]?.k).toBe(0x0005_0001);
  });

  it("materializes a readable blob file and cleans it up", () => {
    const handle = openSeccompBlob();
    const path = readFileSync(`/proc/self/fd/${handle.fd}`).length;
    expect(path).toBe(322 * 8);
    handle.dispose();
    expect(existsSync(`/proc/self/fd/${handle.fd}`)).toBe(false);
  });
});

describe("provider policy (fail-closed)", () => {
  it("selects bwrap when the probe says it is usable", () => {
    const selection = selectSandboxDetailed({ env: {}, config: config(), probe: probeWith() });
    expect(selection.provider).toBe("bwrap");
    expect(selection.degraded).toBe(false);
    expect(selection.reason).toBeNull();
    expect(selection.sandbox).toBeInstanceOf(SandboxClass);
    expect((selection.sandbox as BwrapSandbox).limits.nproc).toBeGreaterThan(347);
  });

  it("degrades to userspace by default — visibly", () => {
    const selection = selectSandboxDetailed({ env: {}, config: config(), probe: probeWith({ bwrapUsable: false, bwrapRejectReason: "injected: no bwrap" }) });
    expect(selection.sandbox).toBeInstanceOf(UserspaceSandbox);
    expect(selection.degraded).toBe(true);
    expect(selection.reason).toBe("injected: no bwrap");
    expect(selection.mode).toBe("userspace");
  });

  it("refuses to run at all when CELESTEA_SANDBOX_FALLBACK=fail", () => {
    const env = { [ENV_SANDBOX_FALLBACK]: "fail" };
    try {
      selectSandboxDetailed({ env, config: config(), probe: probeWith({ bwrapUsable: false, bwrapRejectReason: "injected" }) });
      expect.unreachable("fail mode must not degrade silently");
    } catch (error) {
      expect(isSandboxError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe("config");
      expect(String((error as Error).message)).toContain("sandbox_unavailable");
      expect(String((error as Error).message)).toContain("fail");
    }
  });

  it("rejects an unknown fallback value instead of picking a posture", () => {
    expect(() => fallbackMode({ [ENV_SANDBOX_FALLBACK]: "nope" })).toThrowError(/invalid CELESTEA_SANDBOX_FALLBACK/);
    expect(fallbackMode({ [ENV_SANDBOX_FALLBACK]: " FAIL " })).toBe("fail");
  });

  it("re-checked at call time: a bwrap that vanished is refused, not silently degraded", async () => {
    const sandbox = new BwrapSandbox(config(), { probe: probeWith({ bwrapUsable: false, bwrapRejectReason: "binary removed" }) });
    await expect(sandbox.run({ command: "true" })).rejects.toThrowError(/sandbox_unavailable/);
    expect(() => sandbox.describe()).not.toThrow();
  });
});

describe("bwrapOptionsFromEnv", () => {
  it("maps the contract env vocabulary onto bwrap flags", () => {
    expect(bwrapOptionsFromEnv({})).toEqual(DEFAULT_BWRAP_OPTIONS);
    expect(
      bwrapOptionsFromEnv({
        CELESTEA_SANDBOX_NET: "1",
        CELESTEA_SANDBOX_SHARE_TMP: "true",
        CELESTEA_SANDBOX_SECCOMP: "on",
        CELESTEA_SANDBOX_MASK: "/home, /root ,",
      }),
    ).toEqual({ shareNet: true, shareTmp: true, seccomp: true, maskDirs: ["/home", "/root"] });
  });

  it("rejects a mask entry that would mask the whole root", () => {
    expect(() => bwrapOptionsFromEnv({ CELESTEA_SANDBOX_MASK: "/" })).toThrowError(/invalid CELESTEA_SANDBOX_MASK/);
    expect(() => bwrapOptionsFromEnv({ CELESTEA_SANDBOX_MASK: "home" })).toThrowError(/invalid CELESTEA_SANDBOX_MASK/);
  });
});
