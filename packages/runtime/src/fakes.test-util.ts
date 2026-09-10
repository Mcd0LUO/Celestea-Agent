/**
 * Test doubles for the P3 runtime tests.
 *
 * The runtime composes seams, so its tests need seams and nothing else: a
 * memory `SessionLog`, a scripted `AgentLoop`, a recording `ToolRegistry` and a
 * queue-backed `Llm`. None of them imports a sibling implementation package, so
 * these tests stay green while `packages/agent-loop` / `packages/tools` are
 * being written in parallel.
 */

import {
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  assistantText,
  definePlugin,
  usageAdd,
  userMessage,
  zeroUsage,
  type AgentConfig,
  type AgentLoop,
  type Context,
  type Llm,
  type LlmStream,
  type Message,
  type ModelRequest,
  type Plugin,
  type SessionEvent,
  type SessionLog,
  type StreamEvent,
  type Tool,
  type ToolGuard,
  type ToolInput,
  type ToolOutput,
  type ToolSpec,
  type TurnOutcome,
  type Usage,
} from "@celestea/core";
import { UsageTracker, type UsageAccounting, type UsageRecorder } from "./usage.js";
import type { LoopBindings, LoopFactory } from "./turn-runner.js";
import type { Profile } from "./profile.js";

// --- session log ----------------------------------------------------------

/** Minimal in-memory SessionLog with a real (if simple) message projection. */
export function memoryLog(): SessionLog {
  const events: SessionEvent[] = [];
  let turns = 0;
  return {
    append(event: SessionEvent): void {
      events.push(event);
    },
    events(): SessionEvent[] {
      return [...events];
    },
    deriveMessages(): Message[] {
      const out: Message[] = [];
      for (const ev of events) {
        if (ev.type === "user_message") out.push(userMessage(ev.text));
        else if (ev.type === "assistant_message") out.push(assistantText(ev.text));
      }
      return out;
    },
    clear(): void {
      events.length = 0;
    },
    nextTurnId(): string {
      const id = `turn-${turns}`;
      turns += 1;
      return id;
    },
  };
}

/** Provide an in-memory session log (mount over any other session plugin). */
export function memorySessionPlugin(log: SessionLog = memoryLog(), name = "test.session"): Plugin {
  return definePlugin(name, (ctx) => ctx.provide(SESSION_LOG_SERVICE, log));
}

// --- tool registry --------------------------------------------------------

export interface RecordingRegistry {
  registry: FakeToolRegistry;
  registered: string[];
  dispatched: string[];
}

export class FakeToolRegistry {
  readonly tools = new Map<string, Tool>();
  readonly guards: ToolGuard[] = [];
  readonly order: string[] = [];

  register(tool: Tool): void {
    const name = tool.spec().name;
    this.tools.set(name, tool);
    this.order.push(name);
  }

  addGuard(guard: ToolGuard): void {
    this.guards.push(guard);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemas(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec()).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async dispatch(input: ToolInput): Promise<ToolOutput> {
    const tool = this.tools.get(input.name);
    if (tool === undefined) {
      return { call_id: input.call_id, value: null, render: null, error: "no such tool", decision: null };
    }
    const value = await tool.execute(input.args);
    return { call_id: input.call_id, value, render: null, error: null, decision: { kind: "allow" } };
  }
}

/** A tool registry plugin + the recording handles its assertions need. */
export function recordingRegistryPlugin(name = "test.tools"): RecordingRegistry & { plugin: Plugin } {
  const registry = new FakeToolRegistry();
  return {
    registry,
    registered: registry.order,
    dispatched: [],
    plugin: definePlugin(name, (ctx) => ctx.provide(TOOL_REGISTRY_SERVICE, registry)),
  };
}

// --- llm ------------------------------------------------------------------

/** A single `Llm` that always streams the same reply (or fails). */
export function fakeLlm(reply = "ok", usage?: Usage): Llm {
  return {
    generate(_req: ModelRequest): Promise<LlmStream> {
      const events: StreamEvent[] = [];
      if (usage !== undefined) events.push({ kind: "usage", usage });
      events.push({ kind: "done", message: assistantText(reply) });
      return Promise.resolve(streamOf(events));
    },
  };
}

async function* streamOf(events: StreamEvent[]): LlmStream {
  for (const ev of events) yield ev;
}

// --- usage recorder -------------------------------------------------------

/** A `UsageRecorder` that only counts calls (to prove the runtime shares one object). */
export function recordingUsage(): UsageAccounting & { calls: number } {
  const inner = new UsageTracker();
  const rec: UsageAccounting & { calls: number } = {
    calls: 0,
    record(usage: Usage): void {
      rec.calls += 1;
      inner.record(usageAdd(usage, zeroUsage()));
    },
    latest: () => inner.latest(),
    total: () => inner.total(),
  };
  return rec;
}

// --- agent loop -----------------------------------------------------------

export interface FakeTurnPlan {
  /** Text deltas to emit (one frame each). */
  text?: string;
  /** Thinking deltas to emit (one frame each). */
  thinking?: string;
  /** Emit this many tool_call/tool_result pairs. */
  tools?: number;
  /** Assistant message appended to the log. */
  assistant?: string;
  /** Terminal state written to the log + emitted as the last frame. */
  outcome?: TurnOutcome;
  /** Skip the terminal write entirely (a torn turn). */
  omitTurnEnd?: boolean;
  /** Throw instead of running (a wiring failure). */
  throwError?: string;
  /** Block until the turn signal aborts, then finish as cancelled. */
  hangUntilAbort?: boolean;
}

export interface FakeLoopRecord {
  /** Inputs seen, in order. */
  inputs: string[];
  /** Signals handed to the loop per turn. */
  signals: AbortSignal[];
  /** Configs handed to the loop per turn. */
  configs: AgentConfig[];
  /** Contexts handed to the loop per turn (inspect the turn scope). */
  contexts: Context[];
  /** Sink calls per turn, in order. */
  frames: Array<{ turn: number; kind: string }>;
  /** Usage recorders handed to the loop. */
  usage: UsageRecorder[];
}

export interface FakeLoop {
  factory: LoopFactory;
  record: FakeLoopRecord;
}

/** A scripted `AgentLoop` factory: `plan(input, turnIndex)` decides each turn. */
export function fakeLoop(plan: (input: string, turn: number) => FakeTurnPlan, config?: AgentConfig): FakeLoop {
  const record: FakeLoopRecord = { inputs: [], signals: [], configs: [], contexts: [], frames: [], usage: [] };
  const factory: LoopFactory = (bindings: LoopBindings): AgentLoop => ({
    async runTurn(ctx: Context, input: string): Promise<void> {
      record.inputs.push(input);
      record.signals.push(bindings.signal);
      record.configs.push(bindings.config);
      record.contexts.push(ctx);
      record.usage.push(bindings.usage);
      void config;
      await runFakeTurn(ctx, input, plan(input, record.inputs.length), bindings, record);
    },
  });
  return { factory, record };
}

async function runFakeTurn(
  ctx: Context,
  input: string,
  plan: FakeTurnPlan,
  bindings: LoopBindings,
  record: FakeLoopRecord,
): Promise<void> {
  if (plan.throwError !== undefined) throw new Error(plan.throwError);
  const log = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
  if (log === undefined) throw new Error("fake loop: no session log in context");
  const turn = record.inputs.length;
  const turnId = log.nextTurnId();
  log.append({ type: "turn_start", id: turnId });
  log.append({ type: "user_message", text: input });
  if (plan.hangUntilAbort === true) await waitAbort(bindings.signal);
  if (bindings.signal.aborted) return finish({ log, bindings, record, turn, turnId, outcome: "cancelled" });
  emitText(bindings, record, turn, plan);
  log.append({ type: "assistant_message", text: plan.assistant ?? plan.text ?? "" });
  const outcome = plan.outcome ?? "completed";
  if (plan.omitTurnEnd === true) {
    bindings.sink({ kind: "done", text: plan.assistant ?? "", tool_calls: [] });
    return;
  }
  finish({ log, bindings, record, turn, turnId, outcome });
}

function emitText(bindings: LoopBindings, record: FakeLoopRecord, turn: number, plan: FakeTurnPlan): void {
  if (plan.thinking !== undefined) {
    bindings.sink({ kind: "thinking", delta: plan.thinking });
    record.frames.push({ turn, kind: "thinking" });
  }
  if (plan.text !== undefined) {
    bindings.sink({ kind: "text", delta: plan.text });
    record.frames.push({ turn, kind: "text" });
  }
  for (let i = 0; i < (plan.tools ?? 0); i++) {
    const id = `c${i + 1}`;
    bindings.sink({ kind: "tool_call", id, name: "read_file", args: { path: "x" } });
    record.frames.push({ turn, kind: "tool_call" });
    bindings.sink({ kind: "tool_result", callId: id, ok: true, value: "v", render: null, error: null, decision: "allow" });
    record.frames.push({ turn, kind: "tool_result" });
  }
  bindings.sink({ kind: "done", text: plan.assistant ?? plan.text ?? "", tool_calls: [] });
  record.frames.push({ turn, kind: "done" });
}

interface TurnEndArgs {
  log: SessionLog;
  bindings: LoopBindings;
  record: FakeLoopRecord;
  turn: number;
  turnId: string;
  outcome: TurnOutcome;
}

function finish(args: TurnEndArgs): void {
  args.log.append({ type: "turn_end", id: args.turnId, outcome: args.outcome });
  args.bindings.sink({ kind: "turn_end", outcome: args.outcome });
  args.record.frames.push({ turn: args.turn, kind: "turn_end" });
}

export function waitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** Give the microtask queue a chance to run (busy / concurrency tests). */
export function tick(times = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => undefined);
  return p;
}

// --- profile --------------------------------------------------------------

export function testProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    model: "deepseek-chat",
    base_url: "http://127.0.0.1:3001/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_file: null,
    max_steps: 0,
    max_parallel_tool_calls: 4,
    reasoning_effort: null,
    max_output_tokens: null,
    context_window_tokens: 65_536,
    system_prompt: "You are celestea.",
    request_format: "chat_completions",
    temperature: null,
    ...overrides,
  };
}
