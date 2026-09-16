/**
 * W831 R3 B4 (R2-A4): persist-failure observability.
 *
 * WorkerRegistry.persist() never throws (W180 B1(c)), so a failed atomic write
 * used to vanish: memory said DONE while disk still said RUNNING and nothing
 * warned. This module is the sink — a bounded in-memory record plus an optional
 * append-only alert log (a file, so the failure survives a restart).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One failed persist, recorded so it cannot be silent. */
export interface PersistFailure {
  /** UTC stamp of the failed write. */
  at: string;
  /** Table path the write targeted. */
  path: string;
  /** Row the write was about (null when the caller had none). */
  wid: string | null;
  /** The error string WorkerRegistry.persist() returned. */
  error: string;
}

/** Retained failures (diagnostics are bounded, never a second leak). */
const LIMIT = 100;

export class PersistFailureLog {
  private readonly entries: PersistFailure[] = [];
  private readonly alertsLog: string | null;

  constructor(alertsLog: string | null = null) {
    this.alertsLog = alertsLog;
  }

  record(failure: PersistFailure): void {
    if (this.entries.length >= LIMIT) this.entries.shift();
    this.entries.push(failure);
    process.stderr.write("[celestea-workers] registry persist failed: " + failure.error + "\n");
    this.append(
      "[" + failure.at + "] registry persist failed wid=" + (failure.wid ?? "-") + " path=" + failure.path + ": " + failure.error,
    );
  }

  list(): readonly PersistFailure[] {
    return [...this.entries];
  }

  private append(line: string): void {
    if (this.alertsLog === null) return;
    try {
      mkdirSync(dirname(this.alertsLog), { recursive: true });
      appendFileSync(this.alertsLog, line + "\n", "utf8");
    } catch {
      // The alert sink is diagnostics, not state (W180 B1(c)).
    }
  }
}
