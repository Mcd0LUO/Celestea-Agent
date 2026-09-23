/**
 * W894 — the worker status REPORT's row projection.
 *
 * Split out of `worker-bridge.ts` for two reasons: that module crossed the 400-line
 * budget, and this is a separate concern anyway — the bridge SPAWNS and MESSAGES
 * workers, while this decides what a status ROW is.
 */
import type { WorkerContextUsage, WorkerSessionRow, WorkerStatusRow } from "../runtime-adapter.js";

/** Panel row -> the lean status row, tagged with its live context occupancy. */
export function toStatusRow(row: WorkerSessionRow, context: WorkerContextUsage | null): WorkerStatusRow {
  return {
    wid: row.wid ?? "",
    sess: row.sess ?? null,
    host_session: row.host_session ?? null,
    title: row.title,
    status: row.status ?? "RUNNING",
    state: row.state ?? "",
    model: row.model,
    mode: row.mode,
    size: row.size,
    attempt: row.attempt ?? 0,
    last_receipt: row.last_receipt ?? null,
    started_at: row.started_at ?? "",
    busy: row.busy === true,
    context,
    // W1470b: the marker must SURVIVE the projection — the status report is
    // where a caller reads it, and dropping it here would make `inherited[]`
    // indistinguishable from a live worker of this generation.
    ...(row.inherited === true ? { inherited: true as const } : {}),
  };
}
