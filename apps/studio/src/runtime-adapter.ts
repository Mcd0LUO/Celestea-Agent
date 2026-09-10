/**
 * `RuntimeAdapter` — the ONE seam between the Studio host and the engine.
 *
 * P4 ships the Hono layer plus the data stores; the real runtime
 * (`packages/runtime` compose + agent-loop + llm + tools) lands on a separate
 * workstream. Everything the engine owns is therefore expressed here as an
 * injected interface, and P4 verifies the contract against a fake adapter:
 *
 *   POST /api/turn                     -> startTurn() / inject()  (W513: a busy
 *                                         session takes an interjection instead
 *                                         of a 409; the turn is never restarted)
 *   GET  /api/events                   -> attach(bus)   (the adapter emits,
 *                                         one envelope per session)
 *   POST /api/cancel                   -> cancel(session)
 *   POST /api/clear                    -> clear(session)
 *   POST /api/sessions/{id}/activate   -> ensureSession(id)  (W513: never 409)
 *   POST /api/sessions/{id}/compact    -> compact(session)
 *   GET  /api/status                   -> statusline(session?) + isBusy(session?)
 *   GET  /api/tools                    -> tools()
 *   GET+POST /api/config               -> profile() / configure(patch)
 *   POST /api/worker/{spawn,send}      -> workerSpawn() / workerSend()
 *   GET  /api/worker/status            -> workerStatus(wid?)
 *   GET  /api/sessions (worker rows)   -> workerSessions()
 *   GET  /api/sessions/worker:<sid>/…  -> workerMessages(sid)
 *
 * W513 (session independence): busy, turn numbering, status/usage trackers and
 * the session inbox are PER SESSION. `isBusy()` with no argument keeps the
 * legacy "is anything running" reading for the handlers that guard process-wide
 * operations; every session-scoped handler passes the target session id.
 *
 * Replacing the fake with the real runtime is a one-line change in
 * `createStudioApp({ runtime })` — no handler changes, no route changes.
 */

import type { InjectionPlacement, Statusline } from "@celestea/core";
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

/** Thrown when the live-session / concurrent-turn cap is reached (503). */
export class CapacityError extends Error {
  readonly kind = "capacity";
  /** Seconds the client should wait before retrying (Retry-After). */
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds = 1) {
    super(message);
    this.name = "CapacityError";
    this.retryAfterSeconds = retryAfterSeconds;
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
  /** W515 §2: the placement of this turn's own input (`context` = it IS the turn). */
  placement?: InjectionPlacement;
}

/**
 * Result of delivering a message into a session (W513 interjection).
 *
 * W515 §2: `placement` is the client-visible landing state —
 * `steering` = will be injected into the RUNNING turn at its next step
 * boundary, `queued` = accepted and waiting for the next turn start,
 * `context` = already appended to the model-visible log.
 */
export interface InjectOutcome {
  /** Session-local turn number the message was (or will be) injected into. */
  turn: number;
  /** True = delivered into a RUNNING turn; false = queued for the next one. */
  injected: boolean;
  /** Messages still waiting on the target lane after this delivery. */
  pending: number;
  placement: InjectionPlacement;
  /** True when the idempotency key was already accepted (nothing was queued). */
  duplicate: boolean;
}

/** `POST /api/sessions/{id}/activate` — "open the view + ensure the runtime". */
export interface SessionRuntimeInfo {
  /** `created` = this call composed the instance, `reused` = it already existed. */
  runtime: "created" | "reused";
  /** Whether the session has an in-flight turn right now. */
  busy: boolean;
  /** True when the instance was recomposed (profile epoch had moved on). */
  rebuilt: boolean;
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
  /** Host session whose registry spawns the worker (default: active session). */
  session?: string | null;
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
  /** Worker id (`W513`) — the same `wid` the registry row carries. */
  wid?: string;
  /** Registry status: `RUNNING` / `DONE` / `FAILED`. */
  status?: string;
  /** Driver state: `idle` / `in-turn`. */
  state?: string;
  /** Host session that owns this worker's registry. */
  host_session?: string | null;
  /** Whether the OWNING host session has an in-flight turn. */
  busy?: boolean;
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
  /**
   * Busy probe. No argument = "is ANY session running" (legacy reading, used by
   * the process-wide guards); with a session id = that session's own slot.
   */
  isBusy(session?: string | null): boolean;
  /** Grab the session's slot, emit `status:start`, return; rest goes over SSE. */
  startTurn(req: TurnRequest): Promise<TurnStart>;
  /**
   * Deliver `input` into the session's RUNNING turn: it is appended as a
   * `user_message` at the next step boundary (no new turn, no interruption).
   */
  inject(req: TurnRequest): InjectOutcome;
  /** Ensure the session has a runtime instance (activate; never fails on busy). */
  ensureSession(session: string | null): SessionRuntimeInfo;
  /** Session ids with a live runtime instance. */
  liveSessions(): string[];
  /** Session ids with an in-flight turn. */
  busySessions(): string[];
  /** Cooperative cancel of the target session's turn: true = signal sent. */
  cancel(session?: string | null): boolean;
  /** Truncate the active session log + reset the turn counter. */
  clear(session: string | null): Promise<ClearOutcome>;
  compact(session: string): Promise<CompactOutcome>;
  profile(): EngineProfile;
  /** Apply an accepted patch (hot compose); throws EngineError on failure. */
  configure(patch: ProfilePatch): Promise<EngineProfile>;
  statusline(session?: string | null): Statusline;
  tools(): ToolInfo[];
  workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome>;
  workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>>;
  workerStatus(wid?: string): WorkerStatusReport;
  workerSessions(): WorkerSessionRow[];
  /** Transcript of an engine-memory worker session, or null when unknown. */
  workerMessages(sessionId: string): unknown[] | null;
}
