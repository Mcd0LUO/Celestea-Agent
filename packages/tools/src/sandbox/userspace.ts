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
  SandboxMeta,
  SandboxRunRequest,
  SandboxRunResult,
  SandboxSpawnRequest,
  SandboxSpawned,
} from "@celestea/core";
import { USERSPACE_SANDBOX_META } from "@celestea/core";

import { wrapChild } from "./child.js";
import { shellInvocation, sanitizedEnv, buildSandboxConfig, sandboxConfigFromEnv, type SandboxConfigOverrides } from "./config.js";
import { captureRun, resolveTimeout, spawnPlan, validateSandboxConfig } from "./launch.js";
import { limitsForCpu, limitsFromEnv, resolveCpuSec, rlimitsEnabled, type SandboxLimits } from "./limits.js";
import { probeHost, type HostProbe } from "./probe.js";
import { applyLimits } from "./rlimit.js";
import { resolveWorkdir } from "./workdir.js";

/** W6: the same rlimit layer the bwrap path uses (best-effort here). */
export interface UserspaceSandboxOptions {
  probe?: HostProbe;
  limits?: SandboxLimits;
  /** false disables every rlimit (operator escape hatch). */
  rlimits?: boolean;
}

/** The effective mode every result reports (never inferred by the caller). */
export const USERSPACE_META: SandboxMeta = USERSPACE_SANDBOX_META;

export class UserspaceSandbox implements Sandbox {
  readonly config: SandboxConfig;
  readonly probe: HostProbe;
  readonly limits: SandboxLimits;
  private readonly rlimits: boolean;

  constructor(config: SandboxConfig = sandboxConfigFromEnv(), options: UserspaceSandboxOptions = {}) {
    this.config = config;
    this.probe = options.probe ?? probeHost();
    this.limits = options.limits ?? limitsFromEnv(process.env, this.probe.uidThreads);
    this.rlimits = options.rlimits ?? rlimitsEnabled(process.env);
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
    const { child, meta } = await this.launch(request.command, request.workdir, false, this.limitsFor(request.cpuSec));
    return captureRun(this.config, child, timeoutMs, meta);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateSandboxConfig(this.config);
    const { child, meta } = await this.launch(request.command, request.workdir, true, this.limitsFor(request.cpuSec));
    return { child: wrapChild(child, { detached: true }), sandbox: meta };
  }

  /** W6: the base limits with the per-call `cpu_sec` merged in (clamped). */
  private limitsFor(cpuSec: number | undefined): SandboxLimits {
    return limitsForCpu(this.limits, resolveCpuSec(this.limits.cpuSec, cpuSec, this.config.maxCpuSec));
  }

  private async launch(
    command: string,
    requestedWorkdir: string | undefined,
    withStdin: boolean,
    limits: SandboxLimits,
  ): Promise<{ child: ChildProcess; meta: SandboxMeta }> {
    const workdir = await resolveWorkdir(this.config, requestedWorkdir);
    const { program, args } = shellInvocation(command);
    let plan = { program, args };
    if (this.rlimits) {
      try {
        const limited = applyLimits(program, args, limits, this.probe, true);
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
      env: sanitizedEnv(this.config),
      withStdin,
      label: command,
    });
    return { child, meta: { ...USERSPACE_META, cpu_sec: limits.cpuSec } };
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
