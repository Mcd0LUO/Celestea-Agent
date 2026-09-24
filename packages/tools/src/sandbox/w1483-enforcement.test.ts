/**
 * W1483 - the enforcement declaration, asserted where it is CONSUMED.
 *
 * enforcement.ts is the providers' own answer to "did I deliver every effect I
 * promised?". Three consumers must read THAT answer rather than re-deriving it:
 *
 *   E1 (meta)      bwrapMeta carries the declaration into every result, so a
 *                  partial host reports partial instead of a hardcoded full;
 *   E2 (policy)    CELESTEA_SANDBOX_FALLBACK=fail refuses a partial boundary
 *                  with the EXISTING sandbox_unavailable vocabulary;
 *   E3 (userspace) the fallback names its own (always partial) posture.
 */

import { describe, expect, it } from "vitest";
import { isSandboxError } from "@celestea/core";

import { DEFAULT_BWRAP_OPTIONS, type BwrapOptions } from "./bwrap-argv.js";
import { bwrapMeta } from "./bwrap.js";
import { buildSandboxConfig } from "./config.js";
import { userspaceEnforcement } from "./enforcement.js";
import { ENV_SANDBOX_FALLBACK, selectSandboxDetailed } from "./provider.js";
import { smokeEvidence, type HostProbe } from "./probe.js";
import { UserspaceSandbox } from "./userspace.js";

const WORK = process.cwd();
const FULL = ["mnt", "pid", "net", "ipc", "uts", "user", "cgroup"];

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
    namespaceEvidence: FULL,
    readonlyRootObserved: true,
    tmpPrivateObserved: true,
    ...overrides,
  };
}

function config() {
  return buildSandboxConfig({ workdir: WORK, root: WORK, timeoutMs: 5_000, maxTimeoutMs: 10_000 });
}

/** A bwrap that started but did NOT isolate the network namespace. */
const NETWORK_LEAKED = probeWith({ namespaceEvidence: ["mnt", "pid", "ipc", "uts", "user", "cgroup"] });

describe("W1483 E1 - bwrapMeta carries the declaration it was given", () => {
  it("reports partial when the probe did not observe a promised namespace", () => {
    // The mutation this catches: hardcoding a full verdict in bwrapMeta.
    expect(bwrapMeta(opts(), NETWORK_LEAKED)).toEqual({
      provider: "bwrap",
      net_isolated: true,
      tmp_private: true,
      seccomp: false,
      enforcement: "partial",
      promise_gaps: ["network_namespace"],
    });
  });

  it("reports full only when every promise was observed", () => {
    expect(bwrapMeta(opts(), probeWith()).enforcement).toBe("full");
  });
});

describe("W1483 E2 - the fail policy refuses a partial boundary", () => {
  it("throws the EXISTING sandbox_unavailable refusal, naming the gap", () => {
    const env = { [ENV_SANDBOX_FALLBACK]: "fail" };
    try {
      selectSandboxDetailed({ env, config: config(), probe: NETWORK_LEAKED });
      expect.unreachable("a partial boundary must not pass a fail-closed policy");
    } catch (error) {
      expect(isSandboxError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe("config");
      expect(String((error as Error).message)).toContain("sandbox_unavailable");
      expect(String((error as Error).message)).toContain("partial enforcement");
      expect(String((error as Error).message)).toContain("network_namespace");
      // It must reuse the documented knob, not invent a new one.
      expect(String((error as Error).message)).toContain(ENV_SANDBOX_FALLBACK);
      expect((error as { detail: Record<string, unknown> }).detail["enforcement"]).toBe("partial");
    }
  });

  it("still selects bwrap when the declaration is full", () => {
    const selection = selectSandboxDetailed({ env: { [ENV_SANDBOX_FALLBACK]: "fail" }, config: config(), probe: probeWith() });
    expect(selection.provider).toBe("bwrap");
    expect(selection.enforcement).toBe("full");
    expect(selection.promiseGaps).toEqual([]);
  });

  it("reports partial on the selection even when the policy degrades instead", () => {
    // Default mode: degrade visibly rather than refuse, but SAY the boundary is partial.
    const selection = selectSandboxDetailed({ env: {}, config: config(), probe: NETWORK_LEAKED });
    expect(selection.provider).toBe("bwrap");
    expect(selection.enforcement).toBe("partial");
    expect(selection.promiseGaps).toEqual(["network_namespace"]);
  });

  it("lets the documented unsandboxed grant through (no new override invented)", () => {
    const selection = selectSandboxDetailed({
      env: { [ENV_SANDBOX_FALLBACK]: "fail" },
      config: config(),
      probe: NETWORK_LEAKED,
      grants: { unsandboxed: true },
    });
    expect(selection.enforcement).toBe("partial");
  });
});

describe("W1483 E3 - the userspace fallback declares its own posture", () => {
  it("is always partial, with the coarse no-OS-isolation token", () => {
    expect(userspaceEnforcement(true)).toEqual({ enforcement: "partial", promise_gaps: ["no_os_isolation"] });
  });

  it("adds rlimits when the host has no mechanism to apply them", () => {
    // A userspace run that was ASKED for limits and could not apply them is a
    // promise gap, not a silent no-op (the rlimits_applied fact, made declarable).
    expect(userspaceEnforcement(false).promise_gaps).toEqual(["no_os_isolation", "rlimits"]);
  });

  it("reports the gap from a provider whose host has no rlimit mechanism", () => {
    const sandbox = new UserspaceSandbox(config(), {
      probe: probeWith({ prlimitPath: null, shellUlimitWorks: false }),
      rlimits: true,
    });
    expect(sandbox.enforcement().promise_gaps).toContain("rlimits");
    // ...and the diagnostic view agrees with the declaration.
    expect(sandbox.describe().rlimits_applied).toBe(false);
  });
});

describe("W1483 - the smoke evidence parser", () => {
  it("reads namespaces, the read-only root and the private tmp", () => {
    const evidence = smokeEvidence("ok ns=mnt:mnt:[4026532773] ns=net:net:[4026532833] root=ro tmp=tmpfs\n");
    expect(evidence.namespaceEvidence).toEqual(["mnt", "net"]);
    expect(evidence.readonlyRootObserved).toBe(true);
    expect(evidence.tmpPrivateObserved).toBe(true);
  });

  it("treats an unreadable namespace as NO observation, never as delivered", () => {
    const evidence = smokeEvidence("ok ns=mnt:? ns=net:net:[1] root=rw tmp=ext4\n");
    expect(evidence.namespaceEvidence).toEqual(["net"]);
    expect(evidence.readonlyRootObserved).toBe(false);
    expect(evidence.tmpPrivateObserved).toBe(false);
  });

  it("degrades to absent evidence on unparsable output", () => {
    const evidence = smokeEvidence("ok");
    expect(evidence.namespaceEvidence).toEqual([]);
    expect(evidence.readonlyRootObserved).toBe(false);
    expect(evidence.tmpPrivateObserved).toBe(false);
  });
});
