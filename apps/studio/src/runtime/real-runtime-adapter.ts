/**
 * The REAL `RuntimeAdapter` — `packages/runtime` mounted behind the P4 engine
 * seam (it replaces the P4 fake at the app edge; the fake stays for tests).
 *
 * Mapping (host HTTP surface -> composition / engine):
 *   POST /api/turn                  -> `runtime.runTurn(input,{signal,sink})`,
 *                                      frames published on the SSE bus;
 *   GET  /api/events                -> `attach(bus)` (the engine emits);
 *   POST /api/cancel                -> the turn's own AbortController;
 *   POST /api/clear                 -> the session log's `clear()`;
 *   POST /api/sessions/{id}/compact -> `runCompaction` + rebind when active;
 *   GET  /api/status                -> `Runtime.statusline()` (steps / usage /
 *                                      cache_hit_ratio / context_usage read the
 *                                      live trackers the loop writes to);
 *   GET  /api/tools                 -> the composed `ToolRegistry.schemas()`;
 *   GET+POST /api/config            -> `GenerationHub.buildAndSwap` (hot swap);
 *   worker endpoints                -> the worker registry + the three tools.
 *
 * Session binding: the host owns `<workspace>/<session>` -> directory
 * (`resolveSession`), the adapter opens `<dir>/cli-main.jsonl` through
 * `PersistentSessionLog` and REBINDS when the active session changes (the engine
 * refuses a mid-turn rebind, exactly like Rust's compose-swap rule). With no
 * active session the generation runs on an in-memory log, so `/api/turn` still
 * works and the adapter never invents a session directory.
 *
 * LLM: an injected seam wins (tests / replay inject the OFFLINE deterministic
 * engine, so no test, no contract check and no replay reaches the network); with
 * nothing injected the generation is assembled against the profile's provider
 * (`llm-assembly.ts`), i.e. production is a real model, and only
 * `CELESTEA_LLM_MODE=offline` swaps the network seam back out. Usage accounting
 * is ONE tracker shared by the loop and the runtime, so the statusline observes
 * exactly what the model reported.
 */

import { createUsageTracker, DefaultAgentLoop } from "@celestea/agent-loop";
import type { Llm, Sandbox, SessionLog, Statusline, Tool, ToolGuard, ToolRegistry, TurnOutcome } from "@celestea/core";
import { InMemorySessionLog } from "@celestea/session";
import {
  compose,
  GenerationHub,
  llmSummarizer,
  outcomePhaseOf,
  runCompaction,
  TurnBusyError,
  type Profile,
  type Runtime,
  type SessionBinding,
  type Summarizer,
  type WorkerWiring,
} from "@celestea/runtime";
import { WorkerRegistry } from "@celestea/workers";
import { join } from "node:path";
import {
  EngineError,
  type ClearOutcome,
  type CompactOutcome,
  type EngineProfile,
  type ProfilePatch,
  type RuntimeAdapter,
  type ToolInfo,
  type TurnRequest,
  type TurnStart,
  type WorkerSendRequest,
  type WorkerSessionRow,
  type WorkerSpawnOutcome,
  type WorkerSpawnRequest,
  type WorkerStatusReport,
} from "../runtime-adapter.js";
import type { StudioBus } from "../sse.js";
import { applyProfilePatch, defaultEngineProfile, engineProfileOf, profileFromEngine } from "./engine-profile.js";
import { bindingFor, closeLog, memoryBindingFor, SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
import { enginePlugins } from "./engine-plugins.js";
import { createEngineLlm } from "./llm-assembly.js";
import { dispatchWorkerTool, sendBodyOf, spawnOutcomeOf, toStatusReport, workerMessagesOf, workerSessionsOf } from "./worker-bridge.js";

export { SESSION_LOG_ID, SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";

export interface RealRuntimeAdapterOptions {
  /** Startup engine profile (see [defaultEngineProfile]). */
  profile?: EngineProfile;
  env?: NodeJS.ProcessEnv;
  /** Host lookup: `<workspace>/<session>` -> directory (null = detached). */
  resolveSession?: (id: string) => SessionTarget | null;
  /** Host view of the ACTIVE session id (decides whether a compact rebinds). */
  activeSession?: () => string | null;
  /** LLM seam factory; default = the offline deterministic engine. */
  llm?: (profile: Profile) => Llm;
  /** Extra tools registered after the six builtins. */
  tools?: readonly Tool[];
  sandbox?: Sandbox;
  /** Guard override: `undefined` = production guard, `null` = no guard. */
  guard?: ToolGuard | null;
  /** Disable worker orchestration wiring entirely. */
  workers?: false;
  /** Worker receipt/report directory (default `<cwd>/worker-results`). */
  resultsDir?: string;
  /** Compact summarizer override (default: the `Llm` seam). */
  summarize?: (profile: Profile) => Summarizer;
  now?: () => number;
}

/** `RuntimeAdapter` + the lifecycle handles the host needs beyond the seam. */
export interface RealRuntimeAdapter extends RuntimeAdapter {
  /** Epoch of the current generation (bumped by every hot swap). */
  generationEpoch(): number;
  /** Absolute path of the active session log (null for an in-memory log). */
  sessionLogPath(): string | null;
  /** Set the engine system prompt used by the next composed generation. */
  primeSystemPrompt(prompt: string): void;
  /** The last terminal turn state (diagnostics / tests). */
  lastTurnOutcome(): TurnOutcome | null;
  /** Tear the current generation down (idempotent). */
  shutdown(): Promise<void>;
}

class RealEngine implements RealRuntimeAdapter {
  readonly name = "real-runtime-adapter";
  private readonly opts: RealRuntimeAdapterOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly memoryLogs = new Map<string, SessionLog>();
  private readonly hub: GenerationHub;
  private profileValue: Profile;
  private bindingValue: SessionBinding;
  private bus: StudioBus | null = null;
  private controller: AbortController | null = null;
  private inFlight = false;
  private turnNo = 0;
  private toolCalls = 0;
  private lastOutcome: TurnOutcome | null = null;
  private needsRebuild = false;

  constructor(opts: RealRuntimeAdapterOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.profileValue = profileFromEngine(opts.profile ?? defaultEngineProfile(this.env, "CELESTEA_API_KEY"));
    this.bindingValue = memoryBindingFor(this.memoryLogs, null);
    this.hub = new GenerationHub({ build: (profile) => this.build(profile) });
    this.hub.install(this.build(this.profileValue), this.profileValue);
  }

  // --- host lifecycle ----------------------------------------------------

  attach(bus: StudioBus): void {
    this.bus = bus;
  }

  generationEpoch(): number {
    return this.hub.epoch;
  }

  sessionLogPath(): string | null {
    const path = (this.hub.peek()?.runtime.session as { path?: unknown } | undefined)?.path;
    return typeof path === "string" ? path : null;
  }

  primeSystemPrompt(prompt: string): void {
    if (prompt === "" || prompt === this.profileValue.system_prompt) return;
    this.profileValue = { ...this.profileValue, system_prompt: prompt };
    this.needsRebuild = true;
  }

  async shutdown(): Promise<void> {
    await this.hub.shutdown();
  }

  // --- composition -------------------------------------------------------

  /**
   * Worker wiring handed to `compose`, which mounts the registry plugin LAST so
   * the three orchestration tools land in the composed tool registry (Rust
   * `build_registry` order). The table stays IN MEMORY (`tsvPath: null`): the
   * host never rewrites the shared `/tmp/registry.tsv` of the running fleet.
   */
  private workerWiring(): WorkerWiring | false {
    if (this.opts.workers === false) return false;
    return {
      tsvPath: null,
      resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"),
      sourceLabel: "celestea.studio-ts",
      logFactory: (): SessionLog => new InMemorySessionLog(),
    };
  }

  /** Compose one generation (the hub's build factory). */
  private build(profile: Profile): Runtime {
    const wiring = this.workerWiring();
    const engine = enginePlugins({
      profile,
      llm: this.llmFactory()(profile),
      workers: null, // the workers plugin registers the three tools, in compose order
      ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
      ...(this.opts.sandbox === undefined ? {} : { sandbox: this.opts.sandbox }),
      ...(this.opts.guard === undefined ? {} : { guard: this.opts.guard }),
      env: this.env,
    });
    const usage = createUsageTracker();
    const runtime = compose({
      profile,
      plugins: engine.plugins,
      sessionBinding: this.bindingValue,
      usage,
      loopFactory: (bindings) =>
        new DefaultAgentLoop(bindings.config, { signal: bindings.signal, sink: bindings.sink, usage }),
      workers: wiring,
      ...(this.opts.now === undefined ? {} : { now: this.opts.now }),
    });
    return runtime;
  }

  /**
   * The seam factory of every generation: the host's injected seam when given
   * (tests / replay), otherwise the assembled engine LLM — LIVE against the
   * profile's provider, or the deterministic offline seam when the deployment
   * selected `CELESTEA_LLM_MODE=offline`.
   */
  private llmFactory(): (profile: Profile) => Llm {
    return this.opts.llm ?? ((profile: Profile): Llm => createEngineLlm(profile, this.env));
  }

  private runtime(): Runtime {
    return this.hub.current().runtime;
  }

  /** Apply a pending prime (the host's assembled system prompt) before a turn. */
  private async settleProfile(): Promise<void> {
    if (!this.needsRebuild) return;
    this.needsRebuild = false;
    await this.swap(this.profileValue);
  }

  /** Hot swap to `next`, closing the previous generation's log descriptor. */
  private async swap(next: Profile): Promise<void> {
    // Read the previous log BEFORE the swap: teardown releases that generation,
    // and a released runtime refuses to hand out its handles.
    const prevLog = this.hub.peek()?.runtime.session ?? null;
    await this.hub.buildAndSwap(next);
    closeLog(prevLog);
  }

  // --- session binding ---------------------------------------------------

  private bindingTo(sessionId: string | null): SessionBinding {
    const target = sessionId === null ? null : (this.opts.resolveSession?.(sessionId) ?? null);
    return bindingFor(sessionId, target, this.memoryLogs);
  }

  /** Point the generation at `sessionId` (rebind only when it actually changed). */
  private bind(sessionId: string | null): void {
    if (this.bindingValue.sessionId === sessionId) return;
    const next = this.bindingTo(sessionId);
    this.runtime().rebind(next);
    this.bindingValue = next;
  }

  // --- turns -------------------------------------------------------------

  isBusy(): boolean {
    return this.inFlight || (this.hub.peek()?.runtime.isBusy ?? false);
  }

  async startTurn(req: TurnRequest): Promise<TurnStart> {
    if (this.isBusy()) throw new TurnBusyError("turn");
    this.inFlight = true;
    try {
      await this.settleProfile();
      this.bind(req.session);
    } catch (e) {
      this.inFlight = false;
      throw e instanceof Error ? e : new EngineError(String(e));
    }
    this.turnNo += 1;
    const turn = this.turnNo;
    const controller = new AbortController();
    this.controller = controller;
    this.emitStatus(turn, "start");
    void this.drive(this.runtime(), req.input, turn, controller);
    return { turn };
  }

  /** Drive one turn to its terminal state, then publish the closing status frame. */
  private async drive(runtime: Runtime, input: string, turn: number, controller: AbortController): Promise<void> {
    try {
      const outcome = await runtime.runTurn(input, {
        signal: controller.signal,
        sink: (frame) => this.bus?.emit(frame.event, turn, frame.payload),
      });
      this.lastOutcome = outcome;
      this.emitStatus(turn, outcomePhaseOf(outcome));
    } catch (e) {
      this.emitStatus(turn, "error", e instanceof Error ? e.message : String(e));
    } finally {
      this.controller = null;
      this.inFlight = false;
    }
  }

  /** Cancel the in-flight turn; false when nothing is running (contract). */
  cancel(): boolean {
    if (!this.inFlight || this.controller === null) return false;
    this.controller.abort();
    return true;
  }

  /** The last terminal turn state (diagnostics / tests). */
  lastTurnOutcome(): TurnOutcome | null {
    return this.lastOutcome;
  }

  private emitStatus(turn: number, phase: string, error: string | null = null): void {
    const payload: Record<string, unknown> = { phase, statusline: this.statusline() };
    if (error !== null) payload["error"] = error;
    this.bus?.emit("status", turn, payload);
  }

  // --- host views --------------------------------------------------------

  profile(): EngineProfile {
    return engineProfileOf(this.profileValue);
  }

  statusline(): Statusline {
    return this.runtime().statusline();
  }

  tools(): ToolInfo[] {
    return (this.hub.peek()?.runtime.tools?.schemas() ?? []).map((spec) => ({ name: spec.name, description: spec.description }));
  }

  async configure(patch: ProfilePatch): Promise<EngineProfile> {
    if (this.isBusy()) throw new TurnBusyError("config");
    if (patch.api_key !== undefined && patch.api_key !== "") this.env[this.profileValue.api_key_env] = patch.api_key;
    const next = applyProfilePatch(this.profileValue, patch);
    this.needsRebuild = false;
    await this.swap(next);
    this.profileValue = next;
    return this.profile();
  }

  async clear(session: string | null): Promise<ClearOutcome> {
    if (this.isBusy()) throw new TurnBusyError("clear");
    if (session === null || this.bindingValue.sessionId === session) this.runtime().session.clear();
    this.turnNo = 0;
    return { cleared: true };
  }

  async compact(session: string): Promise<CompactOutcome> {
    if (this.isBusy()) throw new TurnBusyError("compact");
    const target = this.opts.resolveSession?.(session) ?? null;
    if (target === null || target.dir === null) {
      return { compacted: false, note: SKIPPED_NOTE, session, rebound: false };
    }
    const result = await this.runCompact(join(target.dir, SESSION_LOG_NAME));
    return {
      compacted: result.compacted,
      ...(result.compacted && result.kept_turns !== null ? { kept_turns: result.kept_turns } : {}),
      note: result.note,
      session,
      rebound: this.rebindAfterCompact(session, result.compacted),
    };
  }

  private async runCompact(logPath: string): Promise<{ compacted: boolean; kept_turns: number | null; note: string }> {
    try {
      return await runCompaction({ logPath, summarize: this.summarizer() });
    } catch (e) {
      throw new EngineError(e instanceof Error ? e.message : String(e));
    }
  }

  private summarizer(): Summarizer {
    const factory = this.opts.summarize;
    if (factory !== undefined) return factory(this.profileValue);
    return llmSummarizer({ llm: this.llmFactory()(this.profileValue), model: this.profileValue.model });
  }

  /**
   * Re-open the rewritten log so the live generation sees the compacted history.
   * Rust binds a NEW generation only when the compacted session is the ACTIVE
   * one; every other session is replayed on its next activation.
   */
  private rebindAfterCompact(session: string, compacted: boolean): boolean {
    if (!compacted) return false;
    const active = this.opts.activeSession?.() ?? this.bindingValue.sessionId;
    if (active !== session) return false;
    const next = this.bindingTo(session);
    closeLog(this.runtime().session);
    this.runtime().rebind(next);
    this.bindingValue = next;
    return true;
  }

  // --- workers -----------------------------------------------------------

  workerSessions(): WorkerSessionRow[] {
    return workerSessionsOf(this.workers(), this.hub.peek()?.runtime.hostSessionId ?? null);
  }

  workerMessages(sessionId: string): unknown[] | null {
    return workerMessagesOf(this.workers(), sessionId);
  }

  async workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome> {
    const args: Record<string, unknown> = { wid: req.wid, brief: req.brief };
    for (const key of ["title", "model", "report_to"] as const) {
      const value = req[key];
      if (value !== undefined) args[key] = value;
    }
    this.toolCalls += 1;
    return spawnOutcomeOf(await dispatchWorkerTool(this.toolRegistry(), "spawn_worker", args, `host-spawn-${this.toolCalls}`));
  }

  async workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>> {
    this.toolCalls += 1;
    return sendBodyOf(
      await dispatchWorkerTool(this.toolRegistry(), "session_send_message", { target: req.target, content: req.content }, `host-send-${this.toolCalls}`),
    );
  }

  workerStatus(wid?: string): WorkerStatusReport {
    return toStatusReport(this.workers()?.status(wid) ?? null, wid);
  }

  /** The CURRENT generation's worker registry (compose owns it). */
  private workers(): WorkerRegistry | null {
    return this.hub.peek()?.runtime.workers ?? null;
  }

  private toolRegistry(): ToolRegistry | null {
    return this.hub.peek()?.runtime.tools ?? null;
  }
}

/** The frozen "nothing to compact" note (kept in sync with compact/plan.ts). */
const SKIPPED_NOTE = "历史不足，无需压缩";

/** Build the real adapter (the host's default engine). */
export function createRealRuntimeAdapter(opts: RealRuntimeAdapterOptions = {}): RealRuntimeAdapter {
  return new RealEngine(opts);
}
