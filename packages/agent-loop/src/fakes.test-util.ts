/**
 * Fake seams for the agent-loop tests.
 *
 * Every dependency of the loop is faked at the `core` seam (Llm / SessionLog /
 * ToolRegistry): no network, no filesystem, and no import of a sibling L1
 * package — `packages/agent-loop` may only depend on `core`
 * (ARCHITECTURE.md §1). The fakes mirror the Rust `#[cfg(test)]` doubles of
 * `crates/agent-loop/src/lib.rs` one for one, so the TS suite checks the same
 * contracts.
 */

import {
  assistantText,
  Context,
  LLM_SERVICE,
  LlmError,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type AgentConfig,
  type Llm,
  type LlmStream,
  type LoopEvent,
  type Message,
  type ModelRequest,
  type SessionEvent,
  type SessionLog,
  type StreamEvent,
  type Tool,
  type ToolGuard,
  type ToolInput,
  type ToolOutput,
  type ToolRegistry,
  type ToolSpec,
  type TurnOutcome,
} from "@celestea/core";
import { defaultAgentConfig } from "@celestea/core";
import { DefaultAgentLoop, type AgentLoopBindings } from "./loop.js";
import type { EventSink } from "./events.js";

// ---------------------------------------------------------------------------
// small async utilities
// ---------------------------------------------------------------------------

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let queued microtasks run (`tokio::task::yield_now`). */
export async function yieldTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** An assistant message carrying one tool call per id (single message). */
export function toolCallMessage(ids: readonly string[]): Message {
  return {
    role: "assistant",
    content: ids.map((id) => ({ type: "tool_call" as const, content: { id, name: `tool_${id}`, args: {} } })),
    tool_call_id: null,
  };
}

// ---------------------------------------------------------------------------
// Llm fakes
// ---------------------------------------------------------------------------

/** Yield a fixed script once, then end the stream (`EventLlm`). */
export function scriptedStream(events: readonly StreamEvent[]): LlmStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      for (const event of events) yield event;
    },
  };
}

/** A stream that yields `head` and then never produces again (`HangLlm`). */
export function hangingStream(head: readonly StreamEvent[] = []): LlmStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      for (const event of head) yield event;
      await new Promise<never>(() => undefined);
    },
  };
}

/** Replays the same script on every call. */
export class ScriptLlm implements Llm {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: readonly StreamEvent[]) {}

  async generate(req: ModelRequest): Promise<LlmStream> {
    this.requests.push(req);
    return scriptedStream(this.script);
  }
}

/** Serves one script per call from a queue (`FakeLlm` + `ThinkingToolLlm`). */
export class ScriptedLlm implements Llm {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly scripts: ReadonlyArray<readonly StreamEvent[]>) {}

  async generate(req: ModelRequest): Promise<LlmStream> {
    this.requests.push(req);
    const script = this.scripts[this.index] ?? [{ kind: "done", message: assistantText("done") } as StreamEvent];
    this.index += 1;
    return scriptedStream(script);
  }
}

/** Yields `head`, then parks forever: only cancellation can end this stream. */
export class HangingLlm implements Llm {
  constructor(private readonly head: readonly StreamEvent[] = []) {}

  async generate(): Promise<LlmStream> {
    return hangingStream(this.head);
  }
}

/** `generate` fails: the provider refused to answer (R1 error path). */
export class FailingLlm implements Llm {
  constructor(private readonly message = "provider timeout") {}

  async generate(): Promise<LlmStream> {
    throw new LlmError(this.message);
  }
}

// ---------------------------------------------------------------------------
// SessionLog fake
// ---------------------------------------------------------------------------

export class FakeSessionLog implements SessionLog {
  private recorded: SessionEvent[] = [];
  private derived: Message[] = [];
  private counter = 0;

  append(event: SessionEvent): void {
    this.recorded.push(event);
  }

  events(): SessionEvent[] {
    return [...this.recorded];
  }

  deriveMessages(): Message[] {
    return [...this.derived];
  }

  clear(): void {
    this.recorded = [];
  }

  /** The log owns the monotonic counter (P0-A), never reused. */
  nextTurnId(): string {
    return `turn-${this.counter++}`;
  }

  /** Pre-bake the projection (the real log derives it from the events). */
  setDerived(messages: readonly Message[]): void {
    this.derived = [...messages];
  }
}

// ---------------------------------------------------------------------------
// ToolRegistry fake
// ---------------------------------------------------------------------------

/** Records every dispatch and the maximum concurrency observed (W220). */
export class FakeToolRegistry implements ToolRegistry {
  readonly order: string[] = [];
  readonly blockingStarted = deferred();
  maxActive = 0;
  private active = 0;
  private readonly blocking: ReadonlySet<string>;

  constructor(blocking: readonly string[] = []) {
    this.blocking = new Set(blocking);
  }

  register(_tool: Tool): void {
    // no tools in the loop tests: specs are not what is under test here
  }

  addGuard(_guard: ToolGuard): void {
    // guard chain semantics are covered by packages/tools
  }

  get(_name: string): Tool | undefined {
    return undefined;
  }

  schemas(): ToolSpec[] {
    return [];
  }

  async dispatch(input: ToolInput): Promise<ToolOutput> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.order.push(input.call_id);
    if (this.blocking.has(input.call_id)) {
      this.blockingStarted.resolve();
      await new Promise<never>(() => undefined);
    }
    // Yield so peers of the same batch can start before this one completes.
    await yieldTimes(3);
    this.active -= 1;
    return { call_id: input.call_id, value: { ok: true }, render: null, error: null, decision: { kind: "allow" } };
  }
}

/** A registry whose dispatch() rejects: a seam-contract violation. */
export class ThrowingToolRegistry extends FakeToolRegistry {
  override async dispatch(input: ToolInput): Promise<ToolOutput> {
    this.order.push(input.call_id);
    throw new Error(`registry exploded for ${input.call_id}`);
  }
}

// ---------------------------------------------------------------------------
// drivers + log inspection helpers
// ---------------------------------------------------------------------------

export interface SinkLog {
  sink: EventSink;
  events: LoopEvent[];
  kinds(): string[];
}

/** A sink that records every event, with an optional observer hook. */
export function collectingSink(onEvent?: (event: LoopEvent) => void): SinkLog {
  const events: LoopEvent[] = [];
  return {
    sink: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    events,
    kinds: () => events.map((event) => event.kind),
  };
}

export function contextWith(parts: { llm: Llm; session: SessionLog; registry: ToolRegistry }): Context {
  const ctx = Context.root();
  ctx.provide(LLM_SERVICE, parts.llm);
  ctx.provide(SESSION_LOG_SERVICE, parts.session);
  ctx.provide(TOOL_REGISTRY_SERVICE, parts.registry);
  return ctx;
}

export function makeLoop(
  config: Partial<AgentConfig> = {},
  bindings: AgentLoopBindings = {},
): DefaultAgentLoop {
  return new DefaultAgentLoop({ ...defaultAgentConfig(), ...config }, bindings);
}

export function eventsOfType<T extends SessionEvent["type"]>(
  session: FakeSessionLog,
  type: T,
): Array<Extract<SessionEvent, { type: T }>> {
  return session.events().filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

/** ToolCall ids in log order. */
export function loggedToolCalls(session: FakeSessionLog): string[] {
  return eventsOfType(session, "tool_call").map((event) => event.id);
}

/** ToolResult ids in log order. */
export function loggedToolResults(session: FakeSessionLog): string[] {
  return eventsOfType(session, "tool_result").map((event) => event.id);
}

/** `(id, error)` pairs of every ToolResult row, in log order. */
export function loggedToolResultErrors(session: FakeSessionLog): Array<[string, string | null]> {
  return eventsOfType(session, "tool_result").map((event) => [event.id, event.error]);
}

/** The logged turn terminal state (the LAST turn_end wins). */
export function lastOutcome(session: FakeSessionLog): TurnOutcome {
  const ends = eventsOfType(session, "turn_end");
  const last = ends[ends.length - 1];
  if (last === undefined) throw new Error("expected a turn_end row in the log");
  return last.outcome ?? "completed";
}

/** The W252 projection: thinking/assistant/tool rows only, in append order. */
export function persistedKinds(session: FakeSessionLog): string[] {
  return session
    .events()
    .flatMap((event) => {
      if (event.type === "thinking_delta") return [`thinking:${event.text}`];
      if (event.type === "assistant_message") return [`assistant:${event.text}`];
      if (event.type === "tool_call") return [`toolcall:${event.id}`];
      if (event.type === "tool_result") return [`toolresult:${event.id}`];
      return [];
    });
}

// ---------------------------------------------------------------------------
// turn harness
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  llm: Llm;
  config?: Partial<AgentConfig>;
  bindings?: AgentLoopBindings;
  registry?: FakeToolRegistry;
  session?: FakeSessionLog;
  /** Observe every sink event (used to abort mid-stream, assert order, …). */
  onEvent?: (event: LoopEvent) => void;
}

/** A turn-ready Context: fakes mounted, a recording sink, and `run()`. */
export interface Harness {
  session: FakeSessionLog;
  registry: FakeToolRegistry;
  sink: SinkLog;
  loop: DefaultAgentLoop;
  ctx: Context;
  /** Drive one turn; the returned promise carries the terminal state. */
  run(userInput?: string): Promise<TurnOutcome>;
}

export function harness(options: HarnessOptions): Harness {
  const session = options.session ?? new FakeSessionLog();
  const registry = options.registry ?? new FakeToolRegistry();
  const sink = collectingSink(options.onEvent);
  const ctx = contextWith({ llm: options.llm, session, registry });
  const loop = makeLoop(options.config ?? {}, { ...options.bindings, sink: sink.sink });
  return { session, registry, sink, loop, ctx, run: (userInput = "hello") => loop.runTurnOutcome(ctx, userInput) };
}
