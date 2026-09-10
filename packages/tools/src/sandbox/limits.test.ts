/**
 * `RLIMIT_NPROC` derivation + the rlimit layer (W274 §3.2 is the reason this
 * file exists: a static 512 is a time bomb on a busy UID).
 */

import { describe, expect, it } from "vitest";
import { isSandboxError } from "@celestea/core";

import {
  countUidThreads,
  DEFAULT_LIMITS,
  deriveNproc,
  ENV_SANDBOX_NPROC,
  ENV_SANDBOX_NPROC_HEADROOM,
  limitsFromEnv,
  NPROC_FLOOR,
  NPROC_HEADROOM,
  type SandboxLimits,
} from "./limits.js";
import { applyLimits, ulimitScript } from "./rlimit.js";
import type { HostProbe } from "./probe.js";

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

describe("deriveNproc", () => {
  it("adds the headroom to the measured UID thread count", () => {
    expect(deriveNproc(900)).toBe(900 + NPROC_HEADROOM);
    expect(deriveNproc(5000)).toBe(5512);
    // Below the floor the floor wins: this host measured 347 threads, and
    // 347 + 512 = 859 still leaves less slack than the floor grants.
    expect(deriveNproc(347)).toBe(NPROC_FLOOR);
  });

  it("never drops below the floor — including when the count is unknown", () => {
    expect(deriveNproc(null)).toBe(NPROC_FLOOR);
    expect(deriveNproc(0)).toBe(NPROC_FLOOR);
    expect(deriveNproc(1)).toBe(NPROC_FLOOR);
  });

  it("stays strictly above a busy UID (the W274 failure mode)", () => {
    // nproc <= threads makes bwrap unable to fork its own pid 1 (EAGAIN).
    for (const threads of [347, 900, 1000, 1200]) expect(deriveNproc(threads)).toBeGreaterThan(threads);
  });
});

describe("countUidThreads", () => {
  it("counts the current UID's threads on this host", () => {
    const threads = countUidThreads();
    if (process.platform === "linux") {
      expect(threads).not.toBeNull();
      expect(threads as number).toBeGreaterThan(0);
    } else {
      expect(threads).toBeNull();
    }
  });

  it("returns null for an unknown UID and for a missing /proc", () => {
    expect(countUidThreads(2_147_483_646)).toBeNull();
    expect(countUidThreads(process.getuid?.() ?? 0, "/proc-does-not-exist")).toBeNull();
    expect(countUidThreads(null)).toBeNull();
  });
});

describe("limitsFromEnv", () => {
  it("derives nproc and keeps the engine defaults for everything else", () => {
    const limits = limitsFromEnv({}, 347);
    expect(limits).toEqual({ ...DEFAULT_LIMITS, nproc: NPROC_FLOOR });
  });

  it("honours the explicit nproc override and a custom headroom", () => {
    expect(limitsFromEnv({ [ENV_SANDBOX_NPROC]: "4096" }, 347).nproc).toBe(4096);
    expect(limitsFromEnv({ [ENV_SANDBOX_NPROC_HEADROOM]: "100" }, 5000).nproc).toBe(5100);
    expect(limitsFromEnv({ [ENV_SANDBOX_NPROC]: "0" }, 347).nproc).toBe(NPROC_FLOOR);
  });
});

describe("applyLimits", () => {
  it("wraps with prlimit when the binary exists", () => {
    const plan = applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith());
    expect(plan.via).toBe("prlimit");
    expect(plan.program).toBe("/usr/bin/prlimit");
    expect(plan.args).toEqual([
      "--cpu=20",
      "--as=2147483648",
      "--nproc=1024",
      "--fsize=268435456",
      "--nofile=256",
      "--core=0",
      "--",
      "/usr/bin/bwrap",
      "--unshare-all",
    ]);
  });

  it("falls back to the shell ulimit builtins without prlimit", () => {
    const plan = applyLimits("/usr/bin/bwrap", ["--unshare-all"], LIMITS, probeWith({ prlimitPath: null }));
    expect(plan.via).toBe("shell-ulimit");
    expect(plan.program).toBe("/bin/sh");
    expect(plan.args[0]).toBe("-c");
    expect(plan.args[1]).toContain(ulimitScript(LIMITS));
    expect(plan.args.slice(2)).toEqual(["/usr/bin/bwrap", "--unshare-all"]);
  });

  it("refuses to run when no rlimit mechanism is available", () => {
    try {
      applyLimits("/usr/bin/bwrap", [], LIMITS, probeWith({ prlimitPath: null, shellUlimitWorks: false }));
      expect.unreachable("expected a structured failure");
    } catch (error) {
      expect(isSandboxError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe("config");
    }
  });

  it("leaves the command untouched when rlimits are disabled", () => {
    const plan = applyLimits("/bin/sh", ["-c", "true"], LIMITS, probeWith(), false);
    expect(plan).toEqual({ program: "/bin/sh", args: ["-c", "true"], via: "none" });
  });
});

describe("ulimitScript", () => {
  it("expresses every limit as a shell builtin call", () => {
    expect(ulimitScript(LIMITS)).toBe(
      "ulimit -t 20; ulimit -v 2097152; ulimit -u 1024; ulimit -f 262144; ulimit -n 256; ulimit -c 0",
    );
  });
});
