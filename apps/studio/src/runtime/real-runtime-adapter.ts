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
 * W742 lifecycle (both were documented before but not wired):
 *   - an epoch bump (POST /api/config, POST /api/providers/default, a grant
 *     write) NEVER tears down an instance that is still driving workers: the
 *     registry only marks it and rebuilds it once those workers ended, so a
 *     model switch can no longer abort a background worker and erase its rows
 *     (the HTTP 409 guards of both endpoints close the same hole up front);
 *   - `CELESTEA_SESSION_IDLE_TTL_MS` is real: the registry's unref'ed reclaimer
 *     sweeps deferrable rebuilds + the idle TTL in the background, and
 *     `shutdown()` disarms it (no timer outlives the engine).
 *
 * Mapping (host HTTP surface -> composition / engine):
 *   POST /api/turn                  -> `startTurn` (idle) or `inject` (busy);
 *   GET  /api/events                -> `attach(bus)`, frames carry the session;
 *   POST /api/sessions/{id}/activate-> `ensureSession` (never 409);
 *   POST /api/cancel                -> the target session's AbortController;
 *   POST /api/sessions/batch-delete -> `releaseSession` (W794: abort + drop the
 *                                      instance before the directory moves);
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

import { outcomeErrorParts } from "@celestea/core";
import type { AskUserQuestionAnswerItem, ImageRef, InjectionPlacement, InjectionLane, PendingInjection, SseEventName, Statusline, TurnOutcome } from "@celestea/core";
import type { Watchdog, WorkerRecoveryReport, WorkerRegistry } from "@celestea/workers";
import { createSessionInbox, type InjectedMessage, type SessionInbox } from "@celestea/runtime";
import {
  autowakeEnabled,
  coldStatusline,
  keyOfSession,
  outcomePhaseOf,
  HOST_SESSION_ID,
  PROFILE_KEYS,
  SessionRuntimeRegistry,
  statuslineOf,
  TurnBusyError,
  type LedgerCostBlock,
  type LedgerQuery,
  type LedgerQueryResult,
  type Profile,
  type SessionRuntime,
} from "@celestea/runtime";
import { costBlockView, usageLedgerView } from "./ledger-view.js";
import { join } from "node:path";
import { CapacityError, EngineError, toolSpecView, type PendingQuestionView, type QuestionAnswerOutcome } from "../runtime-adapter.js";
import { HostAutowake, autowakeLog, autowakeStateOf } from "./host-autowake.js";
import { injectionHooksOf, publishSubCall, type SessionInjectionHooks } from "./session-publisher.js";
import { sessionContextOf } from "./context-snapshot.js";
import { inheritedPanelRows, mergedWorkerRows, sendWorkerThrough, spawnWorkerThrough, workerMessagesAcross } from "./worker-bridge.js";
import { RETRY_ONLY_TARGET } from "./fallback-host.js";
import { createEngineLlm } from "./llm-assembly.js";
import type { Llm } from "@celestea/core";
import type {
  ClearOutcome,
  CompactOutcome,
  EngineProfile,
  InjectOutcome,
  ProfilePatch,
  RuntimeAdapter,
  SessionContextView,
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
import { QuestionHost } from "./question-host.js";
import { AdapterFallback, type FallbackStatusView } from "./fallback-host.js";
import { createImageDowngradeReporter } from "./image-downgrade.js";
import type { StudioBus } from "../sse.js";
import { contextViewOf } from "./context-snapshot.js";
import { applyProfilePatch, clampRetries, defaultEngineProfile, engineProfileOf, profileFromEngine, retriesOf } from "./engine-profile.js";
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
  dispatchWorkerTool,
  sendBodyOf,
  spawnOutcomeOf,
  workerMessagesOf,
  workerSessionsOf,
} from "./worker-bridge.js";
import { inboxMessageOf } from "./inbox-message.js";
import { watchdogCount, watchdogOf, watchdogRunningOf, workerStatusOf } from "./watchdog-view.js";
import { hasLiveWorkersOf } from "./worker-live.js";
import { recoveryViewOf, type RecoveryView } from "./recovery-view.js";
import { workerTablePath, workerTableStateOf, type WorkerTableState } from "./worker-table.js";
import { clearSession, compactSession, type SessionLifecycleDeps } from "./session-lifecycle.js";
import { releaseSessionOf, releaseSettleMs } from "./session-release.js";
import { faceForMode } from "@celestea/tools";
import { DEFAULT_SESSION_MODE, effectiveMode } from "../store/mode.js";

export { SESSION_LOG_ID, SESSION_LOG_NAME, type SessionTarget } from "./engine-session.js";
export { MAX_CONCURRENT_TURNS, MAX_LIVE_SESSIONS, SESSION_IDLE_TTL_MS } from "./session-compose.js";
export { RELEASE_SETTLE_MS } from "./session-release.js";

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
  /**
   * `<data dir>` — where `fallbacks.json` / `fallbacks-audit.jsonl` live, and the
   * default home of the worker table (`<data dir>/worker-registry.tsv`, §2.2.1).
   * Defaults to the ledger's directory (all three are process-level data files).
   */
  dataDir?: string;
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
  /**
   * W740: the liveness watchdog of the session's instance (null when the
   * watchdog is off). The timer is scheduled by the composition root; this
   * handle is how the host inspects or hand-ticks it.
   */
  watchdog(session?: string | null): Watchdog | null;
  /** W794: how many auto-wake loops are mounted (diagnostics / tests). */
  autowakeLoops(): number;
  /** Is this session's sweep timer running? (no instance = false.) */
  watchdogRunning(session?: string | null): boolean;
  /** The session's live worker registry, or null when it has no instance. */
  workersOf(session?: string | null): WorkerRegistry | null;
  /** Tear every live instance down (idempotent). */
  shutdown(): Promise<void>;
}

/** Optional fields of one status frame (`source` marks the W769 auto-wake). */
interface StatusExtra {
  error?: string;
  source?: "autowake";
}

/**
 * W9206-31: are two resolved profiles the same configuration?
 *
 * A field-by-field comparison over the FROZEN key list (`PROFILE_KEYS`), so a
 * key added to `Profile` can never be silently excluded from the "did it
 * change?" test — which is why a hand-written field list is the wrong shape
 * here. Every profile field is a primitive or `null`, so `===` is exact; a
 * field that ever becomes an array/object would compare by reference, and
 * "different reference" is the SAFE direction (it still bumps).
 */
function sameProfile(a: Profile, b: Profile): boolean {
  return PROFILE_KEYS.every((key) => a[key] === b[key]);
}

class RealEngine implements RealRuntimeAdapter {
  readonly name = "real-runtime-adapter";
  private readonly opts: RealRuntimeAdapterOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly composer: SessionComposer;
  private readonly registry: SessionRuntimeRegistry;
  private profileValue: Profile;
  /**
   * W9104: the same-target retry budget. It is NOT a `Profile` key — the runtime
   * profile is the frozen 12-key contract — so the adapter owns the live value
   * and overlays it on the host view (`profile()`), which is what `GET /api/config`
   * echoes and what the fallback wiring reads at every wrap.
   */
  private maxRetries: number;
  private bus: StudioBus | null = null;
  private baseEpoch = 0;
  private toolCalls = 0;
  private shutdownPromise: Promise<void> | null = null;
  /**
   * W769: the wake-up loops (one per host conversation; see `host-autowake.ts`).
   * They carry no turn logic: the adapter supplies the wake callback below.
   */
  private readonly autowake: HostAutowake;
  /** E §4 P1 (W785): the process-wide fallback glue (see `fallback-host.ts`). */
  private readonly fallback: AdapterFallback;
  /** E §2.3 P0 ①: the resolved worker table path (null = in-memory only). */
  private readonly workerTable: string | null;
  /**
   * W863: the ONE default downgrade reporter of this adapter — it owns the
   * per-session (model, cause) memo, so a multi-step image turn reports ONCE
   * instead of once per step. A host-supplied `onModelDowngrade` still wins.
   */
  private readonly downgrades = createImageDowngradeReporter({ bus: () => this.bus });
  /** W783: process-wide user-question capability (table + host view). */
  private readonly questions = new QuestionHost({
    emit: (sessionId, turn, f) => void this.bus?.emit(f.event, turn, f.payload, sessionId),
    turnOf: (sessionId) => this.registry.peek(sessionId)?.turnNo ?? 0,
  });

  constructor(opts: RealRuntimeAdapterOptions = {}) {
    // W863: these two assignments share one line on purpose — this file sits
    // exactly on the eslint 400-code-line budget and the downgrade reporter
    // field above needs the line. Pure formatting, no behaviour change.
    this.opts = opts; this.env = opts.env ?? process.env;
    this.autowake = new HostAutowake({
      enabled: autowakeEnabled(this.env),
      lookup: (session) => autowakeStateOf(this.registry.peek(session)),
      wake: (session, input) => this.startAutowakeTurn(session, input),
    });
    const startup = opts.profile ?? defaultEngineProfile(this.env, "CELESTEA_API_KEY");
    this.profileValue = profileFromEngine(startup);
    this.maxRetries = retriesOf(startup);
    this.workerTable = workerTablePath({
      env: this.env,
      dataDir: opts.dataDir ?? null,
      resultsDir: opts.resultsDir ?? null,
      ...(opts.workerRegistryPath === undefined ? {} : { override: opts.workerRegistryPath }),
    });
    // E §4 P1 (W785): OFF unless `CELESTEA_LLM_FALLBACK` says on — `wrap()`
    // then returns null and the composer keeps the pre-P1 path (D9).
    this.fallback = new AdapterFallback({ dataDir: opts.dataDir ?? null, ledgerFile: opts.ledgerFile ?? null, env: this.env, bus: () => this.bus, peek: (s) => this.registry.peek(s), maxRetries: () => this.maxRetries, ...(opts.now === undefined ? {} : { now: opts.now }) });
    // F-06: the SAME-TARGET RETRY is a capability of its own, not a sub-case of
    // the fallback chain — a deployment with one endpoint still deserves it.
    // The decorator goes on the INNERMOST factory, so the composer ledger,
    // attachment and image-downgrade layers stay OUTSIDE it and keep observing
    // every attempt (a retry is another model step, never a hidden one).
    // `wiring.retryOnly` is inert while a chain IS armed: the chain already puts
    // a retry decorator in front of every target, and nesting a second one would
    // multiply the attempts.
    const baseLlm = opts.llm;
    const retryingLlm = (profile: Profile): Llm => {
      const inner = baseLlm === undefined ? createEngineLlm(profile, this.env) : baseLlm(profile);
      return this.fallback.wiring.retryOnly(inner, { name: RETRY_ONLY_TARGET, model: profile.model }, null);
    };
    this.composer = new SessionComposer({
      ...opts,
      llm: retryingLlm,
      env: this.env,
      baseProfile: () => this.profileValue,
      fallback: this.fallback.wiring,
      sessionHooks: (sessionId) => this.injectionHooks(sessionId),
      // W783: every composed session offers `ask_user_question` and publishes a
      // parked request on the bus as a `question` frame.
      questionRegistry: this.questions.table(),
      // W1467: the sub-call publisher shares this line for the same 400-line reason.
      publishQuestion: (sessionId, q) => this.questions.publish(sessionId, q), publishRunCodeEvent: (sid, e) => publishSubCall(sid, e, this.bus, (s) => this.registry.peek(s)?.turnNo ?? 0),
      // W804 section 7.6: the downgrade visibility is the HOST's job. The default
      // emits a status frame (statusline + info block) and an audit line; a host
      // may override it. W863: that default is now deduplicated per session by
      // (model, cause) — see `downgrades` above and image-downgrade.ts.
      onModelDowngrade: opts.onModelDowngrade ?? ((sessionId, info) => void this.downgrades.report(sessionId, info)),
    });
    this.registry = new SessionRuntimeRegistry({
      build: (sessionId, dir) => {
        const runtime = this.composer.compose(sessionId, dir);
        // W769: every host conversation gets a wake-up loop over its OWN mailbox.
        this.autowake.ensure(sessionId);
        return runtime;
      },
      dispose: (runtime) => disposeRuntime(runtime),
      currentEpoch: () => this.baseEpoch,
      maxLive: opts.maxLiveSessions ?? limitFromEnv(this.env, "CELESTEA_MAX_LIVE_SESSIONS", MAX_LIVE_SESSIONS),
      maxConcurrentTurns: opts.maxConcurrentTurns ?? limitFromEnv(this.env, "CELESTEA_MAX_CONCURRENT_TURNS", MAX_CONCURRENT_TURNS),
      idleTtlMs: opts.idleTtlMs ?? limitFromEnv(this.env, "CELESTEA_SESSION_IDLE_TTL_MS", SESSION_IDLE_TTL_MS),
      // The detached instance is never reclaimed (it backs `/api/tools`), nor is a
      // session with LIVE worker work (W513 pin) — the worker, its driver and its
      // row must outlive an idle sweep. W787: the pin follows LIVE work, not "the
      // registry holds rows": since the table persists (§2.2.3), a session that
      // ever spawned a worker would otherwise be pinned for the rest of the
      // process (and, across restarts, exempt from the session cap forever). A
      // settled row survives on disk and comes back with the next generation.
      pinned: (entry) => entry.key === keyOfSession(null) || hasLiveWorkersOf(entry),
      // W742 §1: only LIVE worker work defers a rebuild; a settled, parked worker
      // must not block the generation swap of its session forever.
      rebuildDeferred: (entry) => hasLiveWorkersOf(entry),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    // W742 §2: arm the low-frequency reclaimer (unref'ed; `shutdown` disarms it).
    this.registry.startReclaimer();
    this.registry.ensure(null, null);
  }

  // --- host lifecycle ----------------------------------------------------

  attach(bus: StudioBus): void {
    this.bus = bus;
  }

  // --- W783: user questions (the capability itself lives in QuestionHost) ---
  answerQuestion(requestId: string, answers: AskUserQuestionAnswerItem[], sessionId?: string): QuestionAnswerOutcome {
    return this.questions.answer(requestId, answers, sessionId);
  }
  pendingQuestions(sessionId?: string | null): PendingQuestionView[] {
    return this.questions.list(sessionId);
  }

  generationEpoch(): number { return this.baseEpoch; }

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
    if (this.shutdownPromise === null) {
      // W769: unpark the wake-up loops FIRST: a loop that grabbed a queue during
      // the teardown would otherwise start a turn on a disposing runtime.
      // W833 (R3 B8 / W816 F4): flush the in-flight fallback audit POSTs before
      // the process can drop them (main.ts flushes grants, this flushes llm).
      this.shutdownPromise = this.autowake.stop().then(() => this.fallback.flush()).then(() => this.registry.shutdown());
    }
    await this.shutdownPromise;
  }

  /** Is auto-wake on? (`CELESTEA_AUTOWAKE`, read once at construction.) */
  get autowakeRunning(): boolean { return this.autowake.running; }
  /** W794: mounted auto-wake loops (one per live host conversation). */
  autowakeLoops(): number { return this.autowake.count; }
  /**
   * Run ONE ordinary turn with the drained receipts as its input — the same
   * `beginTurn` + status + `drive` path a `POST /api/turn` takes, with
   * `source: "autowake"` on the start frame (contracts/sse-events.json allows
   * it). Returns false when the slot is gone (session deleted) or already taken
   * (busy): the loop then re-queues the messages into the CURRENT generation and
   * retries, so nothing is lost and nothing is consumed twice.
   */
  private startAutowakeTurn(session: string | null, input: string | null): boolean {
    const entry = this.registry.peek(session);
    if (entry === null || entry.inFlight) return false;
    // W855 C8: a null wake needs the lane; a throw before/at the claim keeps it.
    if (input === null && entry.runtime.pendingInjections("next-turn") === 0) return false;
    try {
      const turn = this.launch(entry, input, undefined, "autowake");
      autowakeLog(session, `woke the host: turn ${turn}`);
      return true;
    } catch (error) {
      if (error instanceof CapacityError) return false;
      if (entry.inFlight) this.registry.endTurn(entry, null);
      autowakeLog(session, `wake failed: ${error instanceof Error ? error.message : String(error)}; messages kept queued`);
      return false;
    }
  }

  /** The composed tool registry of the default instance (`GET /api/tools`). */
  tools(): ToolInfo[] {
    return (this.registry.peek(null)?.runtime.tools?.schemas() ?? []).map(toolSpecView);
  }

  /**
   * W729 (S2): the tool face of ONE session — never a second assembly, always
   * the default generation's registered set passed through that SESSION's mode.
   *
   * W791 (P1, §5.2 #5 / §10.5 #2): the face is a function of the MODE, not of
   * "whichever instance happens to be live". This is called while the session's
   * own prompt is assembled — i.e. DURING its compose / rebuild — and at that
   * moment `peek(session)` still answers the previous generation, so a
   * peek-derived face would render the old tool list into the new prompt (and,
   * on a first compose, the detached default's 11 names into an execution
   * session's prompt). `faceForMode` applies exactly the rule the composed
   * instance's `exposedRegistry` will apply, so prompt and tool array agree.
   * W857: the rule also includes the session's PERMISSION baseline (W9
   * `toolDeny`), read through the composer's OWN reader so the reported face
   * cannot disagree with the instance the session dispatches through; an
   * absent reader / empty deny = the pre-W857 bytes.
   */
  sessionTools(session: string | null): ToolInfo[] {
    const specs = this.registry.peek(null)?.runtime.tools?.schemas() ?? [];
    const mode = session === null ? DEFAULT_SESSION_MODE : effectiveMode(this.opts.sessionMode?.(session) ?? null);
    // W857: the deny is read through the composer's own reader, same session dir.
    return faceForMode(specs, mode, this.opts.grants?.read(session, session === null ? null : (this.opts.resolveSession?.(session)?.dir ?? null)).grants.toolDeny ?? []).map(toolSpecView);
  }

  /**
   * W515 §2/§4: the session's inbox publishes every placement change on the bus
   * (see `session-publisher.ts` for the shapes).
   */
  private injectionHooks(sessionId: string | null): SessionInjectionHooks {
    return injectionHooksOf(sessionId, {
      emitStatus: (id, payload) => void this.bus?.emit("status", 0, payload, id),
      now: this.now,
    });
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
    // The registry rebuilds an instance IN PLACE (the entry object survives), so
    // the comparison has to be on the runtime, not on the entry (W516: a grant
    // invalidates exactly one session, and `rebuilt` is how the host sees it).
    const previous = before?.runtime;
    const entry = this.entryFor(session);
    return {
      runtime: before === null ? "created" : "reused",
      busy: entry.inFlight,
      rebuilt: previous !== undefined && previous !== entry.runtime,
    };
  }

  /**
   * W516 §4.2: the session's grants were written, so ITS instance is stale. An
   * idle instance is recomposed now, a busy one at its next turn boundary — and
   * no other session is touched (that is why this is not `invalidateAll`).
   */
  invalidateSession(session: string | null): boolean { return this.registry.invalidateSession(session); }

  /** W794: the session is being removed — see `session-release.ts`. */
  releaseSession(session: string | null): Promise<boolean> {
    const release = { registry: this.registry, cancel: (id: string) => this.cancel(id), forget: (id: string) => this.autowake.forget(id), settleMs: releaseSettleMs(this.env) };
    return releaseSessionOf(release, session);
  }

  liveSessions(): string[] { return this.registry.liveSessionIds(); }

  busySessions(): string[] { return this.registry.busySessionIds(); }

  // --- turns -------------------------------------------------------------

  isBusy(session?: string | null): boolean {
    if (session === undefined) return this.registry.inFlightCount() > 0;
    return this.registry.peek(session)?.inFlight ?? false;
  }

  async startTurn(req: TurnRequest): Promise<TurnStart> {
    const entry = this.entryFor(req.session);
    if (entry.inFlight) throw new TurnBusyError("turn");
    // W515 §2: this input IS the turn, so it is already in the context.
    return { turn: this.launch(entry, req.input, req.attachments), placement: "context" };
  }

  /**
   * Claim the slot and start one turn — the ONE path both a manual turn and a
   * W769 auto-wake take, so SSE frames, statusline phases, the turn number and
   * the busy guard cannot differ between them.
   */
  private launch(entry: SessionRuntime, input: string | null, attachments?: readonly ImageRef[], source?: "autowake"): number {
    const controller = new AbortController();
    const turn = this.beginTurn(entry, controller);
    // W833 (R3 B8 / W816 F5): the signature is source?: "autowake", so the
    // sentinel is undefined — === null was always false and every manual turn
    // carried a source: undefined KEY in the payload.
    this.emitStatus(entry, turn, "start", source === undefined ? {} : { source });
    void this.drive(entry, input, turn, controller, attachments);
    return turn;
  }

  /**
   * W513/W515 §1-§3: the delivery decision table in one place —
   *   owner session RUNNING (or closing) -> `next-step` lane, a STEERING message
   *   consumed at the running turn's next step boundary (`injected: true`);
   *   owner session IDLE -> `next-turn` lane, QUEUED for the next turn start.
   * The lane is what makes "insert now" and "wake me later" the same mechanism.
   *
   * W847 adds the caller's explicit `mode: "queue"`: on a BUSY session it also
   * picks the next-turn lane, so the running turn is left untouched (placement
   * `queued`, `injected: false`) and the input is drained at the NEXT turn start.
   */
  inject(req: TurnRequest): InjectOutcome {
    const entry = this.registry.peek(req.session);
    const busy = entry?.inFlight === true;
    // W847: only an explicit "queue" on a busy session diverts the input; the
    // omitted request and "steer" keep the W513 table byte for byte.
    const steering = busy && req.mode !== "queue";
    const target = entry ?? this.entryFor(req.session);
    const message = target.runtime.inject(req.input, steering ? "next-step" : "next-turn", { kind: "user", source: { kind: "user", form: "message" } });
    target.lastActiveAt = this.now();
    return {
      turn: target.turnNo,
      injected: steering,
      pending: target.runtime.pendingInjections(steering ? "next-step" : "next-turn"),
      placement: steering ? "steering" : "queued",
      duplicate: message.duplicate,
    };
  }

  private beginTurn(entry: SessionRuntime, controller: AbortController): number {
    try {
      return this.registry.beginTurn(entry, controller);
    } catch (e) {
      throw capacityErrorOf(e);
    }
  }

  /**
   * Drive one turn to its terminal state, then publish the closing status.
   *
   * W794: a turn whose session was DELETED while it ran publishes nothing more.
   * `releaseSession` aborts it first, but the unwind is asynchronous, so the tail
   * of this method can run after the directory has moved — the detached flag is
   * what keeps a dangling frame for a session that no longer exists off every SSE
   * subscriber's stream (and off the released runtime's statusline, which would
   * throw). The turn's own log write is unaffected: it already happened.
   */
  private async drive(
    entry: SessionRuntime,
    input: string | null,
    turn: number,
    controller: AbortController,
    attachments?: readonly ImageRef[],
  ): Promise<void> {
    try {
      const outcome = await entry.runtime.runTurn(input, {
        signal: controller.signal,
        sink: (frame) => this.emitFrame(entry, frame.event, turn, frame.payload),
        ...(attachments === undefined ? {} : { attachments }),
      });
      this.registry.endTurn(entry, outcome);
      // A FAILED turn RETURNS an outcome, it does not throw (see errorExtraOf).
      this.emitStatus(entry, turn, outcomePhaseOf(outcome), this.errorExtraOf(outcome));
    } catch (e) {
      this.registry.endTurn(entry, null);
      this.emitStatus(entry, turn, "error", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * W794: the ONE gate every frame of a session's turn goes through. A turn whose
   * session was DELETED while it ran publishes nothing more — `releaseSession`
   * aborts it first, but the unwind is asynchronous, so the tail of `drive` can run
   * after the directory moved. Without this a subscriber would receive a dangling
   * frame for a session that no longer exists (and reading the released runtime's
   * statusline would throw). The turn's own log write is unaffected: it happened.
   */
  private emitFrame(entry: SessionRuntime, event: SseEventName, turn: number, payload: Record<string, unknown>): void {
    if (entry.detached === true) return;
    this.bus?.emit(event, turn, payload, entry.sessionId);
  }

  cancel(session?: string | null): boolean {
    const entry = session === undefined ? this.newestBusy() : this.registry.peek(session);
    if (entry === null || entry === undefined || !entry.inFlight || entry.controller === null) return false;
    entry.controller.abort();
    return true;
  }

  private newestBusy(): SessionRuntime | null {
    // W833 (R3 B8 / W816 F7): registry.list() is CREATION order, so pick the
    // in-flight entry with the greatest lastActiveAt (the most recently used).
    let newest: SessionRuntime | null = null;
    for (const entry of this.registry.list()) if (entry.inFlight && (newest === null || entry.lastActiveAt >= newest.lastActiveAt)) newest = entry;
    return newest;
  }

  lastTurnOutcome(): TurnOutcome | null {
    let best: SessionRuntime | null = null;
    for (const entry of this.registry.list()) {
      if (entry.lastOutcome === null) continue;
      if (best === null || entry.lastActiveAt >= best.lastActiveAt) best = entry;
    }
    return best?.lastOutcome ?? null;
  }

  // --- workers: liveness (W740) ------------------------------------------

  /** The session's watchdog (see `watchdog-view.ts`); unknown = null, never composed. */
  watchdog(session?: string | null): Watchdog | null { return watchdogOf(this.registry, session); }

  /** Is this session's sweep timer running? (no instance / watchdog off = false.) */
  watchdogRunning(session?: string | null): boolean { return watchdogRunningOf(this.registry, session); }

  /** The session's live worker registry, or null when it has no instance. */
  workersOf(session?: string | null): WorkerRegistry | null { return this.registry.peek(session ?? null)?.runtime.workers ?? null; }

  /**
   * The terminal `status` frame's `error`, for a turn that failed by RETURNING
   * an outcome rather than by throwing.
   *
   * The loop turns its own failures (LLM timeout, torn stream, gateway 504) into
   * `{error:{kind,message}}` and returns them, so emitting only the phase left
   * the UI showing its "未知错误"/"unknown error" placeholder while the session
   * log held the real reason. `{}` for a healthy turn: the contract declares
   * `error` optional and clients read its PRESENCE as failure.
   */
  private errorExtraOf(outcome: TurnOutcome): StatusExtra {
    const parts = outcomeErrorParts(outcome);
    return parts === null ? {} : { error: parts.message };
  }

  private emitStatus(entry: SessionRuntime, turn: number, phase: string, extra: StatusExtra = {}): void {
    // W833 (R3 B8): a drive tail can land after the generation was released
    // (adapter.shutdown -> registry.shutdown). Reading a released runtime's
    // statusline throws RuntimeReleasedError; a status frame for it is
    // meaningless anyway, so skip it exactly like the W794 detached case.
    if (entry.detached === true || entry.runtime.isReleased) return;
    this.bus?.emit("status", turn, { phase, statusline: entry.runtime.statusline(), ...extra }, entry.sessionId);
  }

  // --- host views --------------------------------------------------------

  profile(): EngineProfile { return { ...engineProfileOf(this.profileValue), max_retries: this.maxRetries }; }

  /**
   * W725: the session's model-visible context (`GET /api/sessions/{id}/context`).
   * The instance is ensured first (same path as activate / a turn), then the
   * agent loop assembles the request — this adapter only forwards it, so the
   * snapshot is the engine's own, never a host-side re-derivation.
   */
  sessionContext(session: string | null): SessionContextView {
    // W729: THAT session's profile (mode variant included), not the process's.
    return sessionContextOf(this.entryFor(session).runtime, this.composer.profileFor(session));
  }

  /** E §4.2.3 #4 (W785): the fallback block of `/api/status` (null = off). */
  fallbackView(session: string | null): FallbackStatusView | null { return this.fallback.view(session); }

  /** The requested session's statusline (no instance yet = an empty one). */
  statusline(session?: string | null): Statusline {
    const entry = this.registry.peek(session ?? null);
    if (entry !== null) return entry.runtime.statusline();
    // W755: a cold session measures nothing — `coldStatusline` owns that shape.
    const profile = this.profileValue;
    return coldStatusline({ ...profile, context_window: profile.context_window_tokens, now: this.now });
  }

  // --- E-P1 (capability 3, W785): the usage ledger's aggregate views --------
  // Both read the ONE process-shared ledger file through `ledger-view.ts` (no
  // cache: a row booked a moment ago is visible to the next poll).

  /** `GET /api/usage/ledger` (see `ledger-view.ts`). */
  usageLedger(q: LedgerQuery): LedgerQueryResult | { ok: false; error: string } { return usageLedgerView(this.opts.ledgerFile ?? null, q); }

  /** `/api/status.cost`: `null` (no ledger) makes the handler omit the key. */
  costBlock(session: string | null): LedgerCostBlock | null {
    const dir = session === null ? null : (this.opts.resolveSession?.(session)?.dir ?? null);
    return costBlockView(this.opts.ledgerFile ?? null, session, dir);
  }

  async configure(patch: ProfilePatch): Promise<EngineProfile> {
    if (patch.api_key !== undefined && patch.api_key !== "") this.env[this.profileValue.api_key_env] = patch.api_key;
    const before = this.profileValue;
    const beforeRetries = this.maxRetries;
    const next = applyProfilePatch(before, patch);
    const nextRetries = patch.max_retries === undefined ? beforeRetries : clampRetries(patch.max_retries);
    this.profileValue = next;
    this.maxRetries = nextRetries;
    // W9206-31: bump ONLY when the effective configuration really moved. An
    // epoch bump is not free — it invalidates every idle session instance, so
    // `POST /api/config {}` or a client re-sending the current values (a Save
    // button, a script) used to tear down and rebuild the whole registry for
    // nothing. The comparison is on the RESOLVED profile, so a patch that
    // normalizes to the current value (`max_steps: 0` floored to MIN_STEPS, a
    // truncated float, a `null` that stays `null`) is correctly a no-op.
    if (!sameProfile(before, next) || beforeRetries !== nextRetries) this.bumpEpoch();
    return this.profile();
  }

  /** Config change: instances are rebuilt lazily, at their next turn boundary. */
  private bumpEpoch(): void {
    this.baseEpoch += 1;
    this.registry.invalidateAll();
  }

  async clear(session: string | null): Promise<ClearOutcome> {
    return clearSession(this.registry, session);
  }

  async compact(session: string): Promise<CompactOutcome> {
    return compactSession(this.lifecycleDeps(), session);
  }

  /** Everything `clear`/`compact` need (see `session-lifecycle.ts`). */
  private lifecycleDeps(): SessionLifecycleDeps {
    return {
      registry: this.registry,
      resolve: (id) => this.opts.resolveSession?.(id) ?? null,
      summarizer: () => this.composer.summarizer(),
    };
  }

  // --- workers -----------------------------------------------------------

  /** Merged worker rows over every live instance (W513 aggregate view). */
  workerSessions(): WorkerSessionRow[] { return mergedWorkerRows(this.registry.list()); }

  /** W1470b: the persisted table previous generation, for the panel. */
  inheritedWorkerSessions(): WorkerSessionRow[] { return inheritedPanelRows(this.workerTableState(this.workerSessions()).inherited); }

  workerMessages(sessionId: string): unknown[] | null { return workerMessagesAcross(this.registry.list(), sessionId); }

  async workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome> {
    return spawnWorkerThrough(this.entryFor(req.session ?? null), req, `host-spawn-${(this.toolCalls += 1)}`);
  }

  async workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>> {
    return sendWorkerThrough(this.registry.list(), req, () => `host-send-${(this.toolCalls += 1)}`);
  }

  /**
   * W740 §2: the panel/tool face is where a watchdog verdict becomes visible —
   * `by_status` counts the registry rows, so a settle changes it, and the count of
   * live sweepers rides along.
   */
  workerStatus(wid?: string): WorkerStatusReport {
    // W894: `statusline` PEEKS, so measuring a worker never composes a cold session.
    const own = this.workerSessions();
    const table = this.workerTableState(own);
    return workerStatusOf(own, watchdogCount(this.registry.list()), { wid, recovery: table.recovery, inherited: inheritedPanelRows(table.inherited), contextOf: (sess) => this.statusline(sess).context_usage });
  }

  /** E §1.3 P1 ②: `/api/status.recovery` of one session (never composes one). */
  recoveryView(session: string | null): RecoveryView {
    return recoveryViewOf(this.registry.peek(session)?.runtime.session ?? null, session);
  }

  /**
   * E §2.3 P0 ③: judge the PERSISTED table on every status poll (the boot
   * observer writes the same judgement to the audit channel once). Observation
   * only — nothing here settles a row or re-dispatches a worker (P2 territory).
   */
  private workerTableState(own: readonly WorkerSessionRow[]): WorkerTableState {
    // W1479: `hostExists` (existence), NOT `resolveSession != null` (location — it
    // also succeeds for a session that does not exist, so every host looked alive
    // and `orphans[]` could never fill). Absent = "cannot tell" = never an orphan.
    const exists = this.opts.hostExists;
    const knownHost = exists === undefined ? {} : { knownHost: (sid: string) => exists(sid) };
    return workerTableStateOf({ path: this.workerTable, ownWids: own.map((row) => row.wid ?? ""), pid: process.pid, ...knownHost, resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"), now: this.now() });
  }

  // --- internals ---------------------------------------------------------

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }
}

/** Build the real adapter (the host's default engine). */
export function createRealRuntimeAdapter(opts: RealRuntimeAdapterOptions = {}): RealRuntimeAdapter {
  return new RealEngine(opts);
}
