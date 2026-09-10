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
import { resolveWorkdir } from "./workdir.js";

/** The effective mode every result reports (never inferred by the caller). */
export const USERSPACE_META: SandboxMeta = USERSPACE_SANDBOX_META;

export class UserspaceSandbox implements Sandbox {
  readonly config: SandboxConfig;

  constructor(config: SandboxConfig = sandboxConfigFromEnv()) {
    this.config = config;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): UserspaceSandbox {
    return new UserspaceSandbox(sandboxConfigFromEnv(env));
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    validateSandboxConfig(this.config);
    const timeoutMs = resolveTimeout(this.config, request.timeoutMs);
    const child = await this.launch(request.command, request.workdir, false);
    return captureRun(this.config, child, timeoutMs, USERSPACE_META);
  }

  async spawn(request: SandboxSpawnRequest): Promise<SandboxSpawned> {
    validateSandboxConfig(this.config);
    const child = await this.launch(request.command, request.workdir, true);
    return { child: wrapChild(child, { detached: true }), sandbox: USERSPACE_META };
  }

  private async launch(command: string, requestedWorkdir: string | undefined, withStdin: boolean): Promise<ChildProcess> {
    const workdir = await resolveWorkdir(this.config, requestedWorkdir);
    const { program, args } = shellInvocation(command);
    return spawnPlan({
      program,
      args,
      workdir,
      env: sanitizedEnv(this.config),
      withStdin,
      label: command,
    });
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
