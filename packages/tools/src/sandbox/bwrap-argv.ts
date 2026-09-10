/**
 * The bubblewrap argv builder — **the whole point of P2c is in this order**.
 *
 * W274 §2 diagnosed the engine's "bubblewrap is unusable" verdict as a pure
 * argument-order bug: bwrap stacks mounts in argv order, so
 * `--dev /dev --ro-bind / /` builds a private devtmpfs and then buries it under
 * a read-only bind of the *host* root — `/dev/zero` becomes `EACCES` and the
 * startup probe wrongly reports "no bwrap" (production then silently ran on the
 * userspace path for months).
 *
 *   --unshare-all → --ro-bind / / → --dev /dev → --proc /proc
 *
 * is the only shape that passes the device smoke test, so it is asserted by a
 * regression test (`bwrap.test.ts`) rather than trusted to reviewers.
 */

import type { SandboxMeta } from "@celestea/core";

/** Provider name reported in every `SandboxMeta` from this layer. */
export const BWRAP_PROVIDER = "bwrap";

/** Child fd of the seccomp blob: the first fd after stdin/stdout/stderr. */
export const SECCOMP_FD = 3;

export interface BwrapOptions {
  /** true → `--share-net` (host network kept). Default: isolated. */
  readonly shareNet: boolean;
  /** true → host `/tmp` bind-mounted. Default: private tmpfs. */
  readonly shareTmp: boolean;
  /** true → install the TS-built cBPF whitelist via `--seccomp`. */
  readonly seccomp: boolean;
  /** Absolute host directories masked with an empty tmpfs (opt-in). */
  readonly maskDirs: readonly string[];
}

/** Contract default: network isolated, `/tmp` private, no seccomp, no masks. */
export const DEFAULT_BWRAP_OPTIONS: BwrapOptions = {
  shareNet: false,
  shareTmp: false,
  seccomp: false,
  maskDirs: [],
};

const SHELL = "/bin/sh";

/**
 * Mount/namespace flags, in the one order that works. `workdir === null` is the
 * probe shape (no bind, no chdir) so the smoke test exercises exactly the mount
 * sequence production uses.
 */
export function buildBwrapArgv(workdir: string | null, options: BwrapOptions): string[] {
  const argv: string[] = ["--unshare-all", "--die-with-parent"];
  // ORDER IS SECURITY SEMANTICS — do not reorder (W274 §2):
  // the host root goes on first, the private devtmpfs/procfs on top of it.
  argv.push("--ro-bind", "/", "/");
  argv.push("--dev", "/dev");
  argv.push("--proc", "/proc");
  if (options.shareNet) argv.push("--share-net");
  if (options.shareTmp) argv.push("--bind", "/tmp", "/tmp");
  else argv.push("--tmpfs", "/tmp");
  for (const dir of options.maskDirs) argv.push("--tmpfs", dir);
  if (workdir !== null) argv.push("--bind", workdir, workdir, "--chdir", workdir);
  if (options.seccomp) argv.push("--seccomp", String(SECCOMP_FD));
  return argv;
}

/** The full `bwrap … -- /bin/sh -c <command>` argv (workdir bind included). */
export function buildBwrapCommand(workdir: string, options: BwrapOptions, command: string): string[] {
  return [...buildBwrapArgv(workdir, options), "--", SHELL, "-c", command];
}

/** The isolation actually in force — reported, never inferred by the caller. */
export function bwrapMeta(options: BwrapOptions): SandboxMeta {
  return {
    provider: BWRAP_PROVIDER,
    net_isolated: !options.shareNet,
    tmp_private: !options.shareTmp,
    seccomp: options.seccomp,
  };
}

/** Human-readable label for spawn failures (never contains the command body). */
export function bwrapLabel(options: BwrapOptions): string {
  const bits = [options.shareNet ? "share-net" : "net-isolated", options.shareTmp ? "host-tmp" : "private-tmp"];
  if (options.seccomp) bits.push("seccomp");
  if (options.maskDirs.length > 0) bits.push(`masked=${options.maskDirs.length}`);
  return `bwrap[${bits.join(",")}]`;
}
