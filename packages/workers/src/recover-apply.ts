/**
 * W1470 P2 — the ACTIONS the boot observation deliberately does not take.
 *
 * `recovery.ts` is the P0 JUDGEMENT (pure, read-only, §2.2.4): it says which
 * RUNNING rows a dead process left behind and what the decision table WOULD do
 * with them. This module is the other half — the executor — and it exists as a
 * separate module for exactly the reason the phase split exists:
 *
 *   - it is reachable ONLY behind `CELESTEA_WORKER_RECOVER=1` (`recoveryEnabled`);
 *   - it writes ONLY through the registry's own single write points
 *     (`claim` -> `finalize` / `respawn`), never by touching the table itself,
 *     so the terminal stamp, the atomic tmp+rename persist and the merge with a
 *     sibling session's rows all stay in one place;
 *   - it never invents evidence: the deliverable (`results/<wid>*.md`), the
 *     `lease=`/`proc=` owner liveness and `host=` are the only inputs, and they
 *     are the ones P0 already judged.
 *
 * What a restart can actually reach (the honest limit): `respawn` needs the
 * READABLE brief, which lives in the registry's memory by construction (W831 R3
 * B4 — the `brief=` token is folded and truncated), so after a restart a
 * `respawn` decision degrades to the FAILED terminal. That is the decision
 * table's own fallback, not a new rule.
 */

import type { WorkerEntry } from "@celestea/core";
import { pidAliveDefault, type WorkerRecoveryCandidate, type WorkerRecoveryReport } from "./recovery.js";
import type { WorkerVerdict } from "./types.js";

/** The environment switch of the P2 half (absent / any other value = OFF). */
export const ENV_WORKER_RECOVER = "CELESTEA_WORKER_RECOVER";

/** Is the P2 executor armed? Only the literal `1` arms it. */
export function recoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[ENV_WORKER_RECOVER]?.trim() === "1";
}

/** What one row's adjudication actually did. */
export type RecoveryOutcome = "closed_done" | "failed" | "respawned" | "observed" | "refused";

export interface RecoveryApplied {
  wid: string;
  action: WorkerRecoveryCandidate["action"];
  outcome: RecoveryOutcome;
  reason: string;
}

/**
 * The write port of the executor. `WorkerRegistry` satisfies it structurally —
 * this module never needs the table itself, only the three state-machine edges.
 */
export interface RecoveryTarget {
  /** Take a dead generation's RUNNING row under this process (see registry.claim). */
  claim(wid: string, pidAlive?: (pid: number) => boolean): WorkerEntry | null;
  /** The ONE terminal write point of the registry. */
  finalize(wid: string, verdict: WorkerVerdict): WorkerEntry | null;
  /** Re-dispatch from a remembered brief (null when there is none). */
  respawn(wid: string): string | null;
}

export interface RecoveryApplyOptions {
  /** Liveness probe of the CLAIM guard (default: `process.kill(pid, 0)`). */
  pidAlive?: (pid: number) => boolean;
}

/**
 * Execute the decision table of `report`. Rows judged STALE (their owner is
 * dead) are claimed and settled; rows that are only ORPHANS (the host
 * conversation is gone, the owner is alive) are reported and never touched —
 * §2.2.4 row 6 forbids re-dispatching them, and an alive owner means the row is
 * still somebody's.
 */
export function applyRecovery(
  target: RecoveryTarget,
  report: WorkerRecoveryReport,
  opts: RecoveryApplyOptions = {},
): RecoveryApplied[] {
  const alive = opts.pidAlive ?? pidAliveDefault;
  const applied: RecoveryApplied[] = [];
  for (const candidate of report.stale) applied.push(act(target, candidate, alive));
  for (const candidate of report.orphans) {
    if (report.stale.some((s) => s.wid === candidate.wid)) continue;
    applied.push({ wid: candidate.wid, action: candidate.action, outcome: "observed", reason: "orphan host: observed, never re-dispatched" });
  }
  return applied;
}

/** One stale row: claim it, then take the action P0 computed for it. */
function act(
  target: RecoveryTarget,
  candidate: WorkerRecoveryCandidate,
  alive: (pid: number) => boolean,
): RecoveryApplied {
  if (candidate.action === "observe") {
    return { wid: candidate.wid, action: candidate.action, outcome: "observed", reason: "decision table says observe" };
  }
  if (target.claim(candidate.wid, alive) === null) {
    return { wid: candidate.wid, action: candidate.action, outcome: "refused", reason: "row is not claimable (owned, frozen or another host's)" };
  }
  if (candidate.action === "close_done") {
    return settle(target, candidate, { ok: true, status: "DONE", reason: "recovered: deliverable exists" }, "closed_done");
  }
  if (candidate.action === "respawn" && target.respawn(candidate.wid) !== null) {
    return { wid: candidate.wid, action: candidate.action, outcome: "respawned", reason: "re-dispatched from a remembered brief" };
  }
  // §2.2.4: no deliverable and no usable brief (or retries exhausted) => FAILED.
  const reason = candidate.action === "respawn" ? "recovered: no recoverable brief" : `recovered: ${candidate.reason}`;
  return settle(target, candidate, { ok: false, reason }, "failed");
}

/** The terminal half: the registry refuses a foreign or frozen row (null). */
function settle(
  target: RecoveryTarget,
  candidate: WorkerRecoveryCandidate,
  verdict: WorkerVerdict,
  outcome: RecoveryOutcome,
): RecoveryApplied {
  const settled = target.finalize(candidate.wid, verdict);
  if (settled === null) {
    return { wid: candidate.wid, action: candidate.action, outcome: "refused", reason: "terminal write refused (foreign or frozen row)" };
  }
  return { wid: candidate.wid, action: candidate.action, outcome, reason: verdict.reason ?? "" };
}
