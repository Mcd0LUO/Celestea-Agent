/**
 * W761 benchmark seams — the REAL engine over a fake provider.
 *
 * Everything the benchmark measures is production code: `compose()` from
 * `@celestea/runtime` assembles the generation exactly like the studio host does
 * (session plugin + provider plugin + tool plugin + `agentLoopPlugin`, plus the
 * same per-turn `loopFactory`), and `DefaultAgentLoop` is the real loop. Only
 * two things are faked, both at `core` seams and both named here:
 *
 *   - `Llm`  (the seam): a scripted, offline stream. A benchmark must not need a
 *     network or a provider account, and provider latency is noise, not signal.
 *   - `Tool` (the seam): two `fnTool` closures with realistic JSON schemas, so
 *     `registry.schemas()` (part of every context snapshot) has real work to do
 *     without touching the filesystem.
 *
 * The session log is the REAL `projectingSessionLog(memoryEventStore())` and the
 * tool registry is the REAL `createToolRegistry`.
 */

import {
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  assistantText,
  definePlugin,
  zeroUsage,
  type Llm,
  type LlmStream,
  type ModelRequest,
  type Plugin,
  type SessionLog,
  type StreamEvent,
  type Usage,
} from "@celestea/core";
import { DefaultAgentLoop, agentLoopPlugin, createUsageTracker } from "@celestea/agent-loop";
import { agentConfigFromProfile, compose, type Profile, type Runtime } from "@celestea/runtime";
import { createToolRegistry, fnTool } from "@celestea/tools";

/** Studio default context window (`packages/runtime/src/profile.ts:CONTEXT_WINDOW`). */
export const STUDIO_WINDOW = 1_000_000;
/** A deliberately small window: forces the trim path (over-budget session). */
export const TIGHT_WINDOW = 2_000;
/** Step cap of the fixture loop: one tool step + one final answer per turn. */
export const FIXTURE_MAX_STEPS = 2;

const USER_TEXT = "read src/a.ts and summarise it";
const TOOL_ARGS = { path: "src/a.ts" };
const TOOL_RESULT = { content: "export const a = 1;\nexport const b = 2;\n" };
const ANSWER_TEXT = "a.ts exports two constants; nothing else stands out.";

/** The profile the fixture conversations run under (studio-shaped). */
export function benchProfile(patch: Partial<Profile> = {}): Profile {
  return {
    model: "deepseek-chat",
    base_url: "http://127.0.0.1:3001/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    api_key_file: null,
    max_steps: FIXTURE_MAX_STEPS,
    max_parallel_tool_calls: 4,
    reasoning_effort: null,
    max_output_tokens: null,
    context_window_tokens: STUDIO_WINDOW,
    system_prompt: "You are celestea, an AI agent. Be concise and accurate.",
    request_format: "chat_completions",
    temperature: null,
    ...patch,
  };
}

function usageAt(prompt: number, completion: number): Usage {
  return { ...zeroUsage(), prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/**
 * A scripted provider: odd calls answer with a tool call, even calls with the
 * final text, so one turn is always exactly `tool step + answer step` and the
 * fixture log has a stable event shape at every scale.
 */
export class BenchLlm implements Llm {
  private calls = 0;
  requests = 0;

  generate(_req: ModelRequest): Promise<LlmStream> {
    this.calls += 1;
    this.requests += 1;
    return Promise.resolve(streamOf(this.scriptFor(this.calls)));
  }

  private scriptFor(call: number): StreamEvent[] {
    if (call % 2 === 1) {
      return [
        { kind: "thinking", text: "the user wants the file summarised" },
        { kind: "text", text: "reading the file" },
        { kind: "usage", usage: usageAt(1_180, 24) },
        {
          kind: "done",
          message: {
            role: "assistant",
            content: [{ type: "tool_call", content: { id: `call-${call}`, name: "read_file", args: TOOL_ARGS } }],
            tool_call_id: null,
          },
        },
      ];
    }
    return [
      { kind: "text", text: ANSWER_TEXT },
      { kind: "usage", usage: usageAt(1_240, 18) },
      { kind: "done", message: assistantText(ANSWER_TEXT) },
    ];
  }
}

function streamOf(events: readonly StreamEvent[]): LlmStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      for (const event of events) yield event;
    },
  };
}

/** Two real tools with realistic schemas (no filesystem, no sandbox). */
export function benchTools() {
  return createToolRegistry([
    fnTool(
      {
        name: "read_file",
        description: "Read a UTF-8 file from the workspace.",
        parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] },
      },
      async () => TOOL_RESULT,
    ),
    fnTool(
      {
        name: "list_dir",
        description: "List the entries of a directory.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      async () => ({ entries: ["a.ts", "b.ts", "index.ts"] }),
    ),
  ]);
}

function sessionPlugin(log: SessionLog): Plugin {
  return definePlugin("bench.session", (ctx) => ctx.provide(SESSION_LOG_SERVICE, log));
}

/**
 * Compose one generation over `log` — the studio wiring: the loop is BOTH a
 * mounted `AgentLoop` service (that is the object `Runtime.contextSnapshot()`
 * asks, W725) and the per-turn `loopFactory` (that is how a turn gets its sink,
 * cancellation signal and shared usage tracker).
 */
export function composeBenchRuntime(log: SessionLog, patch: Partial<Profile> = {}): Runtime {
  const profile = benchProfile(patch);
  const usage = createUsageTracker();
  const config = agentConfigFromProfile(profile);
  return compose({
    profile,
    plugins: [
      sessionPlugin(log),
      definePlugin("bench.llm", (ctx) => ctx.provide(LLM_SERVICE, new BenchLlm())),
      definePlugin("bench.tools", (ctx) => ctx.provide(TOOL_REGISTRY_SERVICE, benchTools())),
      agentLoopPlugin(config, {}, "bench.agent-loop"),
    ],
    usage,
    loopFactory: (bindings) =>
      new DefaultAgentLoop(bindings.config, { signal: bindings.signal, sink: bindings.sink, usage }),
    workers: false,
    watchdog: false,
  });
}

/** The user text every synthetic turn carries (also the fixture's input). */
export const FIXTURE_TURN_INPUT = USER_TEXT;
