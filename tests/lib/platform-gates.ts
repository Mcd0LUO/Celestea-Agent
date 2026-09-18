/**
 * W885 — the shared platform capability gates (W883 §7).
 *
 * The repo already gates OS-specific suites with `describe.skipIf` /
 * `it.skipIf` (`bwrap-live.test.ts`, `auth.test.ts`, `broker.test-util.ts`).
 * This module is the ONE place a suite under `tests/` reads them from, so a
 * Windows host can run `pnpm test` green with VISIBLE skips instead of a
 * scattering of hardcoded `process.platform` checks — and so an OS-specific
 * assumption cannot be written as a bare `if (!ready) return` (which the repo
 * counts as a PASS, not a skip).
 *
 * The probe-backed predicates come from `@celestea/tools` (they memoize one
 * `probeHost()`); the pure platform flags are the cheap constants beside them.
 * Use them at the TOP of a file:
 *
 *   const gates = platformGates();
 *   describe.skipIf(!gates.posixShell)("...", () => { ... });
 */

import {
  FILE_MODES_MEANINGFUL,
  POSIX_PROCESS_GROUPS,
  POSIX_SHELL,
  platformGates,
} from "@celestea/tools";

const probe = platformGates();

/** bubblewrap really works (ordered mount + device smoke already passed). */
export const bwrapUsable: boolean = probe.bwrapUsable;
/** `prlimit` is present (util-linux; absent on macOS and Windows). */
export const prlimitUsable: boolean = probe.prlimitUsable;
/** A POSIX `/bin/sh` exists (false on Windows). */
export const posixShell: boolean = POSIX_SHELL;
/** `#!/bin/sh` scripts and `sh -c` are real (false on Windows). */
export const posixScripts: boolean = POSIX_SHELL;
/** Signal / process-group semantics exist (false on Windows). */
export const posixProcessGroups: boolean = POSIX_PROCESS_GROUPS;
/** File permission bits are meaningful (false on Windows). */
export const fileModesMeaningful: boolean = FILE_MODES_MEANINGFUL;
/** The external `htpasswd` binary the login gate shells out to. */
export const htpasswdUsable: boolean = probe.htpasswdUsable;
/** `python3` answers on the host (the Python matrix / broker probes). */
export const python3Usable: boolean = probe.python3Usable;
/** Everything a POSIX-only suite needs at once. */
export const posixOnly: boolean = probe.posixOnly;

/**
 * A `#!/bin/sh` script the sandbox can execute, or `null` when the host has no
 * POSIX shell. `null` means "skip me", never "pass": gate with
 * `describe.skipIf(script === null)`.
 */
export function posixScript(body: string): string | null {
  return posixShell ? "#!/bin/sh\n" + body + "\n" : null;
}
