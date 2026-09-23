/**
 * Boot observation of the studio's own worker table (E §2.3 P0 ③).
 *
 * The startup sequence is: read the table this studio wrote in an earlier life →
 * judge every row (dead owner? missing host session?) → write ONE audit line per
 * finding plus one summary line → report on stderr.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: re-dispatch, settle, or rewrite a row. That
 * is the whole P0/P2 split — acting on a stale row before the tool
 * side-effect table exists turns "crash recovery" into a side-effect amplifier
 * (§5.1), and the DSH-side plugin is already the owner of liveness actions for
 * its own fleet. P0 only makes the situation VISIBLE, in three places:
 *
 *   1. `<data dir>/recovery-audit.jsonl` (the durable record);
 *   2. `GET /api/worker/status` → `stale[]` / `orphans[]` (the live view);
 *   3. `[celestea-worker-recovery]` on stderr (the operator's log).
 */

import { WorkerRegistry, applyRecovery, recoveryEnabled, type RecoveryApplied, type WorkerRecoveryCandidate, type WorkerRecoveryReport } from "@celestea/workers";
import { workerRecoveryBlock } from "./worker-table.js";
import type { RecoveryAuditWriter } from "./recovery-audit.js";

export interface WorkerBootObservationInput {
  /** The configured table path (null = in-memory: nothing to observe). */
  path: string | null;
  /** Does the host session that dispatched a worker still exist? */
  knownHost?: (sid: string) => boolean;
  /** Results dir of the deliverable probe. */
  resultsDir: string;
  audit?: RecoveryAuditWriter | null;
  now?: () => number;
  warn?: (message: string) => void;
  /**
   * W1470: where the P2 switch is read from (CELESTEA_WORKER_RECOVER). Optional
   * so the P0 observer's callers are unchanged; the P2 half falls back to the
   * process environment, like every other host-side switch.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Observe the table once, at boot. Never throws: an unreadable table is reported
 * and treated as empty (a damaged file must not stop the studio from starting).
 */
export function observeWorkerTableOnBoot(input: WorkerBootObservationInput): WorkerRecoveryReport {
  const report = workerRecoveryBlock({
    path: input.path,
    ...(input.knownHost === undefined ? {} : { knownHost: input.knownHost }),
    resultsDir: input.resultsDir,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  for (const row of report.stale) auditRow(input, row, "worker_stale");
  for (const row of report.orphans) auditRow(input, row, "worker_orphan");
  input.audit?.write({
    event: "worker_observed",
    session: null,
    count: report.stale.length + report.orphans.length,
    detail: `table=${input.path ?? "<memory>"} rows=${report.frozen.length + report.live.length + report.stale.length} live=${report.live.length} frozen=${report.frozen.length}`,
  });
  announce(input, report);
  return report;
}

/**
 * W1470 P2 (E §2.2.4): the boot ACTIONS the P0 sweep above deliberately does not
 * take — claim a dead generation's RUNNING row and settle it (DONE when the
 * deliverable exists, FAILED otherwise), never re-dispatch an orphan.
 *
 * ARMED ONLY BY `CELESTEA_WORKER_RECOVER=1`: without it this returns null and
 * the boot path is byte-for-byte the P0 observation it has always been. The
 * judgement is NOT recomputed here — it is the report P0 just produced, so the
 * action can never disagree with the line that was audited.
 */
export function recoverWorkerTableOnBoot(input: WorkerBootObservationInput, report: WorkerRecoveryReport): RecoveryApplied[] | null {
  if (!recoveryEnabled(input.env ?? process.env)) return null;
  const registry = new WorkerRegistry({
    tsvPath: input.path,
    resultsDir: input.resultsDir,
    sourceLabel: "celestea.studio-ts",
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const applied = applyRecovery(registry, report);
  for (const row of applied) auditApplied(input, row);
  announceApplied(input, applied);
  return applied;
}

/** One audit line per ACTION (the P0 lines already recorded the judgement). */
function auditApplied(input: WorkerBootObservationInput, row: RecoveryApplied): void {
  input.audit?.write({
    event: "worker_recovered",
    session: null,
    wid: row.wid,
    reason: row.reason,
    action: row.action,
    count: 1,
    detail: `outcome=${row.outcome}`,
  });
}

/** The stderr line of the action half: one line, and only when something ran. */
function announceApplied(input: WorkerBootObservationInput, applied: readonly RecoveryApplied[]): void {
  const warn = input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const acted = applied.filter((row) => row.outcome !== "observed");
  if (acted.length === 0) return;
  warn(`[celestea-worker-recovery] CELESTEA_WORKER_RECOVER=1 applied: ${acted.map((r) => `${r.wid}(${r.action}->${r.outcome})`).join(", ")}`);
}

/** One audit line per finding — the row's identity, never its brief (§4.4). */
function auditRow(input: WorkerBootObservationInput, row: WorkerRecoveryCandidate, event: "worker_stale" | "worker_orphan"): void {
  input.audit?.write({
    event,
    session: row.host_session,
    wid: row.wid,
    attempt: row.attempt,
    host_session: row.host_session,
    reason: row.reason,
    action: row.action,
    count: row.retries,
    detail: `lease=${row.lease_pid === null ? "none" : `${row.lease_pid}@${row.lease_at ?? 0}`} artifact=${row.artifact ? "yes" : "no"}`,
  });
}

/** The stderr summary: one line, and only when there is something to say. */
function announce(input: WorkerBootObservationInput, report: WorkerRecoveryReport): void {
  const warn = input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (report.stale.length === 0 && report.orphans.length === 0) return;
  const names = (rows: readonly WorkerRecoveryCandidate[]): string => rows.map((r) => `${r.wid}(${r.reason}${r.artifact ? ",artifact" : ""})`).join(", ");
  warn(`[celestea-worker-recovery] observed only, no re-dispatch: stale=[${names(report.stale)}] orphans=[${names(report.orphans)}]`);
}
