/**
 * `RuntimeAdapter` — the ONE seam between the Studio host and the engine.
 *
 * P4 ships the Hono layer plus the data stores; the real runtime
 * (`packages/runtime` compose + agent-loop + llm + tools) lands on a separate
 * workstream. Everything the engine owns is therefore expressed here as an
 * injected interface, and P4 verifies the contract against a fake adapter:
 *
 *   POST /api/turn                     -> startTurn()   (busy slot = 409)
 *   GET  /api/events                   -> attach(bus)   (the adapter emits)
 *   POST /api/cancel                   -> cancel()
 *   POST /api/clear                    -> clear(session)
 *   POST /api/sessions/{id}/compact    -> compact(session)
 *   GET  /api/status                   -> statusline()
 *   GET  /api/tools                    -> tools()
 *   GET+POST /api/config               -> profile() / configure(patch)
 *   POST /api/worker/{spawn,send}      -> workerSpawn() / workerSend()
 *   GET  /api/worker/status            -> workerStatus(wid?)
 *   GET  /api/sessions (worker rows)   -> workerSessions()
 *   GET  /api/sessions/worker:<sid>/…  -> workerMessages(sid)
 *
 * Replacing the fake with the real runtime is a one-line change in
 * `createStudioApp({ runtime })` — no handler changes, no route changes.
 */

import type { Statusline } from "@celestea/core";
import type { StudioBus } from "./sse.js";

/** Verbatim engine error text (Rust `{e}` placeholders). */
export class EngineError extends Error {
  readonly kind = "engine";
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/** Thrown by `startTurn` when the single-concurrency slot is occupied (409). */
export class TurnBusyError extends Error {
  readonly kind = "busy";
  constructor(message = "a turn is already running") {
    super(message);
    this.name = "TurnBusyError";
  }
}

export interface EngineProfile {
  model: string;
  base_url: string;
  reasoning_effort: string | null;
  max_steps: number;
  max_parallel_tool_calls: number;
  max_output_tokens: number | null;
  context_window: number;
  api_key_env: string;
  /** Registry-assembled (or overridden) system prompt. */
  system_prompt: string;
}

/** `POST /api/config` accepted patch: the host validates, the engine applies. */
export interface ProfilePatch {
  model?: string;
  reasoning_effort?: string | null;
  base_url?: string;
  /** Goes into the process env only: never persisted, echoed or logged. */
  api_key?: string;
  max_steps?: number;
  max_output_tokens?: number | null;
  context_window?: number;
  system_prompt?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface TurnRequest {
  input: string;
  /** Active session id, or null when nothing is activated. */
  session: string | null;
}

export interface TurnStart {
  turn: number;
}

export interface ClearOutcome {
  cleared: boolean;
}

export interface CompactOutcome {
  compacted: boolean;
  /** Present only when `compacted === true`. */
  kept_turns?: number;
  note: string;
  /** Canonical session id the compact ran against. */
  session: string;
  rebound: boolean;
}

export interface WorkerSpawnRequest {
  wid: string;
  brief: string;
  title?: string;
  model?: string;
  report_to?: string;
}

export interface WorkerSpawnOutcome {
  ok: boolean;
  sessionId?: string;
  title?: string;
  wid?: string;
  error?: string;
  /** Tool envelope passthrough (`{ok:false, value:…}`). */
  value?: unknown;
}

export interface WorkerSendRequest {
  target: string;
  content: string;
}

export interface WorkerStatusReport {
  ok: boolean;
  total: number;
  by_status: Record<string, number>;
  by_state?: Record<string, number>;
  workers: unknown[];
  wid?: string;
  error?: string;
}

/** Engine-memory worker session row (`kind: "worker"`, workspace "engine"). */
export interface WorkerSessionRow {
  id: string;
  workspace: string;
  kind: "worker";
  title: string;
  model: string | null;
  size: number;
  modified: number;
  active: boolean;
}

export interface RuntimeAdapter {
  /** Diagnostic name, surfaced by tests and logs (never by the HTTP API). */
  readonly name: string;
  /** Hand the adapter the bus it emits engine frames into. */
  attach(bus: StudioBus): void;
  /**
   * Optional host hook: hand the engine the system prompt the HOST assembled
   * (prompt registry + settings override). The real adapter applies it to the
   * next composed generation; an adapter without a prompt registry ignores it.
   */
  primeSystemPrompt?(prompt: string): void;
  /** Single-concurrency slot: true while a turn is running. */
  isBusy(): boolean;
  /** Grab the slot, emit `status:start`, return; the rest goes over SSE. */
  startTurn(req: TurnRequest): Promise<TurnStart>;
  /** Cooperative cancel: true = signal sent, false = idle. */
  cancel(): boolean;
  /** Truncate the active session log + reset the turn counter. */
  clear(session: string | null): Promise<ClearOutcome>;
  compact(session: string): Promise<CompactOutcome>;
  profile(): EngineProfile;
  /** Apply an accepted patch (hot compose); throws EngineError on failure. */
  configure(patch: ProfilePatch): Promise<EngineProfile>;
  statusline(): Statusline;
  tools(): ToolInfo[];
  workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome>;
  workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>>;
  workerStatus(wid?: string): WorkerStatusReport;
  workerSessions(): WorkerSessionRow[];
  /** Transcript of an engine-memory worker session, or null when unknown. */
  workerMessages(sessionId: string): unknown[] | null;
}
