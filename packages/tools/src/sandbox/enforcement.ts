/**
 * Enforcement declarations — **each provider states its own completeness** (W1483).
 *
 * `SandboxMeta` carries facts (`net_isolated` / `tmp_private` / `seccomp`).
 * `enforcement` carries the layer those facts cannot express: whether the facts
 * cover *every* effect the provider's mode promises. The whole point of this
 * module is that the answer is declared where the isolation is BUILT, never
 * re-derived by a caller from a pile of booleans (the W268 lesson: a provider
 * that silently under-delivers is indistinguishable from one that does not).
 *
 * Three rules keep it honest:
 *
 * 1. **The declaration lives next to the evidence.** `bwrapEnforcement` is called
 *    by the bwrap provider, `userspaceEnforcement` by the userspace provider.
 *    Nothing else may construct an enforcement report for a provider.
 * 2. **`partial` must name a gap.** An empty gap list IS `full`
 *    (`enforcementReport`), so "I degraded but have nothing to say" is not
 *    expressible.
 * 3. **An unverified promise is not a delivered promise.** A promise is only
 *    `full` when the host evidence SAYS SO (see `probe.ts`); an absent
 *    observation counts as a gap, because the alternative is asserting isolation
 *    that was never measured.
 */

import type { SandboxEnforcementReport, SandboxPromiseGap } from "@celestea/core";
import { enforcementReport } from "@celestea/core";

import type { BwrapOptions } from "./bwrap-argv.js";
import type { HostProbe } from "./probe.js";

/**
 * The effects the bwrap mode promises, in promise order.
 *
 * `--unshare-all` covers the first group, the mount profile the second. This
 * list is the contract `bwrapEnforcement` is checked against: a promise whose
 * evidence is missing becomes a gap, so adding a flag to the argv builder
 * without teaching the evidence about it degrades honestly instead of silently
 * claiming `full`.
 */
export const BWRAP_PROMISES: readonly SandboxPromiseGap[] = [
  "mount_namespace",
  "pid_namespace",
  "ipc_namespace",
  "uts_namespace",
  "user_namespace",
  "cgroup_namespace",
  "network_namespace",
  "readonly_root",
  "private_tmp",
];

/**
 * Which observed namespace a promise needs, and whether the mode keeps it
 * isolated. `null` = the promise is not about a namespace.
 */
interface NamespaceEvidence {
  /** The observed token, or `null` for a non-namespace promise. */
  readonly observed: string | null;
  /** false when the mode deliberately shares this namespace (not a gap). */
  readonly isolated: boolean;
}

/**
 * The promises bwrap can keep WITHOUT a per-host probe, and how they are read
 * from the argv options. Everything here is enforced by construction: the argv
 * builder either emits the mount or it does not, and `bwrap.test.ts` pins the
 * order.
 *
 * `private_tmp` is deliberately NOT in this table — see [bwrapEnforcement].
 */
function constructedEvidence(options: BwrapOptions): Readonly<Record<string, NamespaceEvidence>> {
  return {
    mount_namespace: { observed: "mnt", isolated: true },
    pid_namespace: { observed: "pid", isolated: true },
    ipc_namespace: { observed: "ipc", isolated: true },
    uts_namespace: { observed: "uts", isolated: true },
    user_namespace: { observed: "user", isolated: true },
    cgroup_namespace: { observed: "cgroup", isolated: true },
    network_namespace: { observed: "net", isolated: !options.shareNet },
    readonly_root: { observed: null, isolated: true },
  };
}

/**
 * The bwrap provider's own completeness answer.
 *
 * `probe.namespaceEvidence` is the set of namespace tokens the host probe
 * observed changing between the host and the probe child. When the probe ran
 * (the production path) an unobserved token is a REAL gap: `--unshare-all` is
 * documented to unshare every namespace bwrap supports, so one that did not move
 * means this host's bwrap/kernel dropped it — exactly the "bwrap started but an
 * isolation did not take effect" case. When no evidence was collected at all
 * (unit tests inject a probe with no smoke run) nothing is claimed: every
 * namespace promise becomes a gap, so an unverified run can never report `full`.
 *
 * `private_tmp` is the second special case: bwrap stacks mounts in argv order
 * and `--ro-bind / /` comes first, so a private tmpfs only takes effect if the
 * tmpfs is stacked on top. The argv builder is asserted to do that
 * (`w9-rw-roots.test.ts`, `bwrap.test.ts`), and the host probe re-measures the
 * result, so the two independent statements must agree — if they ever disagree
 * the run is `partial`, never silently "probably fine".
 */
export function bwrapEnforcement(options: BwrapOptions, probe: HostProbe): SandboxEnforcementReport {
  const gaps: SandboxPromiseGap[] = [];
  const constructed = constructedEvidence(options);
  const observed = probe.namespaceEvidence ?? [];
  for (const promise of BWRAP_PROMISES) {
    if (promise === "private_tmp") continue;
    const evidence = constructed[promise];
    if (evidence === undefined || !evidence.isolated) continue;
    const token = evidence.observed;
    if (token !== null && !observed.includes(token)) gaps.push(promise);
  }
  if (observed.length > 0) {
    if (probe.tmpPrivateObserved !== true) gaps.push("private_tmp");
    // The probe runs the DEFAULT mount profile (no `writeRoots`), so it must
    // come back read-only; `rw` means `--ro-bind / /` did not take effect.
    if (probe.readonlyRootObserved !== true) gaps.push("readonly_root");
  }
  return enforcementReport(gaps);
}

/**
 * The userspace provider's own completeness answer.
 *
 * Userspace is the *degraded* fallback and says so with one coarse token: it
 * promises no OS-level effect at all (no namespaces, no private `/tmp`, no
 * read-only root, no seccomp), and listing nine constant gaps in every result
 * would be noise, not information. The gap is declared here — where the
 * provider is built — so a consumer never has to infer it from
 * `net_isolated === false && tmp_private === false && …`.
 *
 * `rlimits` is added when the caller asked for limits and this host has no
 * mechanism to apply them (W891's `rlimits_applied`): the userspace path runs
 * anyway, but "the limits you asked for are not in force" is precisely the kind
 * of promise gap this field exists for.
 */
export function userspaceEnforcement(rlimitsApplied: boolean): SandboxEnforcementReport {
  return enforcementReport(rlimitsApplied ? ["no_os_isolation"] : ["no_os_isolation", "rlimits"]);
}
