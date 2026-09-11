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
import { join } from "node:path";
import { CapacityError } from "../runtime-adapter.js";
import { bindingFor, closeLog, workerSessionPrefix, type CheckpointWiring, type SessionTarget } from "./engine-session.js";
import { sessionIdOfDir } from "./engine-grants.js";
import { enginePlugins } from "./engine-plugins.js";
import { EMPTY_GRANTS } from "./engine-grants.js";
import { createEngineLlm } from "./llm-assembly.js";
import type { SessionGrantsReader } from "./session-grants.js";

/** W510 resource caps (overridable through the adapter options or the env). */
export const MAX_LIVE_SESSIONS = 4;
export const MAX_CONCURRENT_TURNS = 2;
export const SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;

/** Per-session injection wiring the host supplies (placement over SSE, W515 §2). */
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
  /** LLM seam factory; default = the assembled engine LLM (live provider). */
  llm?: (profile: Profile) => Llm;
  /** Extra tools registered after the six builtins. */
  tools?: readonly Tool[];
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
  now?: () => number;
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
    const reader = this.opts.grants;
    const read = reader?.read(sessionId, dir) ?? { grants: EMPTY_GRANTS, warnings: [] };
    // W728: the ledger must exist before the Llm wrapper (every step books).
    const ledger = this.usageLedger(sessionId, dir);
    const engine = enginePlugins({
      profile,
      llm: this.stepObservedLlm(this.llmFactory()(profile), profile, ledger),
      workers: null, // the workers plugin registers the three tools, in compose order
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
    return compose({
      profile,
      plugins: engine.plugins,
      sessionBinding: this.bindingTo(sessionId, dir),
      usage,
      ...(ledger === null ? {} : { ledger }),
      inbox: hooks.inbox ?? createSessionInbox(),
      ...(hooks.onInjected === undefined ? {} : { onInjected: hooks.onInjected }),
      loopFactory: (bindings) =>
        new DefaultAgentLoop(bindings.config, {
          signal: bindings.signal,
          sink: bindings.sink,
          usage,
          ...(bindings.injections === undefined ? {} : { injections: bindings.injections }),
        }),
      workers: this.workerWiring(sessionId, profile),
      // W740: the watchdog settings come from the process environment; the
      // composition root reads them and registers the stop hook with the sweep.
      env: this.opts.env,
      ...(this.opts.watchdog === undefined ? {} : { watchdog: this.opts.watchdog }),
      ...(this.opts.now === undefined ? {} : { now: this.opts.now }),
    });
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
   * ids stay unique through the session-derived prefix. The table stays IN
   * MEMORY (`tsvPath: null`): the host never rewrites the shared
   * `/tmp/registry.tsv` of the running fleet.
   */
  private workerWiring(sessionId: string | null, profile: Profile): WorkerWiring | false {
    if (this.opts.workers === false) return false;
    return {
      tsvPath: null,
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

  private llmFactory(): (profile: Profile) => Llm {
    return this.opts.llm ?? ((profile: Profile): Llm => createEngineLlm(profile, this.opts.env));
  }

  private bindingTo(sessionId: string | null, dir: string | null): SessionBinding {
    const target = dir === null || sessionId === null ? null : { sessionId, dir };
    return bindingFor(sessionId, target, this.memoryLogs, this.opts.checkpoint ?? {});
  }
}
