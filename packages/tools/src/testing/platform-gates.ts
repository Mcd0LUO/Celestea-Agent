/**
 * W885 — the shared platform capability gates (W883 §7).
 *
 * The repo already gates OS-specific suites with `describe.skipIf` /
 * `it.skipIf` (`bwrap-live.test.ts`, `auth.test.ts`, `broker.test-util.ts`).
 * This module is the ONE place those predicates live, so a Windows host can run
 * `pnpm test` green with VISIBLE skips instead of a scattering of hardcoded
 * `process.platform` checks — and so a new OS-specific assumption cannot be
 * written as a bare `if (!ready) return` (which the repo counts as a PASS, not a
 * skip).
 *
 * The snapshot is a **memoized function**, not four module-level constants:
 * probeHost() costs two short execFileSyncs, and importing `@celestea/tools`
 * must not pay for them. Call `platformGates()` once at the top of a test file:
 *
 *   const gates = platformGates();
 *   describe.skipIf(!gates.posixScripts)("...", () => { ... });
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { probeHost } from "../sandbox/probe.js";

/** The capabilities a test suite may depend on, honestly measured. */
export interface PlatformGates {
  /** bubblewrap really works (ordered mount + device smoke already passed). */
  readonly bwrapUsable: boolean;
  /** `prlimit` is present (util-linux; absent on macOS and Windows). */
  readonly prlimitUsable: boolean;
  /** A POSIX `/bin/sh` exists (false on Windows). */
  readonly posixShell: boolean;
  /** `#!/bin/sh` scripts and `sh -c` are real (false on Windows). */
  readonly posixScripts: boolean;
  /** Signal / process-group semantics exist (false on Windows). */
  readonly posixProcessGroups: boolean;
  /** File permission bits are meaningful (false on Windows). */
  readonly fileModesMeaningful: boolean;
  /** The external `htpasswd` binary the login gate shells out to. */
  readonly htpasswdUsable: boolean;
  /** `python3` answers on the host (the Python matrix / broker probes). */
  readonly python3Usable: boolean;
  /** Everything a POSIX-only suite needs at once. */
  readonly posixOnly: boolean;
}

let cached: PlatformGates | null = null;

/** Measure (once per process) what this host can honestly do. */
export function platformGates(): PlatformGates {
  if (cached !== null) return cached;
  const probe = probeHost();
  const posixShell = process.platform !== "win32" && existsSync("/bin/sh");
  const posixProcessGroups = process.platform !== "win32";
  cached = {
    bwrapUsable: probe.bwrapUsable,
    prlimitUsable: probe.prlimitPath !== null,
    posixShell,
    posixScripts: posixShell,
    posixProcessGroups,
    fileModesMeaningful: posixProcessGroups,
    htpasswdUsable: whichUsable("htpasswd"),
    python3Usable: whichUsable("python3"),
    posixOnly: posixShell && posixProcessGroups,
  };
  return cached;
}

/** `spawnSync(bin, ["--version"])` exits 0 — an honest "the binary runs" test. */
export function whichUsable(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * W885 — cheap, probe-free capability flags for tests that only need the
 * platform truth (no filesystem probe). Prefer [platformGates] when the answer
 * needs the host probe; these two are safe to read at module scope.
 */

/** File permission bits are meaningful (false on Windows). */
export const FILE_MODES_MEANINGFUL: boolean = process.platform !== "win32";

/** POSIX signal / process-group semantics exist (false on Windows). */
export const POSIX_PROCESS_GROUPS: boolean = process.platform !== "win32";

/** A POSIX `/bin/sh` exists (false on Windows). */
export const POSIX_SHELL: boolean = process.platform !== "win32" && existsSync("/bin/sh");
