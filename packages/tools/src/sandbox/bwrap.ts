/**
 * `BwrapSandbox` — the OS-isolated provider (P2c), behind the same `Sandbox`
 * seam as the userspace one, so `run_shell` changes no line.
 *
 * Layer order (outermost → innermost), mirroring W274 §8.1:
 *
 *   node spawn(detached)                        → own process group (group kill)
 *     prlimit | /bin/sh 'ulimit …; exec'        → RLIMIT_CPU/AS/NPROC/FSIZE/…
 *       bwrap --unshare-all --die-with-parent   → user/mount/pid/net/ipc/uts ns,
 *         --ro-bind / / --dev /dev --proc /proc    read-only root, private /dev
 *         --tmpfs /tmp | --share-net | --seccomp FD
 *           /bin/sh -c <command>
 *
 * Two properties are non-negotiable and tested:
 * - **argv order** (`bwrap-argv.ts`) — the W274 device regression;
 * - **`--die-with-parent`** — orphan reaping when the Node parent is SIGKILLed
 *   (W274 §6.3: 3 orphans → 0), which the userspace path cannot do at all.
 *
 * If bwrap turns out unusable at call time the run is **refused** with a
 * structured `SandboxError`; degrading to userspace is the *policy* layer's
 * explicit decision (`provider.ts`), never this provider's silent fallback.
 */

import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";

import type {
  Sandbox,
  SandboxConfig,
  SandboxEnforcementReport,
  SandboxMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxShellLookup,
  SandboxSpawnRequest,
  SandboxSpawned,
} from "@celestea/core";
import { SandboxError } from "@celestea/core";

import { wrapChild } from "./child.js";
import { sandboxConfigFromEnv, sanitizedEnv } from "./config.js";
import {
  BWRAP_PROVIDER,
  buildBwrapCommand,
  bwrapLabel,
  DEFAULT_BWRAP_OPTIONS,
  type BwrapOptions,
} from "./bwrap-argv.js";
import { bwrapEnforcement } from "./enforcement.js";
import { captureRun, preview, resolveTimeout, spawnPlan, validateSandboxConfig } from "./launch.js";
import { limitsForCpu, limitsFromEnv, refreshNproc, resolveCallCpuSec, type CallCpuResolution, type SandboxLimits } from "./limits.js";
import { probeHost, type HostProbe } from "./probe.js";
import { applyLimits, rlimitDiagnostics, rlimitVia, type RlimitDescribeOptions, type RlimitVia } from "./rlimit.js";
import { openSeccompBlob } from "./seccomp.js";
import { resolveWorkdir } from "./workdir.js";

/** `SandboxMeta` plus the observability the contract fields cannot carry. */
export interface BwrapMeta extends SandboxMeta {
  provider: string;
  net_isolated: boolean;
  tmp_private: boolean;
  seccomp: boolean;
  /** true: the child saw a read-only host root. */
  readonly_root: boolean;
  /**
   * F4: true when RLIMIT_AS is in force. false = this view describes a call
   * that would be exempt (or every rlimit is off). Diagnostics only — the
   * model-visible SandboxMeta deliberately does NOT carry it.
   */
  address_space_limited: boolean;
  /** W6: effective `RLIMIT_CPU` for this run (seconds). */
  cpu_sec: number;
  /** Which mechanism enforced the rlimits. */
  rlimit_via: RlimitVia;
  /** Effective `RLIMIT_NPROC` (derived from the UID thread count). */
  nproc: number;
  /** Threads owned by this uid host-wide when the probe ran (null = unknown). */
  uid_threads: number | null;
  /** `bwrap --version` output, for post-mortems. */
  bwrap_version: string | null;
}

export interface BwrapSandboxOptions {
  probe?: HostProbe;
  limits?: SandboxLimits;
  /**
   * W1465: re-derive `nproc` from a FRESH UID thread count on every call.
   *
   * Default: `true` when `limits` is NOT injected (the production path, which
   * derives from env), `false` when the caller pinned `limits` (tests need a
   * deterministic plan). Pinning a stale `nproc` in production is exactly the
   * outage this option exists to prevent — see [refreshNproc].
   */
  refreshNprocPerCall?: boolean;
  /** Env used to (re-)derive limits; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  run?: Partial<BwrapOptions>;
  /** false disables every rlimit (operator escape hatch). */
  rlimits?: boolean;
  /** Directory for the generated seccomp blob (tests pin it). */
  seccompDir?: string;
  /** W885: the platform/shell view commands run under (defaults to the host). */
  shell?: SandboxShellLookup;
}

export class BwrapSandbox implements Sandbox {
  readonly config: SandboxConfig;
  readonly probe: HostProbe;
  readonly limits: SandboxLimits;
  readonly options: BwrapOptions;
  /** W885: injected platform view; `undefined` = the host's own defaults. */
  readonly shell: SandboxShellLookup | undefined;

  private readonly rlimits: boolean;
  private readonly seccompDir: string | undefined;
  /** W1465: whether `nproc` is re-derived per call (see the option docs). */
  private readonly refreshNprocPerCall: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(config: SandboxConfig, options: BwrapSandboxOptions = {}) {
    this.config = config;
    this.probe = options.probe ?? probeHost();
    this.env = options.env ?? process.env;
    this.limits = options.limits ?? limitsFromEnv(this.env, this.probe.uidThreads);
    this.refreshNprocPerCall = options.refreshNprocPerCall ?? options.limits === undefined;
    this.options = { ...DEFAULT_BWRAP_OPTIONS, ...(options.run ?? {}) };
    this.rlimits = options.rlimits ?? true;
    this.seccompDir = options.seccompDir;
    this.shell = options.shell;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BwrapSandbox {
    return new BwrapSandbox(sandboxConfigFromEnv(env), { probe: probeHost({ env }) });
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    validateSandboxConfig(this.config);
    const timeoutMs = resolveTimeout(this.config, request.timeoutMs);
    // §3.1: the EFFECTIVE wall clock of THIS call decides RLIMIT_CPU, so the
    // value is derived from `timeoutMs` — not from a module constant. An explicit
    // `cpu_sec` still wins and is still clamped (see [resolveCallCpuSec]).
    const limits = this.limitsFor(resolveCallCpuSec({ requested: request.cpuSec, maxCpuSec: this.config.maxCpuSec, wallClockMs: timeoutMs }));
    const { child, meta } = await this.launch(request.command, request.workdir, false, limits, request.noAddressSpaceLimit === true);
    return captureRun(this.config, child, timeoutMs, meta);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateSandboxConfig(this.config);
    // `wallClockMs: null` = this path has NO call-level wall clock, so the default
    // is the deployer ceiling instead of a derived value (see [CpuSource]).
    const limits = this.limitsFor(resolveCallCpuSec({ requested: request.cpuSec, maxCpuSec: this.config.maxCpuSec, wallClockMs: null }));
    const { child, meta } = await this.launch(request.command, request.workdir, true, limits, request.noAddressSpaceLimit === true);
    return { child: wrapChild(child, { detached: true }), sandbox: meta };
  }

  /**
   * W6: the base limits with this call's resolved CPU limit merged in (clamped).
   * W1465: `nproc` is re-derived from a FRESH thread count on every call -- the
   * construction-time value is a time bomb (see [refreshNproc]). Callers that
   * pinned `limits` keep them verbatim (deterministic plans / tests).
   */
  private limitsFor(resolution: CallCpuResolution): SandboxLimits {
    const base = this.refreshNprocPerCall ? refreshNproc(this.limits, this.env) : this.limits;
    return limitsForCpu(base, resolution);
  }

  /** Isolation actually in force, without running anything (logs / health). */
  describe(options: RlimitDescribeOptions = {}): BwrapMeta {
    const diag = rlimitDiagnostics(this.probe, this.rlimits, options.noAddressSpaceLimit === true);
    return runtimeMeta(this.options, this.limits, this.probe, diag.via, diag.address_space_limited);
  }

  /**
   * W1483: this provider's own completeness answer for the current host.
   *
   * Declared HERE, where the isolation is built, so no caller has to reconstruct
   * it from `net_isolated` / `tmp_private` / `seccomp`. The policy layer reads
   * it to decide whether an absolute-promise request may run at all
   * (`provider.ts`), and every result carries it back to the model.
   */
  enforcement(): SandboxEnforcementReport {
    return bwrapEnforcement(this.options, this.probe);
  }

  private async launch(
    command: string,
    requestedWorkdir: string | undefined,
    withStdin: boolean,
    limits: SandboxLimits,
    noAddressSpaceLimit: boolean,
  ): Promise<{ child: ChildProcess; meta: SandboxMeta }> {
    this.assertUsable();
    const workdir = await resolveWorkdir(this.config, requestedWorkdir);
    // W880: the program dir must exist before bwrap can bind it; run_code
    // normally creates it first, but a run_shell-only sandbox must not fail.
    await mkdir(this.config.programDir, { recursive: true }).catch(() => undefined);
    const binary = this.probe.bwrapPath as string;
    const blob = this.options.seccomp ? openSeccompBlob(this.seccompDir) : null;
    try {
      const limited = applyLimits(
        binary,
        buildBwrapCommand(workdir, { ...this.options, programDir: this.config.programDir }, command),
        limits,
        this.probe,
        { enabled: this.rlimits, noAddressSpaceLimit },
      );
      const child = await spawnPlan({
        program: limited.program,
        args: limited.args,
        workdir,
        env: sanitizedEnv(this.config, this.shell?.env ?? process.env, this.shell?.platform ?? process.platform),
        extraFds: blob === null ? [] : [blob.fd],
        withStdin,
        label: `${bwrapLabel(this.options)} ${preview(command, 128)}`,
      });
      const diag = rlimitDiagnostics(this.probe, this.rlimits, noAddressSpaceLimit);
      const meta = resultMeta(runtimeMeta(this.options, limits, this.probe, limited.via, diag.address_space_limited));
      return { child, meta };
    } finally {
      blob?.dispose();
    }
  }

  private assertUsable(): void {
    if (this.probe.bwrapUsable && this.probe.bwrapPath !== null) return;
    const reason = this.probe.bwrapRejectReason ?? "bwrap reported unusable by the host probe";
    throw new SandboxError(
      "config",
      `sandbox_unavailable: ${reason} (fix the host, pin a binary with CELESTEA_SANDBOX_BWRAP, or set CELESTEA_SANDBOX_FALLBACK=userspace to degrade explicitly)`,
      { provider: BWRAP_PROVIDER, reason, bwrap_path: this.probe.bwrapPath },
    );
  }
}

/**
 * Which rlimit mechanism the probe leaves available.
 *
 * F4: the implementation moved to `rlimit.ts` (where the limit plan lives);
 * this re-export keeps the public path `@celestea/tools` -> `bwrap.js` stable.
 */
export { rlimitVia } from "./rlimit.js";

/**
 * The isolation actually in force — reported, never inferred by the caller.
 *
 * W1483: the facts come from the options, the completeness comes from THIS
 * provider's own declaration (`bwrapEnforcement`), and the probe supplies the
 * evidence that backs it. A caller reads `enforcement` / `promise_gaps`; it never
 * reconstructs completeness from the three booleans.
 *
 * W1485: lives HERE, not in `bwrap-argv.ts`. The argv builder is the lowest layer
 * of this family (pure argv, no probe); composing a meta needs both the argv
 * options and the probe, and keeping it in the leaf made
 * `bwrap-argv -> enforcement -> bwrap-argv` and `bwrap-argv -> probe -> bwrap-argv`
 * circular (caught by `pnpm lint:arch`, not by `tsc`).
 */
export function bwrapMeta(options: BwrapOptions, probe: HostProbe): SandboxMeta {
  return {
    provider: BWRAP_PROVIDER,
    net_isolated: !options.shareNet,
    tmp_private: !options.shareTmp,
    seccomp: options.seccomp,
    ...bwrapEnforcement(options, probe),
  };
}

function runtimeMeta(options: BwrapOptions, limits: SandboxLimits, probe: HostProbe, via: RlimitVia, addressSpaceLimited: boolean): BwrapMeta {
  return {
    ...bwrapMeta(options, probe),
    provider: BWRAP_PROVIDER,
    net_isolated: !options.shareNet,
    tmp_private: !options.shareTmp,
    seccomp: options.seccomp,
    readonly_root: probe.readonlyRootObserved === true,
    address_space_limited: addressSpaceLimited,
    rlimit_via: via,
    cpu_sec: limits.cpuSec,
    nproc: limits.nproc,
    uid_threads: probe.uidThreads,
    bwrap_version: probe.bwrapVersion,
  };
}

/**
 * The model-visible projection: EXACTLY the `SandboxMeta` seam contract
 * (`provider`, `net_isolated`, `tmp_private`, `seccomp`, optional `cpu_sec`).
 *
 * Why this exists: [runtimeMeta] also carries host diagnostics (`bwrap_version`,
 * `rlimit_via`, `uid_threads`, `nproc`, `readonly_root`) that are identical on
 * every single call and are NOT part of the contract. Shipping them inside every
 * `run_shell` result floods the caller's context with constants (the userspace
 * provider never did — see `USERSPACE_SANDBOX_META`). Diagnostics stay available
 * on [BwrapSandbox.describe] for logs / health, never inside a tool result.
 */
function resultMeta(meta: BwrapMeta): SandboxMeta {
  return {
    provider: meta.provider,
    net_isolated: meta.net_isolated,
    tmp_private: meta.tmp_private,
    seccomp: meta.seccomp,
    // W1483: the provider's OWN completeness verdict travels with every result.
    enforcement: meta.enforcement,
    ...(meta.promise_gaps === undefined ? {} : { promise_gaps: meta.promise_gaps }),
    ...(meta.cpu_sec === undefined ? {} : { cpu_sec: meta.cpu_sec }),
  };
}

/** Factory with explicit knobs (tests / embeddings). */
export function bwrapSandboxWith(config: SandboxConfig, options: BwrapSandboxOptions = {}): BwrapSandbox {
  return new BwrapSandbox(config, options);
}

/** Env-tuned default (`selectSandbox` builds this only when bwrap is usable). */
export function bwrapSandbox(config: SandboxConfig = sandboxConfigFromEnv()): BwrapSandbox {
  return new BwrapSandbox(config);
}
