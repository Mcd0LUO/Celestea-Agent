/**
 * Shared helpers for the REAL-engine tests.
 *
 * Every helper builds a throwaway host: a temp data root, one registered
 * workspace, and the app wired to the real adapter through `engineFactory`, so
 * `harness.runtime` IS the engine (`RealRuntimeAdapter`), never a proxy. The
 * engine's tool roots are pinned to the temp workspace, so the production path
 * guard stays mounted and read-only tool calls are allowed inside it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serializeEventLog } from "@celestea/runtime";
import type { SessionEvent } from "@celestea/core";
import { jsonRequest, makeHarness, type StudioHarness } from "../harness.test-util.js";
import { assembleSystemPromptFor } from "../handlers/config-shape.js";
import type { StudioServices } from "../plugins.js";
import { readSessionMeta } from "../store/session-meta.js";
import type { BusFrame, BusSubscription } from "../sse.js";
import { createOfflineLlm, type OfflineLlmOptions } from "./offline-llm.js";
import { createRealRuntimeAdapter, type RealRuntimeAdapter } from "./real-runtime-adapter.js";

export interface EngineHarnessOptions {
  /** Sessions to plant: `name` -> events (written as cli-main.jsonl). */
  sessions?: Record<string, readonly SessionEvent[]>;
  /** Offline LLM options (script / inter-frame delay) for every generation. */
  llm?: OfflineLlmOptions;
  /** `session.json` of the planted sessions (`name` -> its keys, W729). */
  meta?: Record<string, Record<string, string>>;
  /**
   * Environment for the HOST and for the engine this harness builds: the app's
   * config and the real adapter's own knobs (`CELESTEA_WATCHDOG*`, tool roots,
   * resource caps) both read it (W740).
   */
  env?: NodeJS.ProcessEnv;
}

/** One complete turn in the engine's native JSONL shape. */
export function turnEvents(n: number, text = `答 ${n}`): SessionEvent[] {
  const id = `turn-${n}`;
  return [
    { type: "turn_start", id },
    { type: "user_message", text: `问 ${n}` },
    { type: "assistant_message", text },
    { type: "turn_end", id, outcome: "completed" },
  ];
}

/** `count` complete turns, one per number. */
export function turns(count: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < count; i++) out.push(...turnEvents(i));
  return out;
}

/** Plant a session directory with `cli-main.jsonl` (returns its absolute dir). */
export function plantSession(workspace: string, name: string, events: readonly SessionEvent[], meta?: Record<string, string>): string {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli-main.jsonl"), serializeEventLog(events));
  if (meta !== undefined) writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
  return dir;
}

/** A turn is settled once the adapter reports idle again (+ one macrotask). */
export async function waitIdle(h: StudioHarness, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.runtime.isBusy()) {
    if (Date.now() > deadline) throw new Error("turn did not settle in time");
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 2));
}

/** The harness's engine adapter (the real one). */
export function engineOf(h: StudioHarness): RealRuntimeAdapter {
  return h.runtime as RealRuntimeAdapter;
}

/** One observed SSE frame (event name + envelope). */
export interface FrameRecord {
  event: string;
  turn: number;
  seq: number;
  payload: Record<string, unknown>;
}

/** Terminal status phases of a turn (the closing frame the host publishes). */
export const TERMINAL_PHASES: readonly string[] = ["completed", "cancelled", "error", "step_limit", "interrupted"];

function record(frame: BusFrame): FrameRecord {
  return { event: frame.event, turn: frame.envelope.turn, seq: frame.envelope.seq, payload: asPayload(frame.envelope.payload) };
}

/** The SSE payload is `unknown` on the wire; the host always sends an object. */
export function asPayload(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

/** Drain frames until the turn's closing status frame (or fail loudly). */
export async function collectUntilTerminal(sub: BusSubscription, frames: FrameRecord[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`turn frames did not terminate (saw ${frames.map((f) => f.event).join(",")})`);
    const frame = await Promise.race([sub.next(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
    if (frame === null) throw new Error("no frame before the deadline");
    frames.push(record(frame));
    if (frame.event === "status" && TERMINAL_PHASES.includes(String(asPayload(frame.envelope.payload)["phase"]))) return;
  }
}

export interface TurnResult {
  status: number;
  body: Record<string, unknown>;
  turn: number;
  frames: FrameRecord[];
}

/** POST /api/turn while observing every SSE frame it produces. */
export async function runTurnWithFrames(h: StudioHarness, input: string, timeoutMs = 5_000): Promise<TurnResult> {
  const sub = h.studio.services.bus.subscribe();
  const frames: FrameRecord[] = [];
  const res = await h.app.request("/api/turn", jsonRequest("POST", { input }));
  const body = (await res.json()) as Record<string, unknown>;
  const turn = Number(body["turn"] ?? 0);
  if (res.status === 202) await collectUntilTerminal(sub, frames, timeoutMs);
  sub.close();
  await waitIdle(h);
  return { status: res.status, body, turn, frames };
}

/** Activate a session over the HTTP contract (the engine binds it on the turn). */
export async function activate(h: StudioHarness, id: string): Promise<void> {
  const res = await h.app.request(`/api/sessions/${encodeURIComponent(id)}/activate`, jsonRequest("POST"));
  if (res.status !== 200) throw new Error(`activate ${id} failed: ${res.status} ${await res.text()}`);
}

/** The session log file of a workspace session. */
export function readSessionLog(h: StudioHarness, name: string): string {
  return readFileSync(join(h.workspace, name, "cli-main.jsonl"), "utf8");
}

/** Build a host whose engine is the REAL runtime over the offline LLM. */
/** W729/K8: scoped prompt only for a session with an explicit mode (see app.ts). */
function promptForDeclaredMode(host: { services: StudioServices | null }, stores: { sessions: { resolve(id: string): { ok: boolean; value?: { dir: string } } } }, id: string): string | null {
  const resolved = stores.sessions.resolve(id);
  const declared = resolved.ok && resolved.value !== undefined ? readSessionMeta(resolved.value.dir)?.mode !== undefined : false;
  return declared && host.services !== null ? assembleSystemPromptFor(host.services, id) : null;
}

export function makeEngineHarness(opts: EngineHarnessOptions = {}): StudioHarness {
  const resultsDirs: string[] = [];
  // W729: the per-session prompt hook needs the host services, which exist only
  // AFTER composition — the same late-bound ref `app.ts` uses (see HostRef).
  const host: { services: StudioServices | null } = { services: null };
  const h = makeHarness({
    engineFactory: (stores) => {
      const wsPath = stores.workspaces.workspacePath("sample-ws");
      const resultsDir = join(wsPath === undefined ? process.cwd() : dirname(wsPath), "worker-results");
      resultsDirs.push(resultsDir);
      return createRealRuntimeAdapter({
        profile: {
          model: "offline-model",
          base_url: "http://127.0.0.1:9/v1",
          api_key_env: "CELESTEA_API_KEY",
          reasoning_effort: null,
          max_steps: 4096,
          max_parallel_tool_calls: 4,
          max_output_tokens: null,
          context_window: 1_000_000,
          system_prompt: "engine identity prompt",
        },
        // W740: the real adapter reads the watchdog cadence from ITS env, so the
        // harness env has to travel here as well (not only to the app).
        env: { ...process.env, ...(wsPath === undefined ? {} : { CELESTEA_TOOL_ROOTS: wsPath }), ...(opts.env ?? {}) },
        llm: () => createOfflineLlm(opts.llm ?? {}),
        resultsDir,
        resolveSession: (id) => {
          const resolved = stores.sessions.require(id);
          return resolved.ok ? { sessionId: id, dir: resolved.value.dir } : null;
        },
        // W513/W729: the session-level model AND mode-dependent prompt are
        // applied to that session's own instance (mirrors `app.ts`).
        sessionModel: (id) => {
          const resolved = stores.sessions.resolve(id);
          return resolved.ok ? (readSessionMeta(resolved.value.dir)?.model ?? null) : null;
        },
        sessionMode: (id) => {
          const resolved = stores.sessions.resolve(id);
          return resolved.ok ? (readSessionMeta(resolved.value.dir)?.mode ?? null) : null;
        },
        // K8 gate: only a session that DECLARED a mode gets its own assembly.
        sessionSystemPrompt: (id) => promptForDeclaredMode(host, stores, id),
      });
    },
  });
  host.services = h.studio.services;
  const cleanup = h.cleanup;
  h.cleanup = (): void => {
    cleanup();
    for (const dir of resultsDirs) rmSync(dir, { recursive: true, force: true });
  };
  for (const [name, events] of Object.entries(opts.sessions ?? {})) plantSession(h.workspace, name, events, opts.meta?.[name]);
  return h;
}
