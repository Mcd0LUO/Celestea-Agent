/**
 * W831 R3 B4 (R2-A4): persist-failure observability.
 *
 * WorkerRegistry.persist() never throws (W180 B1(c)), so a failed atomic write
 * used to vanish: memory said DONE while disk still said RUNNING and nothing
 * warned. This module is the sink — a bounded in-memory record plus an optional
 * append-only alert log (a file, so the failure survives a restart).
 */

import { appendRotating } from "@celestea/core";

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

  /**
   * W1505 (P1-3): rotated at the same 16 MiB ceiling as every other diagnostic.
   * This sink shares `alerts.log` with the watchdog, so before this change it was
   * one of the two append-only logs in the repo that could grow without bound.
   */
  private append(line: string): void {
    if (this.alertsLog === null) return;
    appendRotating(this.alertsLog, line + "\n");
  }
}
