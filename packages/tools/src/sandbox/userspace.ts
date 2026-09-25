/**
 * `UserspaceSandbox` — the P2b implementation of the `Sandbox` seam, kept as the
 * explicit **fallback** (and as the "no OS isolation at all" reference the
 * tests compare against).
 *
 * It is honest about what it is: no namespaces, no seccomp, no private /tmp, and
 * — W274 §6.2/§6.3 — a `setsid()`ing grandchild or a SIGKILLed Node parent leaks
 * processes that the bwrap path reaps. What it does enforce, and what the tool
 * contract depends on:
 * - a fixed workdir that must resolve inside the configured root;
 * - an allowlisted child environment (never the host environment, never HOME);
 * - a kill deadline that SIGKILLs the whole process group;
 * - per-stream output caps, with the truncation flag reported;
 * - structured failures (`run_shell-sandbox: code=timeout|workdir|arg|config|spawn`).
 *
 * Which provider a deployment actually gets is decided in `provider.ts`; the
 * OS-isolated one is `bwrap.ts`.
 */

import type { ChildProcess } from "node:child_process";
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
import { USERSPACE_SANDBOX_META } from "@celestea/core";

import { wrapChild } from "./child.js";
import { shellInvocation, sanitizedEnv, buildSandboxConfig, sandboxConfigFromEnv, type SandboxConfigOverrides } from "./config.js";
import { userspaceEnforcement } from "./enforcement.js";
import { captureRun, resolveTimeout, spawnPlan, validateSandboxConfig } from "./launch.js";
import { limitsForCpu, limitsFromEnv, refreshNproc, resolveCallCpuSec, rlimitsEnabled, type CallCpuResolution, type SandboxLimits } from "./limits.js";
import { rlimitVia } from "./rlimit.js";
import { probeHost, type HostProbe } from "./probe.js";
import { applyLimits, rlimitDiagnostics, type RlimitDescribeOptions, type RlimitVia } from "./rlimit.js";
import { resolveWorkdir } from "./workdir.js";

/** W6: the same rlimit layer the bwrap path uses (best-effort here). */
export interface UserspaceSandboxOptions {
  probe?: HostProbe;
  limits?: SandboxLimits;
  /**
   * W1465: re-derive `nproc` from a FRESH UID thread count on every call.
   * Default: `true` when `limits` is NOT injected, `false` when pinned (tests).
   * See [refreshNproc] for the outage this prevents (bwrap/prlimit EAGAIN).
   */
  refreshNprocPerCall?: boolean;
  /** Env used to (re-)derive limits; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** false disables every rlimit (operator escape hatch). */
  rlimits?: boolean;
  /** W885: the platform/shell view commands run under (defaults to the host). */
  shell?: SandboxShellLookup;
}

/** The effective mode every result reports (never inferred by the caller). */
export const USERSPACE_META: SandboxMeta = USERSPACE_SANDBOX_META;

/**
 * F4: the DIAGNOSTIC view (logs / health), never the model-visible contract.
 * `address_space_limited` is how an AS exemption stays observable without
 * adding a field to `SandboxMeta`.
 */
export interface UserspaceMeta extends SandboxMeta {
  cpu_sec: number;
  rlimit_via: RlimitVia;
  address_space_limited: boolean;
  /**
   * W891: false when the host has NO rlimit mechanism (Windows, or a Linux host
   * with neither prlimit nor a shell with usable ulimit builtins). The run still
   * proceeds — userspace is the degraded fallback — but the degradation is now a
   * fact on the result, not just one stderr line nobody reads.
   */
  rlimits_applied: boolean;
}

export class UserspaceSandbox implements Sandbox {
  readonly config: SandboxConfig;
  readonly probe: HostProbe;
  readonly limits: SandboxLimits;
  /** W885: injected platform view; `undefined` = the host's own defaults. */
  readonly shell: SandboxShellLookup | undefined;
  private readonly rlimits: boolean;
  /** W1465: whether `nproc` is re-derived per call (see the option docs). */
  private readonly refreshNprocPerCall: boolean;
  private readonly env: NodeJS.ProcessEnv;

  constructor(config: SandboxConfig = sandboxConfigFromEnv(), options: UserspaceSandboxOptions = {}) {
    this.config = config;
    this.probe = options.probe ?? probeHost();
    this.env = options.env ?? process.env;
    this.limits = options.limits ?? limitsFromEnv(this.env, this.probe.uidThreads);
    this.refreshNprocPerCall = options.refreshNprocPerCall ?? options.limits === undefined;
    this.rlimits = options.rlimits ?? rlimitsEnabled(this.env);
    this.shell = options.shell;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): UserspaceSandbox {
    return new UserspaceSandbox(sandboxConfigFromEnv(env), {
      probe: probeHost({ env }),
      rlimits: rlimitsEnabled(env),
    });
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    validateSandboxConfig(this.config);
    const timeoutMs = resolveTimeout(this.config, request.timeoutMs);
    // §3.1: RLIMIT_CPU follows THIS call's effective wall clock; an explicit
    // `cpu_sec` still wins and is still clamped (see [resolveCallCpuSec]).
    const limits = this.limitsFor(resolveCallCpuSec({ requested: request.cpuSec, maxCpuSec: this.config.maxCpuSec, wallClockMs: timeoutMs }));
    const { child, meta } = await this.launch(request.command, request.workdir, false, limits, request.noAddressSpaceLimit === true);
    return captureRun(this.config, child, timeoutMs, meta);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateSandboxConfig(this.config);
    // `wallClockMs: null` = no call-level wall clock on this path, so the default
    // is the deployer ceiling rather than a derived value (see [CpuSource]).
    const limits = this.limitsFor(resolveCallCpuSec({ requested: request.cpuSec, maxCpuSec: this.config.maxCpuSec, wallClockMs: null }));
    const { child, meta } = await this.launch(request.command, request.workdir, true, limits, request.noAddressSpaceLimit === true);
    return { child: wrapChild(child, { detached: true }), sandbox: meta };
  }

  /**
   * W6: the base limits with the per-call resolved CPU limit merged in (clamped).
   * W1465: `nproc` is re-derived per call (same time bomb as bwrap); pinned
   * `limits` are kept verbatim for deterministic plans / tests.
   */
  private limitsFor(resolution: CallCpuResolution): SandboxLimits {
    const base = this.refreshNprocPerCall ? refreshNproc(this.limits, this.env) : this.limits;
    return limitsForCpu(base, resolution);
  }

  /**
   * W1483: this provider's own completeness answer, from the SAME probe facts
   * `describe()` reports — declared here, where the limits are decided, so a
   * caller never infers "no OS isolation" from three false booleans.
   */
  enforcement(): SandboxEnforcementReport {
    return userspaceEnforcement(this.rlimits && rlimitVia(this.probe) !== "none");
  }

  /** F4: diagnostic view of what would be enforced (never SandboxMeta). */
  describe(options: RlimitDescribeOptions = {}): UserspaceMeta {
    const diag = rlimitDiagnostics(this.probe, this.rlimits, options.noAddressSpaceLimit === true);
    return {
      ...USERSPACE_META,
      ...this.enforcement(),
      cpu_sec: this.limits.cpuSec,
      rlimit_via: diag.via,
      address_space_limited: diag.address_space_limited,
      // "none" means the plan is a no-op: either the operator disabled limits,
      // or no mechanism exists. Both are honest, but only the latter is a
      // DEGRADATION, so this is true only when limits were requested AND a
      // mechanism was actually available.
      rlimits_applied: this.rlimits && diag.via !== "none",
    };
  }

  private async launch(
    command: string,
    requestedWorkdir: string | undefined,
    withStdin: boolean,
    limits: SandboxLimits,
    noAddressSpaceLimit: boolean,
  ): Promise<{ child: ChildProcess; meta: SandboxMeta }> {
    const workdir = await resolveWorkdir(this.config, requestedWorkdir);
    const { program, args } = shellInvocation(command, this.shell);
    let plan = { program, args };
    if (this.rlimits) {
      try {
        const limited = applyLimits(program, args, limits, this.probe, { enabled: true, noAddressSpaceLimit });
        plan = { program: limited.program, args: limited.args };
      } catch {
        // W6: userspace is the DEGRADED fallback: unlike the fail-closed bwrap
        // path, a host with no rlimit mechanism must still run (best effort).
        process.stderr.write("[celestea-tools] userspace sandbox: no rlimit mechanism; running without limits\n");
      }
    }
    const child = await spawnPlan({
      program: plan.program,
      args: plan.args,
      workdir,
      env: sanitizedEnv(this.config, this.shell?.env ?? process.env, this.shell?.platform ?? process.platform),
      withStdin,
      label: command,
    });
    return { child, meta: { ...USERSPACE_META, ...this.enforcement(), cpu_sec: limits.cpuSec } };
  }
}

/** Factory used by the policy layer as the explicit fallback. */
export function userspaceSandbox(config?: SandboxConfig): UserspaceSandbox {
  return new UserspaceSandbox(config ?? sandboxConfigFromEnv());
}

/** Factory with explicit knobs (tests / embeddings). */
export function userspaceSandboxWith(overrides: SandboxConfigOverrides): UserspaceSandbox {
  return new UserspaceSandbox(buildSandboxConfig(overrides));
}
