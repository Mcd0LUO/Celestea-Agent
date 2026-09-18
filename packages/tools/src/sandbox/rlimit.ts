/**
 * The rlimit layer: `prlimit` when present, `/bin/sh` builtins when not.
 *
 * Limits are applied **outside** the namespace layer (on the bwrap process
 * itself) and inherited by everything it forks, so a sandboxed tree cannot raise
 * them back. Both mechanisms are equivalent (W274 §3.1/§3.3); the binary is
 * preferred only because `prlimit --core=0` expresses "no core files" without
 * shell quoting.
 *
 * Note `RLIMIT_NPROC` semantics: it counts threads of the whole real UID on the
 * host (`limits.ts` derives the value accordingly) — a too-small value does not
 * merely throttle the sandbox, it makes `clone()` fail for the sandbox launcher.
 *
 * F4: `RLIMIT_AS` is the ONE limit a modern Chromium cannot live under (it
 * reserves an enormous virtual address space). [RlimitApplyOptions] therefore
 * carries a per-call `noAddressSpaceLimit` that omits ONLY `--as=` /
 * `ulimit -v`; every other limit stays. [rlimitDiagnostics] makes that exemption
 * observable on the provider's `describe()` path without touching SandboxMeta.
 */

import { SandboxError } from "@celestea/core";

import type { SandboxLimits } from "./limits.js";
import type { HostProbe } from "./probe.js";

/** How the limits were enforced — reported, never guessed. */
export type RlimitVia = "prlimit" | "shell-ulimit" | "none";

export interface RlimitPlan {
  program: string;
  args: string[];
  via: RlimitVia;
}

/** Which rlimit mechanism the probe leaves available. */
export function rlimitVia(probe: HostProbe): RlimitVia {
  if (probe.prlimitPath !== null) return "prlimit";
  return probe.shellUlimitWorks ? "shell-ulimit" : "none";
}

/** Per-call knobs for [applyLimits]. */
export interface RlimitApplyOptions {
  /** false disables EVERY rlimit (the operator escape hatch). Default true. */
  enabled?: boolean;
  /** true omits RLIMIT_AS only; every other limit stays. Default false. */
  noAddressSpaceLimit?: boolean;
}

/** Diagnostic knobs for a provider's describe() path. */
export interface RlimitDescribeOptions {
  /** The answer for a call that WOULD pass noAddressSpaceLimit. Default false. */
  noAddressSpaceLimit?: boolean;
}

/** Whether (and how) limits are in force — diagnostics, never SandboxMeta. */
export interface RlimitDiagnostics {
  via: RlimitVia;
  rlimits_enabled: boolean;
  address_space_limited: boolean;
}

/** Pure diagnostic projection (F4: makes an address-space exemption observable). */
export function rlimitDiagnostics(probe: HostProbe, enabled: boolean, noAddressSpaceLimit: boolean): RlimitDiagnostics {
  return {
    via: enabled ? rlimitVia(probe) : "none",
    rlimits_enabled: enabled,
    address_space_limited: enabled && !noAddressSpaceLimit,
  };
}

/**
 * Wrap `program args` with the strongest available rlimit mechanism.
 *
 * The 5th parameter accepts the legacy boolean ("enable every limit") OR
 * [RlimitApplyOptions]. `false` / `{ enabled: false }` returns the command
 * untouched; `{ noAddressSpaceLimit: true }` omits ONLY `RLIMIT_AS`.
 */
export function applyLimits(
  program: string,
  args: readonly string[],
  limits: SandboxLimits,
  probe: HostProbe,
  options: boolean | RlimitApplyOptions = true,
): RlimitPlan {
  const { enabled, noAddressSpaceLimit } = normalizeApplyOptions(options);
  if (!enabled) return { program, args: [...args], via: "none" };
  if (probe.prlimitPath !== null) {
    return { program: probe.prlimitPath, args: [...prlimitArgs(limits, noAddressSpaceLimit), "--", program, ...args], via: "prlimit" };
  }
  if (probe.shellUlimitWorks) {
    const script = ulimitScript(limits, noAddressSpaceLimit) + '; exec "$0" "$@"';
    return { program: "/bin/sh", args: ["-c", script, program, ...args], via: "shell-ulimit" };
  }
  throw new SandboxError(
    "config",
    "rlimits requested but neither the prlimit binary nor a shell with usable ulimit builtins is available",
    { prlimit: false, shellUlimit: false, nproc: limits.nproc },
  );
}

function normalizeApplyOptions(options: boolean | RlimitApplyOptions): { enabled: boolean; noAddressSpaceLimit: boolean } {
  if (typeof options === "boolean") return { enabled: options, noAddressSpaceLimit: false };
  return { enabled: options.enabled ?? true, noAddressSpaceLimit: options.noAddressSpaceLimit === true };
}

function prlimitArgs(limits: SandboxLimits, noAddressSpaceLimit = false): string[] {
  const args = ["--cpu=" + limits.cpuSec];
  if (!noAddressSpaceLimit) args.push("--as=" + limits.memMb * 1024 * 1024);
  args.push(
    "--nproc=" + limits.nproc,
    "--fsize=" + limits.fsizeBytes,
    "--nofile=" + limits.nofile,
    "--core=" + (limits.core ? 0 : "unlimited"),
  );
  return args;
}

/** dash/bash `ulimit` form of the same six limits (RLIMIT_AS optional). */
// B3 / W812 P2-3: POSIX/dash ulimit -f counts 512-byte blocks while prlimit's
// --fsize is bytes; dividing by 1024 halved the effective limit.
export function ulimitScript(limits: SandboxLimits, noAddressSpaceLimit = false): string {
  const lines = ["ulimit -t " + limits.cpuSec];
  if (!noAddressSpaceLimit) lines.push("ulimit -v " + limits.memMb * 1024);
  lines.push(
    "ulimit -u " + limits.nproc,
    "ulimit -f " + Math.ceil(limits.fsizeBytes / 512),
    "ulimit -n " + limits.nofile,
    "ulimit -c " + (limits.core ? 0 : "unlimited"),
  );
  return lines.join("; ");
}
