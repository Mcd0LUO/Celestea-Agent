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
 *   GET  /api/sessions/{id}/context    -> sessionContext(session)  (W725)
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
/**
 * W737: the busy-slot error is part of the ENGINE contract, so it has exactly
 * one definition — `packages/runtime/src/errors.ts`. It is imported (never
 * redefined) here and re-exported, so every studio-side import of
 * `TurnBusyError` resolves to the very class object the real engine throws.
 */
import { TurnBusyError } from "@celestea/runtime";
import type { StudioBus } from "./sse.js";

/** Verbatim engine error text (Rust `{e}` placeholders). */
export class EngineError extends Error {
  readonly kind = "engine";
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

/**
 * Thrown by `startTurn` when the single-concurrency slot is occupied, and by
 * `clear` while the target session's turn is in flight (409).
 *
 * W737: SINGLE SOURCE — `@celestea/runtime`'s `errors.ts` (`StudioError`
 * subclass: `status: 409`, `kind: "turn_busy"`). This file used to declare a
 * second, `extends Error` copy; the handlers branched on that copy, so the real
 * engine's error failed `instanceof` and the busy race surfaced as a 500
 * instead of a 409 / an interjection. Only the fake adapter threw the copy,
 * which is what kept the contract tests green. Do not redeclare it here.
 */
export { TurnBusyError };

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

/** One model-visible message, flattened for the context viewer (W725). */
export interface ContextMessageView {
  role: string;
  content: string;
  /** Name of the tool this message calls (assistant) or answers (tool). */
  tool_name?: string;
  /** Provider call id, set on a `tool` result (and on the call it answers). */
  tool_call_id?: string;
}

/** `registry.schemas()` row -> the two-field view the host exposes (W729). */
export function toolSpecView(spec: { name: string; description: string }): ToolInfo {
  return { name: spec.name, description: spec.description };
}

/** One tool schema the model is offered (W725) — `registry.schemas()` verbatim. */
export interface ContextToolView {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * W725: one session's model-visible context, as the ENGINE assembles it —
 * system prompt, the messages the next step would send (already trimmed by the
 * loop) and the tool schemas. Read-only: taking a snapshot never drives a turn.
 */
export interface SessionContextView {
  model: string;
  system: string;
  tools: ContextToolView[];
  messages: ContextMessageView[];
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
  /**
   * W740: how many live instances are sweeping their worker rows (the count of
   * RUNNING watchdog timers). Absent from an engine that mounts no watchdog.
   */
  watchdogs?: number;
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
  /** W729: the mode the worker inherited (or was spawned with). */
  mode: string;
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
  /**
   * W516: this session's security boundary changed (its `grants.json` was
   * written) — drop its instance so the next turn recomposes. The turn in
   * flight keeps the boundary it started with; returns false when the session
   * has no live instance (nothing to invalidate).
   */
  invalidateSession?(session: string | null): boolean;
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
  /**
   * W729 (S2): the tool face of ONE session, used to render the `{{tools}}`
   * variable of that session's own system prompt. Optional: an adapter without
   * per-session generations falls back to [tools]. The real adapter answers from
   * the session's LIVE instance and never composes one (the composer calls this
   * while composing that very session — peeking keeps that non-recursive).
   */
  sessionTools?(session: string | null): ToolInfo[];
  /**
   * W725: the session's OWN model-visible context (`GET /api/sessions/{id}/
   * context`). The instance is composed on demand, exactly like activate does;
   * an unknown session is the handler's 404, never this seam's guess.
   */
  sessionContext(session: string | null): SessionContextView;
  workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome>;
  workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>>;
  workerStatus(wid?: string): WorkerStatusReport;
  workerSessions(): WorkerSessionRow[];
  /** Transcript of an engine-memory worker session, or null when unknown. */
  workerMessages(sessionId: string): unknown[] | null;
}
