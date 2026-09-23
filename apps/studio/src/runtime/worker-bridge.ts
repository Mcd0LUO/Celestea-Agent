/**
 * Worker orchestration bridge: the `POST /api/worker/*` surface is a thin proxy
 * over the engine's own worker tools (`src/api.rs:437-503`), and the two
 * `GET` surfaces read the in-process registries directly.
 *
 * Keeping the mapping here means the adapter never re-implements orchestration:
 * `spawn_worker` / `session_send_message` are DISPATCHED through the composed
 * `ToolRegistry` (so the HTTP surface and the model's tool surface cannot
 * drift), while `worker_status` reads the same registry summary the tool reads.
 *
 * W513: each session runtime owns its own registry, so the rows carry the
 * owning host session (`host_session`) and the worker id / registry status /
 * driver state — enough for `GET /api/sessions` to list workers per session and
 * for the host to aggregate a process-wide `worker_status`.
 */

import { isRecord, type ToolRegistry, type WorkerEntry } from "@celestea/core";
import { projectMessages } from "@celestea/session";
import { getExtra, workerAttempt, workerHost, workerTitle, type WorkerRegistry } from "@celestea/workers";
import type {
  WorkerContextUsage,
  WorkerSessionRow,
  WorkerSpawnOutcome,
  WorkerStatusReport,
  WorkerStatusRow,
} from "../runtime-adapter.js";
import { toStatusRow } from "./worker-status-row.js";

/**
 * Engine-memory worker sessions (`worker:<sid>`, pseudo-workspace "engine").
 *
 * W740: the row is ENTRY-driven, not conversation-driven. A settled worker gives
 * up its conversation (W736's receipt path; the watchdog's F2 release), so a
 * projection that only walked `registry.sessions.metas()` dropped every
 * DONE/FAILED worker out of the panel the moment it finished — exactly the
 * opposite of what a status view is for. Each registry row emits a panel row,
 * enriched with the live conversation while one still exists.
 */
export function workerSessionsOf(registry: WorkerRegistry | null, hostSessionId: string | null): WorkerSessionRow[] {
  if (registry === null) return [];
  return registry.ownEntries().map((entry) => {
    const sid = getExtra(entry, "sess") ?? "";
    const meta = sid === "" ? undefined : registry.sessions.get(sid)?.meta;
    return {
      id: `worker:${sid === "" ? entry.wid : sid}`,
      workspace: "engine",
      kind: "worker" as const,
      title: meta?.title ?? entry.wid,
      model: meta?.model ?? getExtra(entry, "model"),
      // W729 §2.3: the mode recorded at spawn (parent mode unless overridden).
      mode: meta?.mode ?? getExtra(entry, "mode") ?? "standard",
      size: registry.sessions.logOf(sid)?.events().length ?? 0,
      modified: 0,
      active: false,
      wid: entry.wid,
      // W894: the worker's own conversation, so a caller can measure ITS context.
      sess: sid === "" ? null : sid,
      // W894: when this worker was dispatched (registry `started_at`).
      started_at: entry.started_at,
      status: entry.status,
      state: getExtra(entry, "state") ?? "",
      host_session: hostSessionId,
      // W1470b: the dispatching conversation, in the field the tree ALREADY
      // reads for lineage (parentSessionId). The frontend has grouped by it
      // since W515 and the backend simply never sent it, so every worker fell
      // into the "unlinked" bucket; sending it also keeps the per-session
      // worker strip from mistaking an inherited row for this session own.
      parentSessionId: hostSessionId,
      // E §2.3 P1 ③ (W787): which try this row is and the key of the receipt it
      // already delivered — the two facts a coordinator needs to tell a
      // re-dispatch from a duplicate.
      attempt: workerAttempt(entry),
      last_receipt: getExtra(entry, "receipt"),
    };
  });
}

/**
 * W1470b — the panel row of one PERSISTED row of a previous generation.
 *
 * The facts come from the ROW itself (it is the durable record): `sess` names
 * the conversation, `title` the folded short name, `status`/`state` the last
 * known lifecycle, `model`/`mode` the spawn parameters. What the row cannot
 * carry is measured as absent, never invented: the transcript is memory-only
 * (`size: 0`) and there is no live pane to be busy.
 *
 * `inherited: true` is the SAME marker the tool face uses (`worker_status` ->
 * `inherited`), and `parentSessionId` is the dispatching conversation, so the
 * row lands under its session instead of "unlinked".
 */
export function inheritedRowOf(entry: WorkerEntry): WorkerSessionRow {
  const sess = getExtra(entry, "sess") ?? "";
  const short = getExtra(entry, "title");
  const host = workerHost(entry);
  return {
    id: `worker:${sess === "" ? entry.wid : sess}`,
    workspace: "engine",
    kind: "worker",
    title: short === null ? entry.wid : workerTitle(entry.wid, short),
    model: getExtra(entry, "model"),
    mode: getExtra(entry, "mode") ?? "standard",
    size: 0,
    modified: 0,
    active: false,
    wid: entry.wid,
    sess: sess === "" ? null : sess,
    started_at: entry.started_at,
    status: entry.status,
    state: getExtra(entry, "state") ?? "",
    host_session: host,
    parentSessionId: host,
    attempt: workerAttempt(entry),
    last_receipt: getExtra(entry, "receipt"),
    busy: false,
    inherited: true,
  };
}

/** W1470b: project every inherited table row for the panel (one place). */
export function inheritedPanelRows(entries: readonly WorkerEntry[]): WorkerSessionRow[] {
  return entries.map((entry) => inheritedRowOf(entry));
}

/**
 * Process-wide `worker_status` fold over the merged rows (W513).
 *
 * W894: `contextOf` measures ONE worker's context occupancy from its own conversation
 * (`sess`). It is injected rather than imported so this module stays a pure view layer
 * — the adapter owns the engine, and only it can answer "how full is that session".
 * Rows without a `sess` (legacy rows) report `context: null`, never a fake zero.
 */
export function aggregateWorkerStatus(
  rows: readonly WorkerSessionRow[],
  wid?: string,
  contextOf?: (sess: string) => WorkerContextUsage | null,
  /** W1470b: previous-generation rows — reported, NEVER counted (see below). */
  inherited: readonly WorkerSessionRow[] = [],
): WorkerStatusReport {
  const scoped = wid === undefined ? [...rows] : rows.filter((row) => row.wid === wid);
  const by_status: Record<string, number> = {};
  const by_state: Record<string, number> = {};
  for (const row of scoped) {
    const status = row.status ?? "RUNNING";
    by_status[status] = (by_status[status] ?? 0) + 1;
    // W894: `by_state` is the DRIVER state of RUNNING workers only. The previous
    // version counted a finished row's stale state as `idle`, so `idle` grew with
    // every DONE worker — a number that answered nothing. This now matches
    // packages/workers `summarize` exactly (one fold, one meaning).
    if (status !== "RUNNING") continue;
    const state = row.state ?? "";
    if (state === "in-turn") by_state["in-turn"] = (by_state["in-turn"] ?? 0) + 1;
    else if (state === "idle") by_state["idle"] = (by_state["idle"] ?? 0) + 1;
    else by_state["running"] = (by_state["running"] ?? 0) + 1;
  }
  const project = (row: WorkerSessionRow): WorkerStatusRow => {
    const sess = row.sess ?? "";
    return toStatusRow(row, sess === "" || contextOf === undefined ? null : contextOf(sess));
  };
  if (wid !== undefined && scoped.length === 0) {
    // W1470b: a wid the PERSISTED table still names is KNOWN — reported with
    // `ok: true` and `inherited: true` on the row, while `total`/`by_status`
    // keep counting the current generation only (an inherited row is not a
    // running worker of this generation, and must not inflate those numbers).
    const ghosts = inherited.filter((row) => row.wid === wid);
    if (ghosts.length > 0) return { ok: true, total: 0, by_status, by_state, workers: [], wid, inherited: ghosts.map(project) };
    return { ok: false, total: 0, by_status, by_state, workers: [], wid, error: `no worker ${wid} in registry` };
  }
  const report: WorkerStatusReport = { ok: scoped.length > 0, total: scoped.length, by_status, by_state, workers: scoped.map(project), ...(wid === undefined ? {} : { wid }) };
  // The unfiltered (panel) view lists them; a wid lookup about a live worker does not.
  return wid !== undefined || inherited.length === 0 ? report : { ...report, inherited: inherited.map(project) };
}

/** Studio projection of a worker session transcript (null = unknown session). */
/**
 * W769: the runtime facts these aggregations need about ONE session instance —
 * structural, so the adapter passes its own `SessionRuntime` rows straight in and
 * this module never imports the runtime package (it stays a pure view layer).
 */
export interface WorkerHostEntry {
  sessionId: string | null;
  dir: string | null;
  inFlight: boolean;
  runtime: { workers: WorkerRegistry | null; hostSessionId: string | null; tools: ToolRegistry | null };
}

/** Merged worker rows over every live instance (W513 aggregate view). */
export function mergedWorkerRows(entries: readonly WorkerHostEntry[]): WorkerSessionRow[] {
  const rows: WorkerSessionRow[] = [];
  for (const entry of entries) {
    for (const row of workerSessionsOf(entry.runtime.workers, entry.runtime.hostSessionId)) {
      rows.push({ ...row, host_session: entry.sessionId, busy: entry.inFlight });
    }
  }
  return rows;
}

/** The messages of one worker session, from whichever live instance owns it. */
export function workerMessagesAcross(entries: readonly WorkerHostEntry[], sessionId: string): unknown[] | null {
  for (const entry of entries) {
    const found = workerMessagesOf(entry.runtime.workers, sessionId);
    if (found !== null) return found;
  }
  return null;
}

/** `POST /api/worker/spawn`: the spawn tool, dispatched through the session's own registry. */
export async function spawnWorkerThrough(
  entry: WorkerHostEntry,
  req: { wid: string; brief: string; title?: string; model?: string; report_to?: string },
  callId: string,
): Promise<WorkerSpawnOutcome> {
  const args: Record<string, unknown> = { wid: req.wid, brief: req.brief };
  for (const key of ["title", "model"] as const) {
    const value = req[key];
    if (value !== undefined) args[key] = value;
  }
  // W513: an unaddressed worker reports back to the session that spawned it.
  args["report_to"] = req.report_to ?? entry.runtime.hostSessionId ?? "";
  return spawnOutcomeOf(await dispatchWorkerTool(entry.runtime.tools, "spawn_worker", args, callId));
}

/**
 * `POST /api/worker/send`: the worker's registry is per session, so the message is
 * routed to the instance that owns the target — the first one that accepts it wins.
 */
export async function sendWorkerThrough(
  entries: readonly WorkerHostEntry[],
  req: { target: string; content: string },
  callId: () => string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | null = null;
  for (const entry of entries) {
    const body = sendBodyOf(
      await dispatchWorkerTool(entry.runtime.tools, "send_message", { target: req.target, content: req.content }, callId()),
    );
    if (body["ok"] === true) return body;
    last = body;
  }
  return last ?? { ok: false, delivered: false, error: "worker registry is not wired" };
}

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

/** `send_message` value envelope -> the response body (verbatim). */
export function sendBodyOf(value: Record<string, unknown> | null): Record<string, unknown> {
  return value ?? { ok: false, delivered: false, error: "worker registry is not wired" };
}

