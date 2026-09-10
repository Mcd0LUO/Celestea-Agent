/**
 * Worker orchestration bridge: the `POST /api/worker/*` surface is a thin proxy
 * over the engine's own worker tools (Rust `src/api.rs:437-503`), and the two
 * `GET` surfaces read the in-process registry directly.
 *
 * Keeping the mapping here means the adapter never re-implements orchestration:
 * `spawn_worker` / `session_send_message` are DISPATCHED through the composed
 * `ToolRegistry` (so the HTTP surface and the model's tool surface cannot
 * drift), while `worker_status` reads the same registry summary the tool reads.
 */

import { isRecord, type ToolRegistry } from "@celestea/core";
import { projectMessages } from "@celestea/session";
import type { WorkerRegistry } from "@celestea/workers";
import type { WorkerSessionRow, WorkerSpawnOutcome, WorkerStatusReport } from "../runtime-adapter.js";

/** Engine-memory worker sessions (`worker:<sid>`, pseudo-workspace "engine"). */
export function workerSessionsOf(registry: WorkerRegistry | null, hostSessionId: string | null): WorkerSessionRow[] {
  if (registry === null) return [];
  return registry.sessions
    .metas()
    .filter((m) => m.id !== hostSessionId)
    .map((m) => ({
      id: `worker:${m.id}`,
      workspace: "engine",
      kind: "worker" as const,
      title: m.title,
      model: m.model,
      size: registry.sessions.logOf(m.id)?.events().length ?? 0,
      modified: 0,
      active: false,
    }));
}

/** Studio projection of a worker session transcript (null = unknown session). */
export function workerMessagesOf(registry: WorkerRegistry | null, sessionId: string): unknown[] | null {
  const sid = sessionId.startsWith("worker:") ? sessionId.slice("worker:".length) : sessionId;
  const log = registry?.sessions.logOf(sid);
  return log === undefined ? null : projectMessages(log.events());
}

/** Dispatch one worker tool through the composed registry. */
export async function dispatchWorkerTool(
  registry: ToolRegistry | null,
  name: string,
  args: Record<string, unknown>,
  callId: string,
): Promise<Record<string, unknown> | null> {
  if (registry === null) return null;
  const out = await registry.dispatch({ call_id: callId, name, args });
  return isRecord(out.value) ? out.value : null;
}

/** `spawn_worker` value envelope -> the HTTP outcome (`{ok, sessionId, title, wid}`). */
export function spawnOutcomeOf(value: Record<string, unknown> | null): WorkerSpawnOutcome {
  if (value === null) return { ok: false, error: "worker registry is not wired" };
  if (value["ok"] !== true) return { ok: false, error: String(value["error"] ?? "worker spawn failed"), value };
  return { ok: true, sessionId: String(value["sessionId"]), title: String(value["title"]), wid: String(value["wid"]) };
}

/** `session_send_message` value envelope -> the response body (verbatim). */
export function sendBodyOf(value: Record<string, unknown> | null): Record<string, unknown> {
  return value ?? { ok: false, delivered: false, error: "worker registry is not wired" };
}

/** `worker_status` tool/registry payload -> the frozen HTTP shape. */
export function toStatusReport(raw: Record<string, unknown> | null, wid: string | undefined): WorkerStatusReport {
  if (raw === null || raw["ok"] !== true) {
    const error = raw === null ? "worker registry is not wired" : String(raw["error"] ?? "");
    return { ok: false, total: 0, by_status: {}, by_state: {}, workers: [], ...(wid === undefined ? {} : { wid }), error };
  }
  const byStatus = (raw["by_status"] ?? {}) as Record<string, number>;
  const byState = (raw["by_state"] ?? {}) as Record<string, number>;
  if (wid === undefined) {
    return { ok: true, total: Number(raw["total"] ?? 0), by_status: byStatus, by_state: byState, workers: (raw["workers"] ?? []) as unknown[] };
  }
  const workers = raw["worker"] === undefined ? [] : [raw["worker"]];
  return { ok: true, total: workers.length, by_status: byStatus, by_state: byState, workers, wid };
}
