/**
 * The REAL `RuntimeAdapter` — `packages/runtime` mounted behind the engine seam.
 *
 * W513 shape: this class is a HOST over a [SessionRuntimeRegistry], not a single
 * engine. Every session gets its own composition (own agent loop, own tool
 * registry, own status/usage trackers, own worker registry, own session log,
 * own inbox) created lazily on first use, reused while the profile epoch is
 * current, and reclaimed when idle. There is no "global main session":
 * `workspaces.json.active_session` is only the view the UI should restore.
 *
 * Mapping (host HTTP surface -> composition / engine):
 *   POST /api/turn                  -> `startTurn` (idle) or `inject` (busy);
 *   GET  /api/events                -> `attach(bus)`, frames carry the session;
 *   POST /api/sessions/{id}/activate-> `ensureSession` (never 409);
 *   POST /api/cancel                -> the target session's AbortController;
 *   POST /api/clear                 -> the target session log's `clear()`;
 *   POST /api/sessions/{id}/compact -> `runCompaction` + that instance rebuilt;
 *   GET  /api/status                -> the requested session's statusline;
 *   GET  /api/tools                 -> the composed `ToolRegistry.schemas()`;
 *   GET+POST /api/config            -> bump the profile epoch (lazy rebuild);
 *   worker endpoints                -> per-session registries, merged for reads.
 *
 * The per-session turn/state machinery lives in the registry and the composition
 * in `session-compose.ts`; this file is the seam implementation the handlers see.
 *
 * LLM: an injected seam wins (tests / replay inject the OFFLINE deterministic
 * engine, so no test, no contract check and no replay reaches the network); with
 * nothing injected each instance is assembled against the profile's provider
 * (`llm-assembly.ts`), i.e. production is a real model.
 */

import type { Statusline, TurnOutcome } from "@celestea/core";
import {
  createStatusTracker,
  createUsageTracker,
  keyOfSession,
  outcomePhaseOf,
  runCompaction,
  SessionRuntimeRegistry,
  statuslineOf,
  TurnBusyError,
  type Profile,
  type SessionRuntime,
} from "@celestea/runtime";
import { join } from "node:path";
import { EngineError } from "../runtime-adapter.js";
import type {
  ClearOutcome,
  CompactOutcome,
  EngineProfile,
  InjectOutcome,
  ProfilePatch,
  RuntimeAdapter,
  SessionRuntimeInfo,
  ToolInfo,
  TurnRequest,
  TurnStart,
  WorkerSendRequest,
  WorkerSessionRow,
  WorkerSpawnOutcome,
  WorkerSpawnRequest,
  WorkerStatusReport,
} from "../runtime-adapter.js";
import type { StudioBus } from "../sse.js";
import { applyProfilePatch, defaultEngineProfile, engineProfileOf, profileFromEngine } from "./engine-profile.js";
import { SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
import {
  capacityErrorOf,
  disposeRuntime,
  limitFromEnv,
  MAX_CONCURRENT_TURNS,
  MAX_LIVE_SESSIONS,
  SESSION_IDLE_TTL_MS,
  SessionComposer,
  type SessionComposerOptions,
} from "./session-compose.js";
import {
  aggregateWorkerStatus,
  dispatchWorkerTool,
  sendBodyOf,
  spawnOutcomeOf,
  workerMessagesOf,
  workerSessionsOf,
} from "./worker-bridge.js";

export { SESSION_LOG_ID, SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
export { MAX_CONCURRENT_TURNS, MAX_LIVE_SESSIONS, SESSION_IDLE_TTL_MS } from "./session-compose.js";

/** Everything the composer needs, plus the resource caps. */
export interface RealRuntimeAdapterOptions extends Omit<SessionComposerOptions, "env" | "baseProfile"> {
  /** Startup engine profile (see [defaultEngineProfile]). */
  profile?: EngineProfile;
  /** Process environment (provider keys, tool roots, resource caps). */
  env?: NodeJS.ProcessEnv;
  /** Live-instance cap (default [MAX_LIVE_SESSIONS] / `CELESTEA_MAX_LIVE_SESSIONS`). */
  maxLiveSessions?: number;
  /** Concurrent-turn cap (default [MAX_CONCURRENT_TURNS]). */
  maxConcurrentTurns?: number;
  /** Idle TTL for the reclaimer (default [SESSION_IDLE_TTL_MS]). */
  idleTtlMs?: number;
}

/** `RuntimeAdapter` + the lifecycle handles the host needs beyond the seam. */
export interface RealRuntimeAdapter extends RuntimeAdapter {
  /** Epoch of the current profile generation (bumped by every configure). */
  generationEpoch(): number;
  /** Absolute path of the default (detached) session log (null = in memory). */
  sessionLogPath(): string | null;
  /** Set the engine system prompt used by the next composed generation. */
  primeSystemPrompt(prompt: string): void;
  /** The last terminal turn state over every session (diagnostics / tests). */
  lastTurnOutcome(): TurnOutcome | null;
  /** Tear every live instance down (idempotent). */
  shutdown(): Promise<void>;
}

class RealEngine implements RealRuntimeAdapter {
  readonly name = "real-runtime-adapter";
  private readonly opts: RealRuntimeAdapterOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly composer: SessionComposer;
  private readonly registry: SessionRuntimeRegistry;
  private profileValue: Profile;
  private bus: StudioBus | null = null;
  private baseEpoch = 0;
  private toolCalls = 0;
  private shutdownPromise: Promise<void> | null = null;

  constructor(opts: RealRuntimeAdapterOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.profileValue = profileFromEngine(opts.profile ?? defaultEngineProfile(this.env, "CELESTEA_API_KEY"));
    this.composer = new SessionComposer({ ...opts, env: this.env, baseProfile: () => this.profileValue });
    this.registry = new SessionRuntimeRegistry({
      build: (sessionId, dir) => this.composer.compose(sessionId, dir),
      dispose: (runtime) => disposeRuntime(runtime),
      currentEpoch: () => this.baseEpoch,
      maxLive: opts.maxLiveSessions ?? limitFromEnv(this.env, "CELESTEA_MAX_LIVE_SESSIONS", MAX_LIVE_SESSIONS),
      maxConcurrentTurns: opts.maxConcurrentTurns ?? limitFromEnv(this.env, "CELESTEA_MAX_CONCURRENT_TURNS", MAX_CONCURRENT_TURNS),
      idleTtlMs: opts.idleTtlMs ?? limitFromEnv(this.env, "CELESTEA_SESSION_IDLE_TTL_MS", SESSION_IDLE_TTL_MS),
      pinned: (entry) => this.isPinned(entry),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    this.registry.ensure(null, null);
  }

  // --- host lifecycle ----------------------------------------------------

  attach(bus: StudioBus): void {
    this.bus = bus;
  }

  generationEpoch(): number {
    return this.baseEpoch;
  }

  sessionLogPath(): string | null {
    const path = (this.registry.peek(null)?.runtime.session as { path?: unknown } | undefined)?.path;
    return typeof path === "string" ? path : null;
  }

  primeSystemPrompt(prompt: string): void {
    if (prompt === "" || prompt === this.profileValue.system_prompt) return;
    this.profileValue = { ...this.profileValue, system_prompt: prompt };
    this.bumpEpoch();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise === null) this.shutdownPromise = this.registry.shutdown();
    await this.shutdownPromise;
  }

  /** The composed tool registry of the default instance (`GET /api/tools`). */
  tools(): ToolInfo[] {
    return (this.registry.peek(null)?.runtime.tools?.schemas() ?? []).map((spec) => ({ name: spec.name, description: spec.description }));
  }

  // --- sessions ----------------------------------------------------------

  /** The session's instance (creating it, and making room, when needed). */
  private entryFor(session: string | null): SessionRuntime {
    try {
      return this.registry.ensure(session, session === null ? null : (this.opts.resolveSession?.(session)?.dir ?? null));
    } catch (e) {
      throw capacityErrorOf(e);
    }
  }

  ensureSession(session: string | null): SessionRuntimeInfo {
    const before = this.registry.peek(session);
    const entry = this.entryFor(session);
    return {
      runtime: before === null ? "created" : "reused",
      busy: entry.inFlight,
      rebuilt: before !== null && before.runtime !== entry.runtime,
    };
  }

  liveSessions(): string[] {
    return this.registry.liveSessionIds();
  }

  busySessions(): string[] {
    return this.registry.busySessionIds();
  }

  // --- turns -------------------------------------------------------------

  isBusy(session?: string | null): boolean {
    if (session === undefined) return this.registry.inFlightCount() > 0;
    return this.registry.peek(session)?.inFlight ?? false;
  }

  async startTurn(req: TurnRequest): Promise<TurnStart> {
    const entry = this.entryFor(req.session);
    if (entry.inFlight) throw new TurnBusyError("turn");
    const controller = new AbortController();
    const turn = this.beginTurn(entry, controller);
    this.emitStatus(entry, turn, "start");
    void this.drive(entry, req.input, turn, controller);
    return { turn };
  }

  /** W513: deliver into the RUNNING turn instead of refusing with a 409. */
  inject(req: TurnRequest): InjectOutcome {
    const entry = this.registry.peek(req.session);
    if (entry === null || !entry.inFlight) return { turn: entry?.turnNo ?? 0, injected: false, pending: 0 };
    entry.runtime.inject(req.input, "");
    entry.lastActiveAt = this.now();
    return { turn: entry.turnNo, injected: true, pending: entry.runtime.pendingInjections() };
  }

  private beginTurn(entry: SessionRuntime, controller: AbortController): number {
    try {
      return this.registry.beginTurn(entry, controller);
    } catch (e) {
      throw capacityErrorOf(e);
    }
  }

  /** Drive one turn to its terminal state, then publish the closing status. */
  private async drive(entry: SessionRuntime, input: string, turn: number, controller: AbortController): Promise<void> {
    try {
      const outcome = await entry.runtime.runTurn(input, {
        signal: controller.signal,
        sink: (frame) => this.bus?.emit(frame.event, turn, frame.payload, entry.sessionId),
      });
      this.registry.endTurn(entry, outcome);
      this.emitStatus(entry, turn, outcomePhaseOf(outcome));
    } catch (e) {
      this.registry.endTurn(entry, null);
      this.emitStatus(entry, turn, "error", e instanceof Error ? e.message : String(e));
    }
  }

  cancel(session?: string | null): boolean {
    const entry = session === undefined ? this.newestBusy() : this.registry.peek(session);
    if (entry === null || entry === undefined || !entry.inFlight || entry.controller === null) return false;
    entry.controller.abort();
    return true;
  }

  private newestBusy(): SessionRuntime | null {
    for (const entry of this.registry.list()) if (entry.inFlight) return entry;
    return null;
  }

  lastTurnOutcome(): TurnOutcome | null {
    let best: SessionRuntime | null = null;
    for (const entry of this.registry.list()) {
      if (entry.lastOutcome === null) continue;
      if (best === null || entry.lastActiveAt >= best.lastActiveAt) best = entry;
    }
    return best?.lastOutcome ?? null;
  }

  private emitStatus(entry: SessionRuntime, turn: number, phase: string, error: string | null = null): void {
    const payload: Record<string, unknown> = { phase, statusline: entry.runtime.statusline() };
    if (error !== null) payload["error"] = error;
    this.bus?.emit("status", turn, payload, entry.sessionId);
  }

  // --- host views --------------------------------------------------------

  profile(): EngineProfile {
    return engineProfileOf(this.profileValue);
  }

  /** The requested session's statusline (no instance yet = an empty one). */
  statusline(session?: string | null): Statusline {
    const entry = this.registry.peek(session ?? null);
    if (entry !== null) return entry.runtime.statusline();
    return statuslineOf({
      model: this.profileValue.model,
      reasoning_effort: this.profileValue.reasoning_effort,
      status: createStatusTracker(this.now),
      usage: createUsageTracker(),
      context_window: this.profileValue.context_window_tokens,
      events: () => [],
    });
  }

  async configure(patch: ProfilePatch): Promise<EngineProfile> {
    if (patch.api_key !== undefined && patch.api_key !== "") this.env[this.profileValue.api_key_env] = patch.api_key;
    this.profileValue = applyProfilePatch(this.profileValue, patch);
    this.bumpEpoch();
    return this.profile();
  }

  /** Config change: instances are rebuilt lazily, at their next turn boundary. */
  private bumpEpoch(): void {
    this.baseEpoch += 1;
    this.registry.invalidateAll();
  }

  async clear(session: string | null): Promise<ClearOutcome> {
    const entry = this.registry.peek(session);
    if (entry !== null) {
      if (entry.inFlight) throw new TurnBusyError("clear");
      entry.runtime.session.clear();
      entry.turnNo = 0;
    }
    return { cleared: true };
  }

  async compact(session: string): Promise<CompactOutcome> {
    const target = this.opts.resolveSession?.(session) ?? null;
    if (target === null || target.dir === null) {
      return { compacted: false, note: SKIPPED_NOTE, session, rebound: false };
    }
    const live = this.registry.peek(session) !== null;
    if (live) await this.registry.evict(keyOfSession(session));
    const result = await this.runCompact(join(target.dir, SESSION_LOG_NAME));
    if (live) this.registry.ensure(session, target.dir);
    return {
      compacted: result.compacted,
      ...(result.compacted && result.kept_turns !== null ? { kept_turns: result.kept_turns } : {}),
      note: result.note,
      session,
      rebound: live && result.compacted,
    };
  }

  private async runCompact(logPath: string): Promise<{ compacted: boolean; kept_turns: number | null; note: string }> {
    try {
      return await runCompaction({ logPath, summarize: this.composer.summarizer() });
    } catch (e) {
      throw new EngineError(e instanceof Error ? e.message : String(e));
    }
  }

  // --- workers -----------------------------------------------------------

  /** Merged worker rows over every live instance (W513 aggregate view). */
  workerSessions(): WorkerSessionRow[] {
    const rows: WorkerSessionRow[] = [];
    for (const entry of this.registry.list()) {
      for (const row of workerSessionsOf(entry.runtime.workers, entry.runtime.hostSessionId)) {
        rows.push({ ...row, host_session: entry.sessionId, busy: entry.inFlight });
      }
    }
    return rows;
  }

  workerMessages(sessionId: string): unknown[] | null {
    for (const entry of this.registry.list()) {
      const found = workerMessagesOf(entry.runtime.workers, sessionId);
      if (found !== null) return found;
    }
    return null;
  }

  async workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome> {
    const entry = this.entryFor(req.session ?? null);
    const args: Record<string, unknown> = { wid: req.wid, brief: req.brief };
    for (const key of ["title", "model"] as const) {
      const value = req[key];
      if (value !== undefined) args[key] = value;
    }
    // W513: an unaddressed worker reports back to the session that spawned it.
    args["report_to"] = req.report_to ?? entry.runtime.hostSessionId ?? "";
    this.toolCalls += 1;
    return spawnOutcomeOf(await dispatchWorkerTool(entry.runtime.tools, "spawn_worker", args, `host-spawn-${this.toolCalls}`));
  }

  /** The worker's registry is per session: route the send to its owner. */
  async workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>> {
    let last: Record<string, unknown> | null = null;
    for (const entry of this.registry.list()) {
      this.toolCalls += 1;
      const body = sendBodyOf(
        await dispatchWorkerTool(entry.runtime.tools, "session_send_message", { target: req.target, content: req.content }, `host-send-${this.toolCalls}`),
      );
      if (body["ok"] === true) return body;
      last = body;
    }
    return last ?? { ok: false, delivered: false, error: "worker registry is not wired" };
  }

  workerStatus(wid?: string): WorkerStatusReport {
    return aggregateWorkerStatus(this.workerSessions(), wid);
  }

  // --- internals ---------------------------------------------------------

  /** The default (detached) instance is never reclaimed: it backs `/api/tools`. */
  private isPinned(entry: SessionRuntime): boolean {
    if (entry.key === keyOfSession(null)) return true;
    const workers = entry.runtime.workers;
    return workers !== null && (workers.ownEntries().length > 0 || workers.backgroundLen() > 0);
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }
}

/** The frozen "nothing to compact" note (kept in sync with compact/plan.ts). */
const SKIPPED_NOTE = "历史不足，无需压缩";

/** Build the real adapter (the host's default engine). */
export function createRealRuntimeAdapter(opts: RealRuntimeAdapterOptions = {}): RealRuntimeAdapter {
  return new RealEngine(opts);
}
