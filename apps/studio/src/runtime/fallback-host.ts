/**
 * Fallback wiring of the studio host (iteration E §4.2.3, P1) — the visibility
 * half of the `Llm` decorator.
 *
 * `packages/llm` owns the RULES (trigger table, produced lock, cooldown); this
 * module owns everything the rules cannot know: which targets exist in THIS
 * deployment (sidecar config + the composed profile), their credentials (env var
 * NAMES only, U7 inventory), and the three places a hand-over must be visible
 * (§4.2.3, "三者缺一视为未实现"):
 *
 *   1. local append-only `fallbacks-audit.jsonl` (authoritative) + best-effort
 *      platform `POST /api/audit` when `CELESTEA_AUDIT_URL` is set;
 *   2. one SSE `status` frame with `phase:"fallback"` — the event NAME is frozen
 *      (K5), only payload fields are added;
 *   3. the `/api/status` view (`effective_model` + `fallback.{active,chain,
 *      last_reason,targets,problems}`), with `model` keeping its old meaning.
 *
 * The switch is OFF by default: when `CELESTEA_LLM_FALLBACK` is not on, `wrap()`
 * returns null and the caller keeps the pre-P1 path byte-for-byte (D9). Nothing
 * here reads a credential VALUE, and no target's key ever leaves its env var.
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clampRetries,
  configProblems,
  type FallbackConfig,
  createFallbackLlm,
  createRetryLlm,
  DEFAULT_RETRY_POLICY,
  FallbackState,
  loadFallbackConfig,
  type FallbackAttemptInfo,
  type FallbackStepSink,
  type LlmTarget,
  type RetryAttemptInfo,
} from "@celestea/llm";
import type { Llm, Statusline } from "@celestea/core";
import type { StudioBus } from "../sse.js";
import type { Llm as ProviderLlm } from "@celestea/llm";
import type { Profile } from "@celestea/runtime";
import { bridgeProviderLlm, liveEngineLlmFor } from "./llm-assembly.js";
import type { FallbackFrame, FallbackStatusView } from "./fallback-contract.js";

/**
 * F-06: the target name a chain-OFF retry reports. There is no configured
 * target to name, so the audit line / status frame says the honest thing: the
 * composed profile's own endpoint. `from === to` is still the discriminator
 * that says "retry, not hand-over".
 */
export const RETRY_ONLY_TARGET = "profile";

/** `<data dir>/fallbacks-audit.jsonl` (§4.2.3 #3, same discipline as grants). */
export const FALLBACKS_AUDIT_FILE = "fallbacks-audit.jsonl";
/** Rotate at 16 MiB, keeping the previous chain (LTS ops audit rules). */
export const FALLBACKS_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
export const ENV_AUDIT_URL = "CELESTEA_AUDIT_URL";
export const ENV_CENTER_TOKEN = "CELESTEA_CENTER_TOKEN";

/** One audit line: target NAMES and reasons only, never a key or a prompt. */
export interface FallbackAuditEvent {
  ts: number;
  /**
   * W9104 adds `retry` (one line per SAME-TARGET re-issue). The vocabulary is
   * additive: an existing reader that only knows the three older values ignores
   * the new line, and the file's shape (target NAMES + reasons, never a key or a
   * prompt) is unchanged.
   */
  event: "fallback" | "retry" | "target_unavailable" | "platform_audit_failed";
  session: string | null;
  /** The five hand-over fields exist on `fallback` lines; they are absent on
   * operational lines (`target_unavailable`, `platform_audit_failed`). */
  from?: string | null;
  to?: string | null;
  reason?: string | null;
  attempt?: number | null;
  model?: string | null;
  detail?: string;
}

// The two shapes the HTTP layer names live in a LEAF module (see its header):
// importing them from here would close a `no-circular` loop through llm-assembly.
export type { FallbackFrame, FallbackStatusView } from "./fallback-contract.js";

export interface FallbackWrapInput {
  /** The composed engine seam (used verbatim while the capability is off). */
  inner: Llm;
  profile: Profile;
  sessionId: string | null;
  /** Per-attempt ledger booking (the ledger makes N attempts visible, D6). */
  steps: FallbackStepSink | null;
  /** `providers.json` row id for the ledger's `provider` column. */
  provider: string | null;
}

/**
 * The `status` payload of one hand-over (§4.2.3 #2). The event NAME is frozen
 * (K5); these five keys are the ones declared in
 * `contracts/sse-events.json#payloadExtensions.status`, and they live HERE so the
 * emitted key set and the contract declaration cannot drift apart.
 */
export function fallbackFramePayload(frame: FallbackFrame, statusline: unknown): Record<string, unknown> {
  return {
    phase: frame.phase,
    statusline,
    effective_model: frame.effective_model,
    from: frame.from,
    to: frame.to,
    reason: frame.reason,
    attempt: frame.attempt,
  };
}

/** `/api/status.fallback` of one session (null = the capability is off). */
export function fallbackViewOf(wiring: FallbackWiring, sessionId: string | null): FallbackStatusView | null {
  return wiring.enabled ? wiring.view(sessionId) : null;
}

/**
 * The adapter-facing glue of the capability: the process-wide wiring plus the two
 * host effects a hand-over has (the SSE frame and the `/api/status` view). It
 * lives here, not in `real-runtime-adapter.ts`, for the same reason
 * `ledger-view.ts` does — the adapter stays a thin seam inside the §4.1 budget.
 */
export class AdapterFallback {
  /** Handed to `SessionComposer`; `wrap()` answers null while the switch is off. */
  readonly wiring: FallbackWiring;

  constructor(private readonly deps: {
    dataDir?: string | null;
    /** Falls back to the ledger's own directory: both files are process-level. */
    ledgerFile?: { path: string } | null;
    env: NodeJS.ProcessEnv;
    now?: () => number;
    bus: () => StudioBus | null;
    peek: (sessionId: string | null) => { turnNo: number; runtime: { statusline(): Statusline } } | null;
    /** W9104: the live `POST /api/config.max_retries` (see FallbackHostOptions). */
    maxRetries?: () => number;
  }) {
    this.wiring = createFallbackWiring({
      dataDir: deps.dataDir ?? (deps.ledgerFile == null ? null : dirname(deps.ledgerFile.path)),
      env: deps.env,
      emit: (sessionId, frame) => this.emit(sessionId, frame),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    });
  }

  /** `/api/status.fallback` of one session (null = the capability is off). */
  view(sessionId: string | null): FallbackStatusView | null {
    return fallbackViewOf(this.wiring, sessionId);
  }

  /** One `status` frame per hand-over (frozen event name, declared payload). */
  emit(sessionId: string | null, frame: FallbackFrame): void {
    const entry = this.deps.peek(sessionId);
    this.deps.bus()?.emit("status", entry?.turnNo ?? 0, fallbackFramePayload(frame, entry?.runtime.statusline() ?? {}), sessionId);
  }

  /** Await in-flight platform deliveries (tests / shutdown). */
  flush(): Promise<void> {
    return this.wiring.flush();
  }

  /** In-flight platform deliveries (diagnostics; bounded by construction). */
  pendingCount(): number {
    return this.wiring.pendingCount();
  }
}

/**
 * The identity a retry reports on its audit line / status frame. `name` is the
 * chain target when one exists, else [RETRY_ONLY_TARGET].
 */
export interface RetryIdentity {
  name: string;
  model: string;
}

export interface FallbackWiring {
  /** True only when the switch is on AND a chain could be assembled. */
  readonly enabled: boolean;
  /** The decorated seam, or null = "fallback off, use your normal path". */
  wrap(input: FallbackWrapInput): Llm | null;
  /**
   * F-06: the SAME-TARGET retry as a standalone decorator, for a deployment with
   * no fallback chain. The chain and the retry are different capabilities, so the
   * retry must not be reachable only through `wrap` — that is what made
   * `POST /api/config.max_retries` a dead knob on the default deployment.
   *
   * It is deliberately a SEPARATE entry point rather than "wrap never returns
   * null": the caller composes the ledger and the attachment layers around
   * whatever `wrap` returns, so changing `wrap` would bypass them. Here the
   * caller keeps its own chain and only the innermost client is wrapped.
   *
   * Armed wiring returns `inner` unchanged (its per-target retry already covers
   * this); the chain-off wiring applies the budget.
   */
  retryOnly(inner: Llm, identity: RetryIdentity, sessionId: string | null): Llm;
  /** The `/api/status` half for one session. */
  view(sessionId: string | null): FallbackStatusView;
  /** Await in-flight platform deliveries (tests / shutdown). */
  flush(): Promise<void>;
  /** In-flight platform deliveries (bounded: a delivered event leaves). */
  pendingCount(): number;
}

export interface FallbackHostOptions {
  /** `<data dir>`: `fallbacks.json` and `fallbacks-audit.jsonl` live here. */
  dataDir?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Bus sink: one `status` frame per hand-over. */
  emit?: (sessionId: string | null, frame: FallbackFrame) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable per-target client builder (tests): the production default builds
   * a live provider client from the composed profile (`liveEngineLlmFor`), and a
   * test can hand in a scripted seam without touching the network.
   */
  clientFor?: (target: LlmTarget, profile: Profile) => Llm;
  /** Injectable platform transport (tests); default `fetch`. */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number }>;
  /**
   * W9104: the LIVE same-target retry budget (0..3), read at every `wrap()` so
   * a `POST /api/config.max_retries` change applies to the NEXT composed
   * generation without rebuilding this wiring. Absent = the decorator default.
   */
  maxRetries?: () => number;
}

/** What `/api/status` reports while the capability is off (never null there). */
const DISABLED_VIEW: FallbackStatusView = {
  active: false,
  chain: [],
  effective_model: null,
  last_reason: null,
  targets: [],
  problems: [],
};

export function createFallbackWiring(opts: FallbackHostOptions = {}): FallbackWiring {
  const env = opts.env ?? process.env;
  const config = loadFallbackConfig({ dataDir: opts.dataDir ?? null, env });
  const audit = new FallbackAudit(opts);
  // The FALLBACK CHAIN is off by default; the same-target RETRY is not (F-06).
  // The two are different capabilities: fallback needs a second target and a
  // credential inventory, retry needs nothing but the endpoint already in use.
  // [disabledWiring] therefore still builds the retry decorator around the one
  // composed client, and reports `enabled: false` (that flag means "is a chain
  // armed", which is what /api/status.fallback and the audit depend on).
  if (config === null || !config.enabled) return disabledWiring({ opts, env, audit, sessions: new Map() }, config);

  const problems = configProblems(config, env);
  const state = new FallbackState();
  const sessions = new Map<string, { model: string; name: string; reason: string | null }>();
  const now = opts.now ?? Date.now;
  for (const problem of problems) audit.write({ event: "target_unavailable", session: null, detail: problem });
  const deps: WiringDeps = { opts, env, state, sessions, audit, now, problems, config };

  return {
    enabled: true,
    wrap: (input) => armedLlm(deps, input),
    // The armed chain already puts a retry decorator in front of EVERY target
    // (see [retryingClient]), so the standalone path must stay inert here —
    // otherwise a caller that used both entries would retry twice.
    retryOnly: (inner) => inner,
    view: (sessionId) => statusView(deps, sessionId),
    flush: () => audit.flush(),
    pendingCount: () => audit.pendingCount(),
  };
}

/**
 * The CHAIN-OFF wiring. `enabled: false` means "no fallback chain is armed" and
 * `wrap` still returns null (the caller keeps its own path) — but [retryOnly]
 * is live, so the same-target retry budget (`POST /api/config.max_retries`) is
 * honoured on a default deployment.
 */
function disabledWiring(deps: RetryDeps, config: FallbackConfig | null): FallbackWiring {
  const { audit } = deps;
  if (config !== null && !config.enabled) {
    audit.write({ event: "target_unavailable", session: null, detail: "config declares enabled:false" });
  }
  return {
    enabled: false,
    wrap: () => null,
    retryOnly: (inner, identity, sessionId) => retryOnly(deps, inner, identity, sessionId),
    view: () => DISABLED_VIEW,
    flush: () => audit.flush(),
    pendingCount: () => audit.pendingCount(),
  };
}

/**
 * What the RETRY half needs. It deliberately carries NO chain: the same-target
 * retry is independent of fallback (F-06), so a helper that only retries must
 * not be able to reach the configured targets even by accident.
 */
interface RetryDeps {
  opts: FallbackHostOptions;
  env: NodeJS.ProcessEnv;
  audit: FallbackAudit;
  /**
   * `session -> what is really serving it`, shared with the chain half.
   * A retry records itself here too (with `from === to`), so the two halves
   * cannot disagree about the effective model after a retry.
   */
  sessions: Map<string, { model: string; name: string; reason: string | null }>;
}

/**
 * What the CHAIN half additionally needs. `config` is NON-null here: these
 * helpers only exist behind `enabled: true`, so "the chain is configured" is
 * a fact of the type rather than a runtime check repeated at every call site.
 */
interface WiringDeps extends RetryDeps {
  state: FallbackState;
  now: () => number;
  problems: string[];
  config: FallbackConfig;
}

/**
 * W9104: ONE target's client, with same-target retry IN FRONT of the chain's
 * hand-over. This is the ordering the design fixes — a transient 503/429/timeout
 * is re-issued against the SAME endpoint (the user's configured model keeps
 * serving) and only an endpoint that fails `maxRetries + 1` times in a row is
 * left behind for the next target. Every retry is visible on both channels the
 * hand-over uses (audit line + SSE `status` frame), so a retry is never silent.
 */
function retryingClient(deps: WiringDeps, input: FallbackWrapInput, target: LlmTarget): ProviderLlm {
  const client = asProviderSeam(deps.opts.clientFor?.(target, input.profile) ?? liveEngineLlmFor(input.profile, target, deps.env));
  return withSameTargetRetry(deps, input, client, { name: target.name, model: target.model });
}


/**
 * The ONE place the retry decorator is built, shared by the chain-armed path
 * (per target, inside [retryingClient]) and the chain-OFF path ([retryOnly]).
 * Keeping it in one function is what stops the two paths from drifting on the
 * budget, the report channel or the identity.
 *
 * `maxRetries <= 0` returns the client UNWRAPPED: "retry off" must mean the
 * pre-W9104 byte-for-byte path (no extra closure, no report), which is also
 * what makes the "0 = no extra call" assertion meaningful.
 */
function withSameTargetRetry(
  deps: RetryDeps,
  input: { sessionId: string | null },
  client: ProviderLlm,
  identity: RetryIdentity,
): ProviderLlm {
  const maxRetries = clampRetries(deps.opts.maxRetries?.() ?? DEFAULT_RETRY_POLICY.maxRetries);
  if (maxRetries <= 0) return client;
  return createRetryLlm({
    inner: client,
    target: identity.name,
    model: identity.model,
    policy: { maxRetries },
    ...(deps.opts.sleep === undefined ? {} : { sleep: deps.opts.sleep }),
    onRetry: (info) => reportRetry(deps, input.sessionId, info),
  });
}

/**
 * F-06: the standalone same-target retry (no fallback chain).
 *
 * Why retry must not be hostage to the fallback switch: the two capabilities
 * answer different questions. Fallback needs a second target, a credential
 * inventory and a cooldown table; retry needs only the endpoint the session is
 * ALREADY using. Before this function existed the decorator was reachable
 * exclusively through `createFallbackLlm({ clientFor })`, so on a default
 * deployment (`CELESTEA_LLM_FALLBACK` unset) `POST /api/config.max_retries` was
 * accepted, echoed and even covered by the config contract while NO request was
 * ever retried — a dead knob.
 *
 * `inner` is whatever the caller already composed (the raw client, or the
 * ledger/attachment chain around it), and it comes back UNCHANGED when the
 * budget is 0, so "retry off" stays the pre-W9104 path byte for byte.
 */
function retryOnly(deps: RetryDeps, inner: Llm, identity: RetryIdentity, sessionId: string | null): Llm {
  const client = asProviderSeam(inner);
  const retrying = withSameTargetRetry(deps, { sessionId }, client, identity);
  if (retrying === client) return inner;
  return bridgeProviderLlm(retrying);
}

/**
 * W9104 §3: one retry reaches the audit channel AND the bus, never just one.
 *
 * The SSE half reuses the ALREADY-DECLARED `phase:"fallback"` payload with
 * `from === to` — the contract freezes both keys as strings and `contracts/**`
 * is off-limits for this cut, so "same target, attempt N+1" is expressed with
 * the vocabulary the frozen frame already has instead of a new key. The
 * discriminating fact ("this was a retry, not a hand-over") is `from === to`,
 * and the audit line below spells it out with `event:"retry"`.
 */
function reportRetry(deps: RetryDeps, sessionId: string | null, info: RetryAttemptInfo): void {
  if (info.target !== null) {
    deps.sessions.set(sessionKey(sessionId), { model: info.model ?? "", name: info.target, reason: info.reason });
    deps.opts.emit?.(sessionId, {
      phase: "fallback",
      from: info.target,
      to: info.target,
      reason: info.reason,
      attempt: info.attempt,
      effective_model: info.model ?? "",
    });
  }
  deps.audit.write({
    event: "retry",
    session: sessionId,
    from: info.target,
    to: info.target,
    reason: info.reason,
    attempt: info.attempt,
    model: info.model,
    detail: `retry after ${info.delayMs}ms (http_status=${info.httpStatus ?? "-"})`,
  });
}

/** The chain: the configured targets, or the composed profile as its own target. */
function chainOf(deps: WiringDeps, profile: Profile): LlmTarget[] {
  const configured = deps.config.targets;
  if (configured.length > 0) return configured;
  return [
    {
      name: "primary",
      provider: "profile",
      model: profile.model,
      baseUrl: profile.base_url,
      apiKeyEnv: profile.api_key_env,
    },
  ];
}

function armedLlm(deps: WiringDeps, input: FallbackWrapInput): Llm {
  const targets = chainOf(deps, input.profile);
  // The decorator lives on the PROVIDER seam (it must see a provider's
  // `failed{kindOf:"timeout"}`); the engine consumes core's seam. The input
  // clients are already core-shaped (only the documented `kindOf` widening is
  // lost, and `liveEngineLlmFor` never produces "timeout" — it reports a torn
  // stream instead), so the cast is a type-level bridge only; the OUTPUT is
  // bridged for real by [bridgeProviderLlm].
  const decorated: ProviderLlm = createFallbackLlm({
    targets,
    state: deps.state,
    policy: deps.config.policy,
    clientFor: (target) => retryingClient(deps, input, target),
    steps: input.steps,
    ...(deps.opts.now === undefined ? {} : { now: deps.opts.now }),
    ...(deps.opts.sleep === undefined ? {} : { sleep: deps.opts.sleep }),
    onAttempt: (info) => report(deps, input.sessionId, info),
  });
  return bridgeProviderLlm(decorated);
}

/** Type-level only (see [armedLlm]): the two seams differ in one union member. */
function asProviderSeam(llm: Llm): ProviderLlm {
  return llm as unknown as ProviderLlm;
}

/** §4.2.3: one hand-over reaches the bus AND the audit channel, never just one. */
function report(deps: WiringDeps, sessionId: string | null, info: FallbackAttemptInfo): void {
  deps.sessions.set(sessionKey(sessionId), { model: info.model, name: info.target, reason: info.reason });
  deps.opts.emit?.(sessionId, {
    phase: "fallback",
    from: info.from,
    to: info.target,
    reason: info.reason,
    attempt: info.attempt,
    effective_model: info.model,
  });
  deps.audit.write({
    event: "fallback",
    session: sessionId,
    from: info.from,
    to: info.target,
    reason: info.reason,
    attempt: info.attempt,
    model: info.model,
  });
}

/** `/api/status.fallback`: the chain, what is really serving, and what is wrong. */
function statusView(deps: WiringDeps, sessionId: string | null): FallbackStatusView {
  const known = deps.sessions.get(sessionKey(sessionId));
  const now = deps.now();
  return {
    active: true,
    chain: deps.config.targets.map((t) => t.name),
    effective_model: known?.model ?? null,
    last_reason: known?.reason ?? null,
    targets: deps.config.targets.map((t) => {
      const envName = t.apiKeyEnv ?? null;
      return {
        name: t.name,
        model: t.model,
        available: envName === null || (deps.env[envName] ?? "") !== "",
        cooling: deps.state.isCooling(t.name, now),
      };
    }),
    problems: deps.problems,
  };
}

function sessionKey(sessionId: string | null): string {
  return sessionId ?? "(default)";
}

/** Local append-only channel (authoritative) + best-effort platform delivery. */
class FallbackAudit {
  private readonly path: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly post: NonNullable<FallbackHostOptions["post"]>;
  private pending: Promise<void>[] = [];

  constructor(opts: FallbackHostOptions) {
    this.path = opts.dataDir === null || opts.dataDir === undefined ? null : join(opts.dataDir, FALLBACKS_AUDIT_FILE);
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.post = opts.post ?? httpPost;
  }

  write(event: Omit<FallbackAuditEvent, "ts"> & { ts?: number }): void {
    const line: FallbackAuditEvent = { ts: event.ts ?? Math.floor(this.now() / 1000), ...event };
    if (this.path !== null) appendRotating(this.path, line);
    // W833 (R3 B8 / W816 F4): a delivered line LEAVES the ledger, so the array
    // is bounded by the number of in-flight deliveries — it used to grow with
    // every event the process ever produced.
    const task = this.deliver(line);
    this.pending.push(task);
    void task
      .finally(() => {
        const at = this.pending.indexOf(task);
        if (at >= 0) this.pending.splice(at, 1);
      })
      .catch(() => undefined);
  }

  /** In-flight platform deliveries (diagnostics / bound assertion). */
  pendingCount(): number {
    return this.pending.length;
  }

  async flush(): Promise<void> {
    // Await everything in flight; completed deliveries have already removed
    // themselves, and nothing new is written during shutdown.
    while (this.pending.length > 0) await Promise.all([...this.pending]);
  }

  /** Unset `CELESTEA_AUDIT_URL` = local channel only; a failed one is recorded. */
  private async deliver(line: FallbackAuditEvent): Promise<void> {
    const url = this.env[ENV_AUDIT_URL];
    if (url === undefined || url.trim() === "") return;
    const token = this.env[ENV_CENTER_TOKEN];
    const body = JSON.stringify({
      category: "audit",
      summary: `llm fallback ${line.from ?? "-"} -> ${line.to ?? "-"} (${line.reason ?? "-"})`,
      detail: JSON.stringify(line).slice(0, 8192),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined && token !== "") headers["x-center-token"] = token;
    try {
      const res = await this.post(url, body, headers);
      if (!res.ok && this.path !== null) appendRotating(this.path, { ...line, ts: line.ts, event: "platform_audit_failed", detail: `http ${res.status}` });
    } catch (e) {
      if (this.path !== null) {
        appendRotating(this.path, { ...line, ts: line.ts, event: "platform_audit_failed", detail: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

/** Append one line, rotating at 16 MiB; a failure is reported, never thrown. */
function appendRotating(path: string, line: FallbackAuditEvent): void {
  try {
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size >= FALLBACKS_AUDIT_MAX_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`fallbacks audit: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function httpPost(url: string, body: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status };
}
