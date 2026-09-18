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

import type { Sandbox, SandboxConfig, SandboxRunRequest, SandboxRunResult, SandboxShellLookup, SandboxSpawnRequest, SandboxSpawned } from "@celestea/core";
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
import { captureRun, preview, resolveTimeout, spawnPlan, validateSandboxConfig } from "./launch.js";
import { limitsForCpu, limitsFromEnv, resolveCpuSec, type SandboxLimits } from "./limits.js";
import { probeHost, type HostProbe } from "./probe.js";
import { applyLimits, type RlimitVia } from "./rlimit.js";
import { openSeccompBlob } from "./seccomp.js";
import { resolveWorkdir } from "./workdir.js";

/** `SandboxMeta` plus the observability the 4-field contract cannot carry. */
export interface BwrapMeta {
  provider: string;
  net_isolated: boolean;
  tmp_private: boolean;
  seccomp: boolean;
  /** true: the child saw a read-only host root. */
  readonly_root: boolean;
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

  constructor(config: SandboxConfig, options: BwrapSandboxOptions = {}) {
    this.config = config;
    this.probe = options.probe ?? probeHost();
    this.limits = options.limits ?? limitsFromEnv(process.env, this.probe.uidThreads);
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
    const limits = this.limitsFor(request.cpuSec);
    const { child, meta } = await this.launch(request.command, request.workdir, false, limits);
    return captureRun(this.config, child, timeoutMs, meta);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateSandboxConfig(this.config);
    const limits = this.limitsFor(request.cpuSec);
    const { child, meta } = await this.launch(request.command, request.workdir, true, limits);
    return { child: wrapChild(child, { detached: true }), sandbox: meta };
  }

  /** W6: the base limits with this call's `cpu_sec` merged in (clamped). */
  private limitsFor(cpuSec: number | undefined): SandboxLimits {
    return limitsForCpu(this.limits, resolveCpuSec(this.limits.cpuSec, cpuSec, this.config.maxCpuSec));
  }

  /** Isolation actually in force, without running anything (logs / health). */
  describe(): BwrapMeta {
    return runtimeMeta(this.options, this.limits, this.probe, this.rlimits ? rlimitVia(this.probe) : "none");
  }

  private async launch(
    command: string,
    requestedWorkdir: string | undefined,
    withStdin: boolean,
    limits: SandboxLimits,
  ): Promise<{ child: ChildProcess; meta: BwrapMeta }> {
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
        this.rlimits,
      );
      const child = await spawnPlan({
        program: limited.program,
        args: limited.args,
        workdir,
        env: sanitizedEnv(this.config),
        extraFds: blob === null ? [] : [blob.fd],
        withStdin,
        label: `${bwrapLabel(this.options)} ${preview(command, 128)}`,
      });
      return { child, meta: runtimeMeta(this.options, limits, this.probe, limited.via) };
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

/** Which rlimit mechanism the probe leaves available. */
export function rlimitVia(probe: HostProbe): RlimitVia {
  if (probe.prlimitPath !== null) return "prlimit";
  return probe.shellUlimitWorks ? "shell-ulimit" : "none";
}

function runtimeMeta(options: BwrapOptions, limits: SandboxLimits, probe: HostProbe, via: RlimitVia): BwrapMeta {
  return {
    provider: BWRAP_PROVIDER,
    net_isolated: !options.shareNet,
    tmp_private: !options.shareTmp,
    seccomp: options.seccomp,
    readonly_root: true,
    rlimit_via: via,
    cpu_sec: limits.cpuSec,
    nproc: limits.nproc,
    uid_threads: probe.uidThreads,
    bwrap_version: probe.bwrapVersion,
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
