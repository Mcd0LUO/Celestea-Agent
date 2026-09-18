/**
 * SessionComposer — `compose()` for ONE session (W513).
 *
 * Every session runtime is one self-consistent generation: its own profile
 * snapshot (base profile + the session's `session.json` model override), its own
 * session binding (`<dir>/cli-main.jsonl` or an in-memory log when detached),
 * its own usage tracker, its own agent loop instance and its own worker
 * registry. Nothing is shared but the process (and the LLM seam factory), which
 * is exactly what makes two sessions unable to see each other's history.
 *
 * The module also owns the resource caps and the two error channels the host
 * maps onto HTTP 503, so the adapter itself stays about the HTTP contract.
 */

import { createUsageTracker, DefaultAgentLoop } from "@celestea/agent-loop";
import type { Llm, PendingInjection, Sandbox, SessionLog, Tool, ToolGuard } from "@celestea/core";
import { createSessionInbox, type SessionInbox } from "@celestea/runtime";
import {
  createLedgerLlm,
  createUsageLedger,
  hostOf,
  HOST_SESSION_ID,
  type UsageLedger,
  type UsageLedgerFile,
} from "@celestea/runtime";
import { InMemorySessionLog } from "@celestea/session";
import {
  compose,
  llmSummarizer,
  SessionCapacityError,
  TurnCapacityError,
  type Profile,
  type Runtime,
  type SessionBinding,
  type Summarizer,
  type WatchdogMountSettings,
  type WorkerWiring,
} from "@celestea/runtime";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapacityError } from "../runtime-adapter.js";
import { bindingFor, closeLog, workerSessionPrefix, type CheckpointWiring, type SessionTarget } from "./engine-session.js";
import { sessionIdOfDir } from "./engine-grants.js";
import { DEFAULT_SESSION_MODE, effectiveMode } from "../store/mode.js";
import { enginePlugins, type DisclosureOptions, type QuestionWiring } from "./engine-plugins.js";
import type { PendingQuestion, QuestionRegistry } from "../question-registry.js";
import { questionAnsweredRow, questionAskedRow } from "../question-rows.js";
import { EMPTY_GRANTS } from "./engine-grants.js";
import { createEngineLlm } from "./llm-assembly.js";
import type { FallbackWiring } from "./fallback-host.js";
import { workerTablePath } from "./worker-table.js";
import type { RecoveryAuditWriter } from "./recovery-audit.js";
import type { SessionGrantsReader } from "./session-grants.js";
import { ATTACHMENTS_DIRNAME, createAttachmentStore, type AttachmentStore } from "@celestea/tools";
import { createImageDowngradeLlm, type ImageDowngradeInfo, type Llm as ProviderLlm } from "@celestea/llm";
import { withAttachments } from "./attachments-llm.js";

/** W510 resource caps (overridable through the adapter options or the env). */
export const MAX_LIVE_SESSIONS = 4;
export const MAX_CONCURRENT_TURNS = 2;
export const SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;

/**
 * Per-session injection wiring the host supplies (placement over SSE, W515 §2).
 * The HOST builds it in `session-publisher.ts`; the fields are optional here
 * because a session with no observers gets a plain inbox and no callback.
 */
export interface SessionInjectionHooks {
  /** The session's inbox (default: a plain one with no observers). */
  inbox?: SessionInbox;
  /** Called when a message LEAVES a lane and becomes model-visible history. */
  onInjected?: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void;
}

export interface SessionComposerOptions {
  env: NodeJS.ProcessEnv;
  /** Build the injection hooks of one session instance (inbox + observer). */
  sessionHooks?: (sessionId: string | null) => SessionInjectionHooks;
  /** BASE profile (the `/api/config` one); sessions add their model override. */
  baseProfile: () => Profile;
  /** Host lookup: `<workspace>/<session>` -> directory (null = detached). */
  resolveSession?: (id: string) => SessionTarget | null;
  /** Session-level model override (`session.json`), applied per instance. */
  sessionModel?: (id: string) => string | null;
  /**
   * W729: session-level mode (`session.json.mode`; null = the session never
   * declared one). Consumed by the worker wiring, so a worker's row/receipt can
   * record the mode of the session that spawned it (§2.3).
   */
  sessionMode?: (id: string) => string | null;
  /**
   * W729 (§5.1 #4, R3): the session's OWN system prompt. Without this hook the
   * process would assemble ONE prompt at startup and every session would share
   * it — the mode would then only hold for the focused session. `null` = "use
   * the base profile prompt" (a session with no declared mode, K8).
   */
  sessionSystemPrompt?: (id: string) => string | null;
  /**
   * E §4 P1 (W785): the model-fallback wiring. `wrap()` returns null while the
   * capability is off (`CELESTEA_LLM_FALLBACK` unset — the default), so the
   * pre-P1 path stays byte-for-byte identical (D9); when armed it returns the
   * decorated seam and the ledger is booked PER ATTEMPT by the decorator
   * instead of once per call, which is what makes D6's rows possible.
   */
  fallback?: FallbackWiring | null;
  /** LLM seam factory; default = the assembled engine LLM (live provider). */
  llm?: (profile: Profile) => Llm;
  /** Extra tools registered after the six builtins. */
  tools?: readonly Tool[];
  /**
   * W806 (P0): dynamic tool disclosure for the composed sessions. Absent = the
   * static mode baseline (byte-identical face). Present = a reduced initial set
   * is offered and the rest is revealed one turn at a time. The DETACHED
   * generation never takes it: it backs `{{tools}}` / `GET /api/tools`, which
   * must keep announcing the static disclosable universe (S3).
   */
  disclosure?: DisclosureOptions;
  sandbox?: Sandbox;
  /** Guard override: `undefined` = production guard, `null` = no guard. */
  guard?: ToolGuard | null;
  /** Disable worker orchestration wiring entirely. */
  workers?: false;
  /**
   * W740: the liveness watchdog over this session's worker registry. Omitted =
   * the environment decides (`compose()` reads it); `false` never mounts it.
   * The sweep timer dies with the instance (the runtime's shutdown hook), so a
   * reclaimed session leaks nothing.
   */
  watchdog?: Partial<WatchdogMountSettings> | false;
  /** Worker receipt/report directory (default `<cwd>/worker-results`). */
  resultsDir?: string;
  /**
   * E §2.3 P0 ①: the worker table this process writes. `undefined` = derive it
   * (`CELESTEA_WORKER_REGISTRY`, else `<data dir>/worker-registry.tsv`);
   * `null` = IN-MEMORY only, which stays a first-class option for tests and
   * embedded hosts (B6 is about the DEFAULT, not about removing the choice).
   */
  workerRegistryPath?: string | null;
  /** `<data dir>` — the default home of that table (see `worker-table.ts`). */
  dataDir?: string | null;
  /** Compact summarizer override (default: the `Llm` seam). */
  summarize?: (profile: Profile) => Summarizer;
  /**
   * Session grants reader (W516 §4.2): read at every compose, so a grant or a
   * revocation is visible at the session's next turn boundary and never inside
   * a running turn. Absent = no grants at all (tests, embedded use).
   */
  grants?: SessionGrantsReader;
  /**
   * W728 §3 P0: the process-shared append-only usage ledger. Absent/null = this
   * generation books nothing (tests, embedded use); the studio host creates ONE
   * file per process (`<data dir>/usage-ledger.jsonl`) and every session
   * instance books its own rows into it.
   */
  ledgerFile?: UsageLedgerFile | null;
  /** Provider row id of the startup target, recorded as the ledger's `provider`. */
  providerLabel?: string | null;
  /**
   * E §1.3 P0 ②: checkpoint sidecar wiring. A persistent session log is always
   * checkpointed; this only overrides the process identity (`boot_id`/`pid`) and
   * the clock, which tests pin to keep the written file deterministic.
   */
  checkpoint?: CheckpointWiring;
  /**
   * W787 (§5.2③): the audit channel of the recovery facts this process observes
   * (a degraded session log). Absent = no audit line is written.
   */
  recoveryAudit?: RecoveryAuditWriter | null;
  now?: () => number;
  /**
   * W783: the process-wide pending-question table. Present = every composed
   * session offers `ask_user_question`; absent = no session does (tests and
   * embeddings that have no human answerer).
   */
  questionRegistry?: QuestionRegistry | null;
  /**
   * W783: publish one parked question as a `question` SSE frame. The composer
   * supplies it (it knows the session id and can reach the bus); absent = the
   * frame is not emitted, which no production host wants.
   */
  publishQuestion?: (sessionId: string | null, question: PendingQuestion) => void;
  /**
   * W804: the configured input_modalities of one model id, or null when the
   * model is unknown/unconfigured (=> optimistic default: image input allowed).
   */
  modelInputModalities?: (modelId: string) => readonly string[] | null;
  /**
   * W804 (section 7.6): a model rejected image input and the turn was downgraded
   * to text + placeholders. The host turns this into the three visible channels
   * (info block / statusline / audit).
   */
  onModelDowngrade?: (sessionId: string | null, info: ImageDowngradeInfo) => void;
}

/** Non-negative integer from the environment, else the frozen default. */
export function limitFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Shut one instance down and close its log descriptor (order matters). */
export async function disposeRuntime(runtime: Runtime): Promise<void> {
  const log = runtime.session;
  await runtime.shutdown();
  closeLog(log);
  runtime.release();
}

/** Wrap the registry caps into the ONE error the HTTP layer maps to 503. */
export function capacityErrorOf(e: unknown): unknown {
  if (e instanceof SessionCapacityError) return new CapacityError(`too many live sessions (limit ${e.limit})`);
  if (e instanceof TurnCapacityError) return new CapacityError(`too many concurrent turns (limit ${e.limit})`);
  return e;
}

export class SessionComposer {
  private readonly memoryLogs = new Map<string, SessionLog>();

  constructor(private readonly opts: SessionComposerOptions) {}

  /** Compose one session generation (the registry's build factory). */
  compose(sessionId: string | null, dir: string | null): Runtime {
    const profile = this.profileFor(sessionId);
    // W804 (multimodal P0 section 5): the session's attachment store. It lives
    // INSIDE the session directory, so trash/archive/delete carry it along. The
    // DETACHED generation (dir === null, the face /api/tools and the default
    // prompt read) gets a host-level store so read_image is part of the SAME face
    // every session's prompt advertises; a session-less turn is the only caller
    // that could ever write there.
    const attachments = createAttachmentStore(
      dir === null ? join(tmpdir(), "celestea-detached-attachments") : join(dir, ATTACHMENTS_DIRNAME),
    );
    // Optimistic default (section 7.1): only an EXPLICIT input_modalities without
    // "image" disables the read_image gate; an unknown model stays optimistic.
    const modalities = this.opts.modelInputModalities?.(profile.model) ?? null;
    const imageInputAllowed = modalities === null ? true : modalities.includes("image");
    // W768: the session's OWN workspace, taken from the same resolution the
    // system prompt renders (the host's `resolveSession` hook). A session with no
    // resolvable workspace keeps the process env posture — never a failure.
    const workspace = sessionId === null ? null : (this.opts.resolveSession?.(sessionId)?.workspace ?? null);
    const reader = this.opts.grants;
    const read = reader?.read(sessionId, dir) ?? { grants: EMPTY_GRANTS, warnings: [] };
    // W728: the ledger must exist before the Llm wrapper (every step books).
    const ledger = this.usageLedger(sessionId, dir);
    // W783: the question wiring of THIS generation. The runtime handle does not
    // exist until `compose()` below returns, so the wiring reaches it through a
    // holder it fills in immediately afterwards — the same late-binding the
    // `isLive` probe and the log write both need.
    const questionHolder: { runtime: Runtime | null } = { runtime: null };
    const questions = this.questionWiring(sessionId, questionHolder);
    const engine = enginePlugins({
      profile,
      // W791 (P1, §5.2 #2): the mode decided at compose time. The DETACHED
      // generation never asks the hook (its id is not addressable), a session
      // without a declared mode reads as `standard` (K8), and both compose the
      // whole registry — so nothing about a pre-P1 generation changes.
      mode: sessionId === null ? DEFAULT_SESSION_MODE : effectiveMode(this.opts.sessionMode?.(sessionId) ?? null),
      workspace: workspace === null ? null : { workspace: workspace.path },
      ...(questions === null ? {} : { questions }),
      attachments,
      imageInputAllowed,
      llm: this.engineLlm(sessionId, profile, ledger, attachments),
      workers: null, // the workers plugin registers the three tools, in compose order
      ...(this.opts.disclosure === undefined || sessionId === null ? {} : { disclosure: this.opts.disclosure }),
      ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
      ...(this.opts.sandbox === undefined ? {} : { sandbox: this.opts.sandbox }),
      ...(this.opts.guard === undefined ? {} : { guard: this.opts.guard }),
      grants: read.grants,
      ...(reader === undefined ? {} : { audit: reader.audit(sessionId) }),
      env: this.opts.env,
    });
    // After the boundary is built: audit the generation and spend one-shots, so
    // THIS turn keeps its grants and the next one sees the consumption.
    reader?.onComposed(sessionId, dir, read);
    const usage = createUsageTracker();
    const hooks = this.opts.sessionHooks?.(sessionId) ?? {};
    const composed = compose({
      profile,
      plugins: engine.plugins,
      sessionBinding: this.bindingTo(sessionId, dir),
      usage,
      ...(ledger === null ? {} : { ledger }),
      inbox: hooks.inbox ?? createSessionInbox(),
      ...(hooks.onInjected === undefined ? {} : { onInjected: hooks.onInjected }),
      loopFactory: (bindings) => {
        // W806: the turn boundary is the ONLY place the disclosed set may move.
        engine.tools.disclosure.beginTurn();
        return new DefaultAgentLoop(bindings.config, {
          signal: bindings.signal,
          sink: bindings.sink,
          usage,
          ...(bindings.injections === undefined ? {} : { injections: bindings.injections }),
        });
      },
      workers: this.workerWiring(sessionId, profile),
      // W740: the watchdog settings come from the process environment; the
      // composition root reads them and registers the stop hook with the sweep.
      env: this.opts.env,
      ...(this.opts.watchdog === undefined ? {} : { watchdog: this.opts.watchdog }),
      ...(this.opts.now === undefined ? {} : { now: this.opts.now }),
    });
    // W783: bind the just-composed runtime into the question wiring, so
    // `isLive` and the `user_question` log row address THIS generation.
    questionHolder.runtime = composed;
    return composed;
  }

  /**
   * W783: the user-question wiring of ONE session generation, or null when the
   * host mounted no table (the tool is then not offered to the model at all).
   *
   * The bus is the SESSION's own (`compose()` provides it), filled in by the
   * plugin body: an answerer chain per generation is what stops a question asked
   * in one session from being answered into another.
   */
  private questionWiring(
    sessionId: string | null,
    holder: { runtime: Runtime | null },
  ): QuestionWiring | null {
    const registry = this.opts.questionRegistry;
    if (registry === undefined || registry === null) return null;
    return {
      registry,
      sessionId,
      bus: { current: null },
      isLive: () => holder.runtime !== null && !holder.runtime.isReleased,
      publish: (question) => this.opts.publishQuestion?.(sessionId, question),
      record: (question) => holder.runtime?.session.append(questionAskedRow(question)),
      recordAnswer: (requestId, answers, timedOut) =>
        holder.runtime?.session.append(questionAnsweredRow(requestId, answers, timedOut)),
    };
  }

  /**
   * The session's ledger, or null when the host did not wire one. The session
   * label is the file's self-description (`<workspace>/<session>`, §3.2.1).
   */
  private usageLedger(sessionId: string | null, dir: string | null): UsageLedger | null {
    const file = this.opts.ledgerFile;
    if (file === undefined || file === null) return null;
    return createUsageLedger({ session: dir === null ? (sessionId ?? HOST_SESSION_ID) : sessionIdOfDir(dir), file });
  }

  /**
   * E §4 P1 (W785): the ONE place a composed generation decides which `Llm` it
   * runs on. Fallback OFF (or unwired) = the W728 path unchanged (ledger wrapper
   * around the raw seam). Fallback ON = the decorator, which books one ledger
   * row per ATTEMPT and hands the switch to the next target.
   */
  private engineLlm(sessionId: string | null, profile: Profile, ledger: UsageLedger | null, attachments: AttachmentStore | null): Llm {
    const inner = this.llmFactory()(profile);
    const wrapped =
      this.opts.fallback?.wrap({
        inner,
        profile,
        sessionId,
        steps: ledger,
        provider: this.opts.providerLabel ?? null,
      }) ?? null;
    const observed = wrapped ?? this.stepObservedLlm(inner, profile, ledger);
    // W804: resolve image references to a REQUEST-scoped data-URL table (inner),
    // then downgrade once on an "image unsupported" 400 (outer). The downgrade
    // decorator is provider-seam typed; it only forwards streams, so the cast is
    // a type-level bridge (same pattern as fallback-host.ts).
    const resolved = withAttachments(observed, attachments);
    return createImageDowngradeLlm({
      inner: resolved as unknown as ProviderLlm,
      onDowngrade: (info) => this.opts.onModelDowngrade?.(sessionId, info),
      // W855: the SAME per-model modality gate that feeds read_image. It is
      // evaluated against the request's own req.model (inside the decorator),
      // so a model switch is never stale. null (unconfigured) = optimistic:
      // images allowed; only an EXPLICIT list without "image" is text-only.
      isTextOnly: (requestModel) => {
        const modalities = this.opts.modelInputModalities?.(requestModel) ?? null;
        return modalities !== null && !modalities.includes("image");
      },
    }) as unknown as Llm;
  }

  /**
   * W728 §3 P0: wrap the engine `Llm` so every model step books one ledger row
   * (success, failure and retry alike). The wrapper lives in the composed
   * Context, so worker-driven calls go through it as well; the summarizer path
   * is separate (`summarizer()`, a P1 concern).
   */
  private stepObservedLlm(llm: Llm, profile: Profile, ledger: UsageLedger | null): Llm {
    if (ledger === null) return llm;
    return createLedgerLlm({
      inner: llm,
      sink: ledger,
      provider: this.opts.providerLabel ?? null,
      model: profile.model,
      base_url_host: hostOf(profile.base_url),
    });
  }

  /**
   * Base profile + the session's own `session.json` overrides (model AND, since
   * W729, the mode-dependent system prompt). This is the ONE place a session's
   * instance profile is decided, so two sessions in the same process can differ
   * in prompt without either one seeing the other's.
   */
  profileFor(sessionId: string | null): Profile {
    const base = this.opts.baseProfile();
    const overrides = this.sessionOverrides(sessionId);
    return overrides === null ? base : { ...base, ...overrides };
  }

  /** The session's profile overrides; `null` when it declares none. */
  private sessionOverrides(sessionId: string | null): Partial<Profile> | null {
    if (sessionId === null) return null;
    const out: Partial<Profile> = {};
    const model = this.opts.sessionModel?.(sessionId) ?? "";
    if (model !== "") out.model = model;
    const prompt = this.opts.sessionSystemPrompt?.(sessionId) ?? "";
    if (prompt !== "") out.system_prompt = prompt;
    return Object.keys(out).length === 0 ? null : out;
  }

  /** The compact summarizer of the CURRENT base profile. */
  summarizer(): Summarizer {
    const profile = this.opts.baseProfile();
    const factory = this.opts.summarize;
    if (factory !== undefined) return factory(profile);
    return llmSummarizer({ llm: this.llmFactory()(profile), model: profile.model });
  }

  /**
   * Worker wiring: ONE registry per session instance (W513, design D7), so a
   * receipt returns to the session that spawned the worker and `worker:<sid>`
   * ids stay unique through the session-derived prefix. W787: the table is
   * PERSISTED by default at `workerRegistryPath()` (`<data dir>/
   * worker-registry.tsv`; `CELESTEA_WORKER_REGISTRY` overrides). Only an
   * explicit `tsvPath: null` is an in-memory table, so the default no
   * longer collides the host with the fleet's shared `/tmp/registry.tsv`.
   */
  private workerWiring(sessionId: string | null, profile: Profile): WorkerWiring | false {
    if (this.opts.workers === false) return false;
    return {
      tsvPath: this.workerRegistryPath(),
      resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"),
      sourceLabel: "celestea.studio-ts",
      logFactory: (): SessionLog => new InMemorySessionLog(),
      hostSessionId: sessionId ?? "cli-main",
      sessionIdPrefix: workerSessionPrefix(sessionId),
      hostModel: profile.model,
      // W729 §2.3: workers inherit the spawning session's mode by default.
      hostMode: sessionId === null ? null : (this.opts.sessionMode?.(sessionId) ?? null),
    };
  }

  /** E §2.3 P0 ①: the configured table path (see `worker-table.ts` for the rules). */
  private workerRegistryPath(): string | null {
    return workerTablePath({
      env: this.opts.env,
      ...(this.opts.dataDir === undefined ? {} : { dataDir: this.opts.dataDir }),
      resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"),
      ...(this.opts.workerRegistryPath === undefined ? {} : { override: this.opts.workerRegistryPath }),
    });
  }

  private llmFactory(): (profile: Profile) => Llm {
    return this.opts.llm ?? ((profile: Profile): Llm => createEngineLlm(profile, this.opts.env));
  }

  private bindingTo(sessionId: string | null, dir: string | null): SessionBinding {
    const target = dir === null || sessionId === null ? null : { sessionId, dir };
    return bindingFor(sessionId, target, this.memoryLogs, {
      ...(this.opts.checkpoint ?? {}),
      onDegraded: (info) => this.noteDegraded(info),
    });
  }

  /**
   * E §1.3 P1 ③: a session log that refused a write is reported to the audit
   * channel (the sidecar already carries the sticky counter, §1.2.2). One line
   * per session instance — the store fires this at most once.
   */
  private noteDegraded(info: { session: string; count: number }): void {
    this.opts.recoveryAudit?.write({
      event: "log_degraded",
      session: info.session,
      count: info.count,
      detail: `session log writeErrorCount=${info.count} (disk and memory diverged)`,
    });
  }
}
