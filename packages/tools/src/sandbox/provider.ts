/**
 * Provider policy — **which** sandbox a deployment gets, decided out loud.
 *
 * `bwrap` (probe-gated) → else `userspace`. The fallback is *explicit*:
 * `CELESTEA_SANDBOX_FALLBACK=userspace` (default) degrades, while `=fail`
 * refuses to run at all. That is the direct answer to the W268 lesson — the
 * engine spent months on the weak userspace path because "bwrap unusable" was
 * inferred from a broken probe and the degradation was never reported.
 *
 * Two consequences of "fail-closed" are deliberate:
 * - an unrecognized `CELESTEA_SANDBOX_FALLBACK` value is an error, not a silent
 *   return to the default (a typo must not decide the security posture);
 * - the chosen provider always travels in `SandboxMeta` (`degraded`/`reason`
 *   are available from `selectSandboxDetailed` for startup logs).
 *
 * Same env vocabulary as the engine contract (`contracts/tools.json`):
 * `CELESTEA_SANDBOX_NET=1`, `CELESTEA_SANDBOX_SHARE_TMP=1`,
 * `CELESTEA_SANDBOX_SECCOMP=1`, plus `CELESTEA_SANDBOX_MASK=<abs dirs>`.
 */

import { isAbsolute } from "node:path";

import type { Sandbox, SandboxConfig } from "@celestea/core";
import { SandboxError } from "@celestea/core";

import { BWRAP_PROVIDER, DEFAULT_BWRAP_OPTIONS, type BwrapOptions } from "./bwrap-argv.js";
import { BwrapSandbox } from "./bwrap.js";
import { sandboxConfigFromEnv } from "./config.js";
import { envFlag, envString } from "../env.js";
import { limitsFromEnv, rlimitsEnabled } from "./limits.js";
import { probeHost, type HostProbe } from "./probe.js";
import { UserspaceSandbox } from "./userspace.js";

/** Env var: `userspace` (default, degrade) | `fail` (refuse). */
export const ENV_SANDBOX_FALLBACK = "CELESTEA_SANDBOX_FALLBACK";
/** Env var: `1` keeps the host network namespace (contract knob). */
export const ENV_SANDBOX_NET = "CELESTEA_SANDBOX_NET";
/** Env var: `1` binds the host `/tmp` instead of a private tmpfs (contract knob). */
export const ENV_SANDBOX_SHARE_TMP = "CELESTEA_SANDBOX_SHARE_TMP";
/** Env var: `1` installs the TS cBPF whitelist (contract knob). */
export const ENV_SANDBOX_SECCOMP = "CELESTEA_SANDBOX_SECCOMP";
/** Env var: comma-separated absolute host dirs masked with an empty tmpfs. */
export const ENV_SANDBOX_MASK = "CELESTEA_SANDBOX_MASK";

export type SandboxFallbackMode = "userspace" | "fail";

/**
 * Session-grant view of the sandbox provider (W516). Structural: the tools
 * package never imports the host's grants module.
 */
export interface SandboxGrantView {
  /** `network`: keep the host network namespace even without the env knob. */
  network?: boolean;
  /** `unsandboxed`: accept the userspace provider although the mode is `fail`. */
  unsandboxed?: boolean;
}

export interface SelectOptions {
  env?: NodeJS.ProcessEnv;
  config?: SandboxConfig;
  /** Inject a probe (tests); default: the memoized host probe. */
  probe?: HostProbe;
  /** Per-session grants (W516): widen only — see [bwrapOptionsFromEnv]. */
  grants?: SandboxGrantView;
}

export interface SandboxSelection {
  sandbox: Sandbox;
  /** Provider that will actually execute commands. */
  provider: string;
  /** true when bwrap was unavailable and the userspace path was chosen. */
  degraded: boolean;
  /** Why bwrap was rejected (for the startup log); null when not degraded. */
  reason: string | null;
  mode: SandboxFallbackMode;
  /**
   * true when the userspace provider was chosen *because* the `unsandboxed`
   * session grant overrode `CELESTEA_SANDBOX_FALLBACK=fail`. The host must
   * record a `degraded_by_grant` audit line when it sees this (`§4.4`).
   */
  degradedByGrant: boolean;
}

/** The selected sandbox, ready to inject (`builtinTools`, plugin service). */
export function selectSandbox(options: SelectOptions = {}): Sandbox {
  return selectSandboxDetailed(options).sandbox;
}

/** Selection plus the honest story of how it was made. */
export function selectSandboxDetailed(options: SelectOptions = {}): SandboxSelection {
  const env = options.env ?? process.env;
  const mode = fallbackMode(env);
  const grants = options.grants ?? {};
  const probe = options.probe ?? probeHost({ env });
  const config = options.config ?? sandboxConfigFromEnv(env);
  if (probe.bwrapUsable && probe.bwrapPath !== null) {
    const sandbox = new BwrapSandbox(config, {
      probe,
      limits: limitsFromEnv(env, probe.uidThreads),
      // W516 §4.3.5: `unsandboxed` is IGNORED when bwrap works — isolation is
      // already in effect and grants only ever add an escape when a policy
      // refuses, never "less isolation than the host already provides".
      run: bwrapOptionsFromEnv(env, grants),
      rlimits: rlimitsEnabled(env),
    });
    return { sandbox, provider: BWRAP_PROVIDER, degraded: false, reason: null, mode, degradedByGrant: false };
  }
  const reason = probe.bwrapRejectReason ?? "bwrap reported unusable by the host probe";
  if (mode === "fail") {
    // §4.3.5: the ONE case `unsandboxed` is for — the policy would refuse, and
    // the user explicitly asked (by clicking) for this session to run anyway.
    if (grants.unsandboxed === true) {
      return {
        sandbox: new UserspaceSandbox(config),
        provider: "userspace",
        degraded: true,
        reason: `${reason} — degraded by the 'unsandboxed' session grant`,
        mode,
        degradedByGrant: true,
      };
    }
    throw new SandboxError(
      "config",
      `sandbox_unavailable: ${reason} and ${ENV_SANDBOX_FALLBACK}=fail refuses to degrade to the userspace sandbox`,
      { provider: BWRAP_PROVIDER, reason, mode },
    );
  }
  return { sandbox: new UserspaceSandbox(config), provider: "userspace", degraded: true, reason, mode, degradedByGrant: false };
}

/** Fallback policy; an unknown value is rejected (fail-closed, see module docs). */
export function fallbackMode(env: NodeJS.ProcessEnv = process.env): SandboxFallbackMode {
  const raw = envString(env, ENV_SANDBOX_FALLBACK)?.toLowerCase();
  if (raw === undefined || raw === "userspace") return "userspace";
  if (raw === "fail") return "fail";
  throw new SandboxError("config", `invalid ${ENV_SANDBOX_FALLBACK}='${raw}' (expected 'userspace' or 'fail')`, {
    value: raw,
  });
}

/**
 * bwrap knobs from the contract env vocabulary. W516: a session's `network`
 * grant ORs into `shareNet` (and touches nothing else — `shareTmp`, `seccomp`,
 * `maskDirs` and the rlimits stay exactly as the operator set them, §5.6).
 */
export function bwrapOptionsFromEnv(env: NodeJS.ProcessEnv = process.env, grants: SandboxGrantView = {}): BwrapOptions {
  return {
    shareNet: envFlag(env[ENV_SANDBOX_NET], DEFAULT_BWRAP_OPTIONS.shareNet) || grants.network === true,
    shareTmp: envFlag(env[ENV_SANDBOX_SHARE_TMP], DEFAULT_BWRAP_OPTIONS.shareTmp),
    seccomp: envFlag(env[ENV_SANDBOX_SECCOMP], DEFAULT_BWRAP_OPTIONS.seccomp),
    maskDirs: parseMaskDirs(envString(env, ENV_SANDBOX_MASK)),
  };
}

function parseMaskDirs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const dirs = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const dir of dirs) {
    if (!isAbsolute(dir) || dir === "/") {
      throw new SandboxError("config", `invalid ${ENV_SANDBOX_MASK} entry '${dir}' (absolute, non-root paths only)`);
    }
  }
  return dirs;
}
