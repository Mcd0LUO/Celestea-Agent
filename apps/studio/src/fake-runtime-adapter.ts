/**
 * Fake `RuntimeAdapter` — the P4 stand-in for the engine.
 *
 * The real runtime arrives on another workstream; until it does, this adapter
 * lets the whole HTTP contract be exercised end to end: it owns the
 * single-concurrency slot, emits the contract SSE events on a scripted turn,
 * and answers the worker/compact/status calls deterministically.
 *
 * It is a *test/development* adapter, never a production engine: the scripted
 * turn is an echo and no model is ever called.
 */

import type { SseEventName, Statusline } from "@celestea/core";
import {
  TurnBusyError,
  type ClearOutcome,
  type CompactOutcome,
  type EngineProfile,
  type ProfilePatch,
  type RuntimeAdapter,
  type ToolInfo,
  type TurnRequest,
  type TurnStart,
  type WorkerSpawnOutcome,
  type WorkerSpawnRequest,
  type WorkerSendRequest,
  type WorkerSessionRow,
  type WorkerStatusReport,
} from "./runtime-adapter.js";
import type { StudioBus } from "./sse.js";

export interface FakeRuntimeOptions {
  profile?: Partial<EngineProfile>;
  tools?: readonly ToolInfo[];
  /** Yield between scripted frames so a test can observe the stream. */
  stepDelayMs?: number;
}

/** `RuntimeAdapter` plus the test hook that waits for a scripted turn to end. */
export interface FakeRuntimeAdapter extends RuntimeAdapter {
  whenIdle(): Promise<void>;
}

const DEFAULT_TOOLS: readonly ToolInfo[] = [
  { name: "http_request", description: "Send an HTTP(S) request and return {status, headers(subset), body, truncated}." },
  { name: "list_dir", description: "List the entry names in a directory." },
  { name: "read_file", description: "Read a UTF-8 text file and return its contents as a string." },
  { name: "write_file", description: "Write a UTF-8 text file." },
  { name: "run_shell", description: "Run a shell command." },
];

interface FakeWorker {
  wid: string;
  sessionId: string;
  title: string;
  status: "RUNNING" | "DONE" | "FAILED";
  state: string;
  brief: string;
}

function zeroUsage(): Statusline["usage"] {
  const block = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read: 0, cache_hit_ratio: 0, reasoning_tokens: 0 };
  return { ...block, total: { ...block } };
}

function defaultProfile(over: Partial<EngineProfile>): EngineProfile {
  return {
    model: "unknown",
    base_url: "http://127.0.0.1:3001/v1",
    reasoning_effort: null,
    max_steps: 4096,
    max_parallel_tool_calls: 4,
    max_output_tokens: null,
    context_window: 1_000_000,
    api_key_env: "CELESTEA_API_KEY",
    system_prompt: "",
    ...over,
  };
}

function countBy(rows: readonly FakeWorker[], key: "status" | "state"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of rows) out[w[key]] = (out[w[key]] ?? 0) + 1;
  return out;
}

class FakeRuntime implements FakeRuntimeAdapter {
  readonly name = "fake-runtime-adapter";
  private engineProfile: EngineProfile;
  private readonly toolList: readonly ToolInfo[];
  private readonly workers = new Map<string, FakeWorker>();
  private readonly transcripts = new Map<string, unknown[]>();
  private readonly delay: number;
  private bus: StudioBus | null = null;
  private busy = false;
  private turn = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(opts: FakeRuntimeOptions) {
    this.engineProfile = defaultProfile(opts.profile ?? {});
    this.toolList = opts.tools ?? DEFAULT_TOOLS;
    this.delay = opts.stepDelayMs ?? 0;
  }

  attach(next: StudioBus): void {
    this.bus = next;
  }

  isBusy(): boolean {
    return this.busy;
  }

  profile(): EngineProfile {
    return this.engineProfile;
  }

  async configure(patch: ProfilePatch): Promise<EngineProfile> {
    this.engineProfile = { ...this.engineProfile, ...patch };
    return this.engineProfile;
  }

  tools(): ToolInfo[] {
    return [...this.toolList];
  }

  statusline(): Statusline {
    return {
      model: this.engineProfile.model,
      reasoning_effort: this.engineProfile.reasoning_effort,
      steps: 0,
      tokens_per_sec: 0,
      context_usage: { used: 0, window: this.engineProfile.context_window, ratio: 0, estimated: true, method: "session_event_chars" },
      usage: zeroUsage(),
    };
  }

  private emit(event: SseEventName, payload: Record<string, unknown>, envelopeTurn = this.turn): void {
    this.bus?.emit(event, envelopeTurn, payload);
  }

  private settle(): void {
    this.busy = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  whenIdle(): Promise<void> {
    return this.busy ? new Promise<void>((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  private async pause(): Promise<void> {
    if (this.delay > 0) await new Promise<void>((r) => setTimeout(r, this.delay));
  }

  /** Scripted turn: start -> text -> done -> turn_end -> completed. */
  private async runTurn(req: TurnRequest): Promise<void> {
    try {
      this.emit("text", { delta: `echo: ${req.input}` });
      await this.pause();
      this.emit("done", { text: `echo: ${req.input}`, tool_calls: [] });
      this.emit("turn_end", { outcome: "completed", error: null });
      this.emit("status", { phase: "completed", statusline: this.statusline() });
    } finally {
      this.settle();
    }
  }

  async startTurn(req: TurnRequest): Promise<TurnStart> {
    if (this.busy) throw new TurnBusyError();
    this.busy = true;
    this.turn += 1;
    this.emit("status", { phase: "start", statusline: this.statusline() }, this.turn);
    setTimeout(() => void this.runTurn(req), 0);
    return { turn: this.turn };
  }

  cancel(): boolean {
    if (!this.busy) return false;
    this.settle();
    this.emit("status", { phase: "cancelled", statusline: this.statusline() });
    return true;
  }

  async clear(_session: string | null): Promise<ClearOutcome> {
    return { cleared: true };
  }

  async compact(session: string): Promise<CompactOutcome> {
    return { compacted: false, note: "历史不足，无需压缩", session, rebound: false };
  }

  private workerRows(): WorkerSessionRow[] {
    return [...this.workers.values()].map((w) => ({
      id: `worker:${w.sessionId}`,
      workspace: "engine",
      kind: "worker" as const,
      title: w.title,
      model: null,
      size: this.transcripts.get(w.sessionId)?.length ?? 0,
      modified: 0,
      active: false,
    }));
  }

  workerSessions(): WorkerSessionRow[] {
    return this.workerRows();
  }

  async workerSpawn(req: WorkerSpawnRequest): Promise<WorkerSpawnOutcome> {
    const sessionId = `session-${this.workers.size + 1}`;
    const title = req.title !== undefined && req.title !== "" ? req.title : req.brief.slice(0, 40);
    this.workers.set(req.wid, { wid: req.wid, sessionId, title, status: "RUNNING", state: "idle", brief: req.brief });
    this.transcripts.set(sessionId, [{ role: "user", content: req.brief }]);
    return { ok: true, sessionId, title, wid: req.wid };
  }

  async workerSend(req: WorkerSendRequest): Promise<Record<string, unknown>> {
    const hit = [...this.workers.values()].find((w) => w.sessionId === req.target || w.wid === req.target);
    if (hit === undefined) return { ok: false, delivered: false, error: `unknown worker target '${req.target}'` };
    const log = this.transcripts.get(hit.sessionId) ?? [];
    log.push({ role: "user", content: req.content });
    this.transcripts.set(hit.sessionId, log);
    return { ok: true, delivered: true, target: req.target, wid: hit.wid };
  }

  workerStatus(wid?: string): WorkerStatusReport {
    const all = [...this.workers.values()];
    const by_status = { DONE: 0, FAILED: 0, RUNNING: 0, ...countBy(all, "status") };
    const by_state = { idle: 0, "in-turn": 0, running: 0, ...countBy(all, "state") };
    if (wid === undefined) return { ok: all.length > 0, total: all.length, by_status, by_state, workers: all };
    const hit = all.filter((w) => w.wid === wid);
    if (hit.length === 0) return { ok: false, total: 0, by_status, by_state, workers: [], wid, error: `no worker ${wid} in registry` };
    return { ok: true, total: hit.length, by_status, by_state, workers: hit, wid };
  }

  workerMessages(sessionId: string): unknown[] | null {
    const sid = sessionId.startsWith("worker:") ? sessionId.slice("worker:".length) : sessionId;
    return this.transcripts.get(sid) ?? null;
  }
}

export function createFakeRuntimeAdapter(opts: FakeRuntimeOptions = {}): FakeRuntimeAdapter {
  return new FakeRuntime(opts);
}
