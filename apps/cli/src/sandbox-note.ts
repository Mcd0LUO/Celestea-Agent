/**
 * The startup sandbox note (H) — say the security posture out loud.
 *
 * `selectSandboxDetailed` is the SAME policy the engine composes per session, so
 * the CLI reports the provider that will actually run commands. On Windows (no
 * bwrap) or a Linux host without bwrap this is the userspace provider, and the
 * note states the degradation and the `CELESTEA_SANDBOX_FALLBACK` value instead
 * of pretending isolation is on.
 */

import { ENV_SANDBOX_FALLBACK, fallbackMode, selectSandboxDetailed, type HostProbe } from "@celestea/tools";

export interface SandboxNoteInput {
  env?: NodeJS.ProcessEnv;
  /** Injected host probe (tests); default: the memoized real probe. */
  probe?: HostProbe;
}

/** One human line describing the sandbox decision (never throws on `fail`). */
export function sandboxStartupNote(input: SandboxNoteInput = {}): string {
  const env = input.env ?? process.env;
  let mode: string;
  try {
    mode = fallbackMode(env);
  } catch {
    return `sandbox: invalid ${ENV_SANDBOX_FALLBACK} — refusing to guess (see the docs)`;
  }
  let selection;
  try {
    selection = selectSandboxDetailed({ env, ...(input.probe === undefined ? {} : { probe: input.probe }) });
  } catch (e) {
    return `sandbox: refusing to execute — ${e instanceof Error ? e.message : String(e)}`;
  }
  if (selection.provider === "bwrap" && !selection.degraded) {
    return "sandbox: bwrap (namespaces + private tmp; network isolated unless granted)";
  }
  return `sandbox: DEGRADED to userspace — ${selection.reason ?? "bwrap unavailable"} (${ENV_SANDBOX_FALLBACK}=${mode})`;
}
