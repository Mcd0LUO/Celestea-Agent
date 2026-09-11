/**
 * Boot recovery of the ACTIVE session (E §1.3 P0 ③, §1.6 apps/studio row).
 *
 * `workspaces.json.active_session` is the one session the host knows was in use
 * when the process stopped, so that is the session it repairs at startup — before
 * any instance exists for it, which matters because a composed instance replays
 * the log and derives its turn counter from it (E §1.3 P0 ④).
 *
 * The heavy lifting (decision table, append-only repair) lives in the engine
 * packages; this module only answers "WHICH directory" and reports the outcome on
 * the P0 observation channel (stderr; the durable record is the sidecar's
 * `repaired[]`). Recovery never throws and never fails the boot: a damaged
 * sidecar or an unknown session id must not stop the studio from starting.
 */

import { recoverSessionOnBoot, type BootRecoveryReport } from "@celestea/runtime";
import type { SessionsStore } from "../store/sessions.js";
import type { WorkspacesStore } from "../store/workspaces.js";
import { sessionIdOfDir } from "./engine-grants.js";

export interface BootRecoveryInput {
  workspaces: Pick<WorkspacesStore, "activeSession">;
  sessions: Pick<SessionsStore, "resolve">;
  now?: () => number;
  warn?: (message: string) => void;
}

/** Recover the previously active session; null when there is nothing to look at. */
export function recoverActiveSessionOnBoot(input: BootRecoveryInput): BootRecoveryReport | null {
  const warn = input.warn ?? defaultWarn;
  const active = input.workspaces.activeSession();
  if (active === null || active.trim() === "") return null;
  const resolved = input.sessions.resolve(active);
  if (!resolved.ok) {
    warn(`[celestea-recovery] active session '${active}' does not resolve — nothing to recover`);
    return null;
  }
  // The sidecar's self-description must be the SAME string a live instance
  // writes, and that one is derived from the directory (`<workspace>/<session>`,
  // the id grants.json uses too) — never the host id, which may spell the
  // workspace differently. A mismatch would void the file (fail-safe, but then
  // nothing would ever be repaired).
  const report = recoverSessionOnBoot({
    dir: resolved.value.dir,
    session: sessionIdOfDir(resolved.value.dir),
    ...(input.now === undefined ? {} : { now: input.now }),
    warn,
  });
  announce(report, warn);
  return report;
}

/** The P0 visibility rule: a repair, a skip that hides a dangling turn, a warning. */
function announce(report: BootRecoveryReport, warn: (message: string) => void): void {
  if (report.appended) {
    warn(`[celestea-recovery] ${report.session}: closed interrupted ${String(report.turn_id)} (crash recovery, ${report.dangling_before.length} dangling turn(s) before)`);
  } else if (report.action === "skipped_no_checkpoint" && report.dangling_before.length > 0) {
    warn(`[celestea-recovery] ${report.session}: ${report.dangling_before.length} dangling turn(s) left untouched — no checkpoint (fail-safe)`);
  }
  for (const message of report.warnings) warn(`[celestea-recovery] ${message}`);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}
