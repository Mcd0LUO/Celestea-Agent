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
  configProblems,
  type FallbackConfig,
  createFallbackLlm,
  FallbackState,
  loadFallbackConfig,
  type FallbackAttemptInfo,
  type FallbackStepSink,
  type LlmTarget,
} from "@celestea/llm";
import type { Llm, Statusline } from "@celestea/core";
import type { StudioBus } from "../sse.js";
import type { Llm as ProviderLlm } from "@celestea/llm";
import type { Profile } from "@celestea/runtime";
import { bridgeProviderLlm, liveEngineLlmFor } from "./llm-assembly.js";
import type { FallbackFrame, FallbackStatusView } from "./fallback-contract.js";

/** `<data dir>/fallbacks-audit.jsonl` (§4.2.3 #3, same discipline as grants). */
export const FALLBACKS_AUDIT_FILE = "fallbacks-audit.jsonl";
/** Rotate at 16 MiB, keeping the previous chain (LTS ops audit rules). */
export const FALLBACKS_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
export const ENV_AUDIT_URL = "CELESTEA_AUDIT_URL";
export const ENV_CENTER_TOKEN = "CELESTEA_CENTER_TOKEN";

/** One audit line: target NAMES and reasons only, never a key or a prompt. */
export interface FallbackAuditEvent {
  ts: number;
  event: "fallback" | "target_unavailable" | "platform_audit_failed";
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
  }) {
    this.wiring = createFallbackWiring({
      dataDir: deps.dataDir ?? (deps.ledgerFile == null ? null : dirname(deps.ledgerFile.path)),
      env: deps.env,
      emit: (sessionId, frame) => this.emit(sessionId, frame),
      ...(deps.now === undefined ? {} : { now: deps.now }),
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

export interface FallbackWiring {
  /** True only when the switch is on AND a chain could be assembled. */
  readonly enabled: boolean;
  /** The decorated seam, or null = "fallback off, use your normal path". */
  wrap(input: FallbackWrapInput): Llm | null;
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
  // OFF (or nothing configured) is the default: no chain, no state, no file.
  if (config === null || !config.enabled) return disabledWiring(config, audit);

  const problems = configProblems(config, env);
  const state = new FallbackState();
  const sessions = new Map<string, { model: string; name: string; reason: string | null }>();
  const now = opts.now ?? Date.now;
  for (const problem of problems) audit.write({ event: "target_unavailable", session: null, detail: problem });
  const deps: WiringDeps = { opts, env, state, sessions, audit, now, problems, config };

  return {
    enabled: true,
    wrap: (input) => armedLlm(deps, input),
    view: (sessionId) => statusView(deps, sessionId),
    flush: () => audit.flush(),
    pendingCount: () => audit.pendingCount(),
  };
}

/** The OFF wiring: `wrap` hands the caller nothing, so the path cannot change. */
function disabledWiring(config: ReturnType<typeof loadFallbackConfig>, audit: FallbackAudit): FallbackWiring {
  if (config !== null && !config.enabled) {
    audit.write({ event: "target_unavailable", session: null, detail: "config declares enabled:false" });
  }
  return {
    enabled: false,
    wrap: () => null,
    view: () => DISABLED_VIEW,
    flush: () => audit.flush(),
    pendingCount: () => audit.pendingCount(),
  };
}

/** Everything one wiring instance needs (kept in one object for the helpers). */
interface WiringDeps {
  opts: FallbackHostOptions;
  env: NodeJS.ProcessEnv;
  state: FallbackState;
  sessions: Map<string, { model: string; name: string; reason: string | null }>;
  audit: FallbackAudit;
  now: () => number;
  problems: string[];
  config: FallbackConfig;
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
    clientFor: (target) =>
      asProviderSeam(deps.opts.clientFor?.(target, input.profile) ?? liveEngineLlmFor(input.profile, target, deps.env)),
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
