/**
 * A REAL engine corpus for the contract tests (W744).
 *
 * The session-event schema and the SSE payload table must be checked against
 * what the engine actually produces, not against hand-written shapes. This
 * module composes the production assembly — `@celestea/runtime`'s `compose`
 * (which with no override uses the PRODUCTION frame mapper `loopEventToFrame`),
 * the real `DefaultAgentLoop`, a real `ToolRegistryImpl` from `assembleTools`
 * and a real `InMemorySessionLog` — and drives one turn with a scripted `Llm`
 * seam. So:
 *   * `events` is a genuine `cli-main.jsonl`-shaped stream from the engine;
 *   * `frames` is what the runtime publishes for that turn, which is what
 *     `GET /api/events` puts on the wire.
 */

import {
  TOOL_REGISTRY_SERVICE,
  LLM_SERVICE,
  assistantText,
  assistantToolCall,
  definePlugin,
  zeroUsage,
  type Llm,
  type Sandbox,
  type SessionEvent,
  type StreamEvent,
  type ToolSpec,
  type TurnOutcome,
} from "@celestea/core";
import { collectingSink, compose, loopEventToFrame, type FrameMapper, type Profile, type TurnFrame } from "@celestea/runtime";
import { DefaultAgentLoop } from "@celestea/agent-loop";
import { InMemorySessionLog, inMemorySessionLogPlugin } from "@celestea/session";
import { assembleTools, fnTool } from "@celestea/tools";

/** The tool the corpus calls: registered exactly like a builtin (fnTool seam). */
export const CORPUS_TOOL = "w744_echo";

export interface LiveTurn {
  /** Every event the turn appended to the log, in order (the real stream). */
  events: SessionEvent[];
  /** Every frame the runtime published for that turn, in order. */
  frames: TurnFrame[];
  /** Terminal state the runtime read back from the log. */
  outcome: TurnOutcome;
}

export interface TurnOptions {
  /** Frame mapper override; absent = the production default of `compose`. */
  mapper?: FrameMapper;
}

/** Drive one turn over the production assembly; only the `Llm` seam is scripted. */
export async function runProductionTurn(input = "check the contract", options: TurnOptions = {}): Promise<LiveTurn> {
  const log = new InMemorySessionLog();
  const profile = liveProfile();
  const assembly = assembleTools({
    tools: [fnTool(corpusSpec(), (args) => Promise.resolve({ echoed: args }))],
    guard: null,
    env: {},
    sandbox: stubSandbox(),
  });
  const runtime = compose({
    profile,
    plugins: [
      provideLlm(scriptedLlm()),
      inMemorySessionLogPlugin("w744.session", log),
      provideTools(assembly.registry),
    ],
    // The production wiring (apps/studio/src/runtime/session-compose.ts): the
    // loop is built PER TURN so the runtime's sink and signal reach it.
    loopFactory: (bindings) => new DefaultAgentLoop(bindings.config, { signal: bindings.signal, sink: bindings.sink }),
    workers: false,
    watchdog: false,
    ...(options.mapper === undefined ? {} : { frameMapper: options.mapper }),
  });
  const { frames, sink } = collectingSink();
  const outcome = await runtime.runTurn(input, { sink });
  await runtime.shutdown();
  return { events: log.events(), frames, outcome };
}

/** The production mapper, exported so a test can hold the default to it. */
export const productionMapper: FrameMapper = loopEventToFrame;

/** A scripted `Llm`: step 1 thinks, talks, calls a tool; step 2 answers. */
export function scriptedLlm(): Llm {
  const steps: StreamEvent[][] = [
    [
      { kind: "thinking", text: "let me look" },
      { kind: "text", text: "working" },
      { kind: "usage", usage: zeroUsage() },
      { kind: "done", message: assistantToolCall({ id: "c1", name: CORPUS_TOOL, args: { text: "x" } }) },
    ],
    [{ kind: "done", message: assistantText("all done") }],
  ];
  let step = 0;
  return {
    generate(): Promise<AsyncIterable<StreamEvent>> {
      const events = steps[Math.min(step, steps.length - 1)] ?? [];
      step += 1;
      return Promise.resolve(streamOf(events));
    },
  };
}

async function* streamOf(events: readonly StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) yield event;
}

function provideLlm(llm: Llm) {
  return definePlugin("w744.llm", (ctx) => ctx.provide(LLM_SERVICE, llm));
}

function provideTools(registry: ReturnType<typeof assembleTools>["registry"]) {
  return definePlugin("w744.tools", (ctx) => ctx.provide(TOOL_REGISTRY_SERVICE, registry));
}

function corpusSpec(): ToolSpec {
  return {
    name: CORPUS_TOOL,
    description: "Echo the argument back (W744 contract corpus).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  };
}

function stubSandbox(): Sandbox {
  const config = { timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024, workdir: "/tmp", root: "/tmp", extraEnv: [] as ReadonlyArray<readonly [string, string]> };
  const refuse = (): Promise<never> => Promise.reject(new Error("W744 corpus: the sandbox is never executed"));
  return { config, run: refuse, spawn: refuse };
}

function liveProfile(): Profile {
  return {
    model: "deepseek-chat",
    base_url: "http://127.0.0.1:3001/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_file: null,
    max_steps: 4,
    max_parallel_tool_calls: 4,
    reasoning_effort: null,
    max_output_tokens: null,
    context_window_tokens: 65_536,
    system_prompt: "You are celestea.",
    request_format: "chat_completions",
    temperature: null,
  };
}
