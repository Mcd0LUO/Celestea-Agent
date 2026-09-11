/**
 * Boot recovery — "close the turn the previous process died inside" (§1.3 P0 ③).
 *
 * This is the ONLY caller of the §1.2.3 decision table that owns a session
 * DIRECTORY: it checks that a log exists at all (a session that never ran must
 * not gain an empty `cli-main.jsonl` because the host scanned it), opens the log
 * through the persistent implementation — so a torn tail left by the crash is
 * truncated exactly like it would be on the next turn — and then lets the pure
 * decision function in `@celestea/session` do the (append-only) repair.
 *
 * Layering: runtime -> session is a downward edge (L2 -> L1) and already the
 * package's own dependency; the DECISION itself stays in the session package
 * because it is about the log + sidecar contract, not about assembly.
 *
 * The report is the observability channel of P0 (§5.2 ①): the host logs it, and
 * the sidecar's `repaired[]` keeps the durable record. P0 adds no endpoint.
 */

import { existsSync } from "node:fs";
import type { SessionLog } from "@celestea/core";
import {
  CheckpointStore,
  checkpointPathFor,
  filePathFor,
  PersistentSessionLog,
  recoverOpenTurn,
  writeErrorCountOf,
  type CheckpointIdentity,
  type CheckpointRead,
  type RecoveryAction,
} from "@celestea/session";

/** The engine's log file name / id inside a session directory (contract). */
export const SESSION_LOG_ID = "cli-main";

/** `<dir>/cli-main.jsonl` — the log this orchestrator may repair. */
export function sessionLogPath(dir: string, sessionId: string = SESSION_LOG_ID): string {
  return filePathFor(dir, sessionId);
}

export type BootRecoveryAction = RecoveryAction | "skipped_absent_log";

export interface BootRecoveryOptions {
  /** Session directory (`<workspace>/<session>`). */
  dir: string;
  /** Self-description of the sidecar (`<workspace>/<session>`). */
  session: string;
  identity?: CheckpointIdentity;
  now?: () => number;
  warn?: (message: string) => void;
  /** Log opener override (tests); default = the persistent JSONL log. */
  open?: (dir: string) => SessionLog;
}

export interface BootRecoveryReport {
  session: string;
  dir: string;
  action: BootRecoveryAction;
  turn_id: string | null;
  /** True when exactly one `turn_end: interrupted` row was appended. */
  appended: boolean;
  dangling_before: string[];
  dangling_after: string[];
  checkpoint: CheckpointRead["kind"];
  warnings: string[];
}

/** Recover ONE session directory. Never throws; nothing is created for a session that never ran. */
export function recoverSessionOnBoot(opts: BootRecoveryOptions): BootRecoveryReport {
  const logPath = sessionLogPath(opts.dir);
  const exists = existsSync(logPath);
  const store = new CheckpointStore({
    dir: opts.dir,
    session: opts.session,
    ...(opts.identity === undefined ? {} : { identity: opts.identity }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.warn === undefined ? {} : { warn: opts.warn }),
  });
  const checkpoint = store.load();
  const base = { opts, checkpoint, before: [] as string[], after: [] as string[] };
  if (!exists) return report({ ...base, action: "skipped_absent_log", turnId: null, appended: false, warnings: store.warnings() });
  const log = (opts.open ?? defaultOpen)(opts.dir);
  try {
    const outcome = recoverOpenTurn(log, store);
    return report({
      opts,
      action: outcome.action,
      turnId: outcome.turn_id,
      appended: outcome.appended,
      before: outcome.dangling_before,
      after: outcome.dangling_after,
      checkpoint: store.load(),
      warnings: outcome.warnings,
    });
  } finally {
    closeLog(log);
  }
}

function defaultOpen(dir: string): SessionLog {
  return PersistentSessionLog.open(dir, SESSION_LOG_ID);
}

interface ReportParts {
  opts: BootRecoveryOptions;
  action: BootRecoveryAction;
  turnId: string | null;
  appended: boolean;
  before: string[];
  after: string[];
  checkpoint: CheckpointRead;
  warnings: readonly string[];
}

function report(parts: ReportParts): BootRecoveryReport {
  const all = [...parts.warnings];
  if (parts.checkpoint.kind === "invalid") {
    all.push(`checkpoint invalid at ${checkpointPathFor(parts.opts.dir)}: ${parts.checkpoint.error}`);
  }
  return {
    session: parts.opts.session,
    dir: parts.opts.dir,
    action: parts.action,
    turn_id: parts.turnId,
    appended: parts.appended,
    dangling_before: parts.before,
    dangling_after: parts.after,
    checkpoint: parts.checkpoint.kind,
    warnings: all,
  };
}

/** Release the descriptor a persistent log owns (no-op for any other log). */
function closeLog(log: SessionLog | null): void {
  const close = (log as { close?: unknown } | null)?.close;
  if (typeof close === "function") close.call(log);
}
