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
  type WorkerWiring,
} from "@celestea/runtime";
import { join } from "node:path";
import { CapacityError } from "../runtime-adapter.js";
import { bindingFor, closeLog, workerSessionPrefix, type SessionTarget } from "./engine-session.js";
import { enginePlugins } from "./engine-plugins.js";
import { createEngineLlm } from "./llm-assembly.js";

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
  /** LLM seam factory; default = the assembled engine LLM (live provider). */
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
    const engine = enginePlugins({
      profile,
      llm: this.llmFactory()(profile),
      workers: null, // the workers plugin registers the three tools, in compose order
      ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
      ...(this.opts.sandbox === undefined ? {} : { sandbox: this.opts.sandbox }),
      ...(this.opts.guard === undefined ? {} : { guard: this.opts.guard }),
      env: this.opts.env,
    });
    const usage = createUsageTracker();
    const hooks = this.opts.sessionHooks?.(sessionId) ?? {};
    return compose({
      profile,
      plugins: engine.plugins,
      sessionBinding: this.bindingTo(sessionId, dir),
      usage,
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
      ...(this.opts.now === undefined ? {} : { now: this.opts.now }),
    });
  }

  /** Base profile + the session's own `session.json` model override, if any. */
  profileFor(sessionId: string | null): Profile {
    const base = this.opts.baseProfile();
    const model = sessionId === null ? null : (this.opts.sessionModel?.(sessionId) ?? null);
    return model === null || model === "" ? base : { ...base, model };
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
    };
  }

  private llmFactory(): (profile: Profile) => Llm {
    return this.opts.llm ?? ((profile: Profile): Llm => createEngineLlm(profile, this.opts.env));
  }

  private bindingTo(sessionId: string | null, dir: string | null): SessionBinding {
    const target = dir === null || sessionId === null ? null : { sessionId, dir };
    return bindingFor(sessionId, target, this.memoryLogs);
  }
}
