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

/**
 * Wrap `program args` with the strongest available rlimit mechanism.
 * `enabled === false` (operator escape hatch) returns the command untouched.
 */
export function applyLimits(
  program: string,
  args: readonly string[],
  limits: SandboxLimits,
  probe: HostProbe,
  enabled = true,
): RlimitPlan {
  if (!enabled) return { program, args: [...args], via: "none" };
  if (probe.prlimitPath !== null) {
    return { program: probe.prlimitPath, args: [...prlimitArgs(limits), "--", program, ...args], via: "prlimit" };
  }
  if (probe.shellUlimitWorks) {
    return { program: "/bin/sh", args: ["-c", `${ulimitScript(limits)}; exec "$0" "$@"`, program, ...args], via: "shell-ulimit" };
  }
  throw new SandboxError(
    "config",
    "rlimits requested but neither the prlimit binary nor a shell with usable ulimit builtins is available",
    { prlimit: false, shellUlimit: false, nproc: limits.nproc },
  );
}

function prlimitArgs(limits: SandboxLimits): string[] {
  return [
    `--cpu=${limits.cpuSec}`,
    `--as=${limits.memMb * 1024 * 1024}`,
    `--nproc=${limits.nproc}`,
    `--fsize=${limits.fsizeBytes}`,
    `--nofile=${limits.nofile}`,
    `--core=${limits.core ? 0 : "unlimited"}`,
  ];
}

/** dash/bash `ulimit` form of the same six limits. */
export function ulimitScript(limits: SandboxLimits): string {
  return [
    `ulimit -t ${limits.cpuSec}`,
    `ulimit -v ${limits.memMb * 1024}`,
    `ulimit -u ${limits.nproc}`,
    `ulimit -f ${Math.floor(limits.fsizeBytes / 1024)}`,
    `ulimit -n ${limits.nofile}`,
    `ulimit -c ${limits.core ? 0 : "unlimited"}`,
  ].join("; ");
}
