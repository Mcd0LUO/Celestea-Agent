/**
 * DefaultAgentLoop — port of `crates/agent-loop/src/loop.rs`.
 *
 * One turn = one user message + N model steps. Per step the loop:
 *   1. derives the model-visible history from the session log (the log is the
 *      only source of truth) and trims it to the context budget;
 *   2. asks the `Llm` seam for a stream and consumes text / thinking / usage
 *      deltas, aggregating reasoning bursts into one persisted row;
 *   3. appends the authoritative assistant reply, or dispatches the step's
 *      tool calls through the `ToolRegistry` seam (all `tool_call` rows first,
 *      then one `tool_result` per call, in model order);
 *   4. appends whatever arrived while the turn was RUNNING — a user
 *      interjection or a worker receipt — to the log at the step boundary,
 *      right before the next model call (W513), so the running turn receives it
 *      without being interrupted and without a second turn being started;
 *   5. repeats until the model answers without tool calls, the step budget is
 *      exhausted, the turn is cancelled, or the stream fails.
 *
 * Every started turn ends with EXACTLY ONE `turn_end` — in the log and on the
 * event stream, written from a single exit point — carrying one of the five
 * real terminal states: completed / cancelled / error / step_limit /
 * interrupted. A torn stream, an exhausted budget or a cancellation is never
 * reported as `completed`.
 *
 * Cancellation is cooperative over an [AbortSignal] and re-checked at every
 * await checkpoint (before generating, while streaming, between tool batches).
 * When a tool batch is abandoned, every unanswered call of the step gets a
 * synthesized cancelled `tool_result`, so the log stays protocol-valid.
 */

import {
  AgentError,
  formatInjection,
  type AgentConfig,
  type AgentLoop,
  type Context,
  type InjectionSource,
  type LoopEvent,
  type LlmStream,
  type ModelRequest,
  type ToolCall,
  type ToolOutput,
  type ToolRegistry,
  type TurnOutcome,
} from "@celestea/core";
import { CANCELLED_BEFORE_EXECUTION, closeIterator, errorMessage, isAborted, raceAbort } from "./cancel.js";
import { estimateTokens, trimContext } from "./context-trim.js";
import { doneEvent, toolCallEvent, toolResultEvent, turnEndEvent, type EventSink } from "./events.js";
import { dispatchCall, resolveSeams, toToolInput, type Seams } from "./seams.js";
import { absorbDone, emptyStreamOutcome, terminalFromStreamEvent, type GenerateResult, type StepResult, type StreamOutcome } from "./step.js";
import { ThinkingBuffer } from "./thinking.js";
import { UsageTracker } from "./usage.js";

/** Optional collaborators of one loop instance (Rust `with_bindings`). */
export interface AgentLoopBindings {
  /** Cooperative cancellation; absent = the turn can never be cancelled. */
  signal?: AbortSignal;
  /** Turn-event sink; absent = events are dropped (the host owns rendering). */
  sink?: EventSink;
  /** Shared usage accounting; absent = provider usage is not recorded. */
  usage?: UsageTracker;
  /** Mid-turn injection source (W513); absent = the turn takes no interjections. */
  injections?: InjectionSource;
}

export class DefaultAgentLoop implements AgentLoop {
  private readonly config: AgentConfig;
  private readonly signal: AbortSignal | undefined;
  private readonly sink: EventSink | undefined;
  private readonly usage: UsageTracker | undefined;
  private readonly injections: InjectionSource | undefined;

  constructor(config: AgentConfig, bindings: AgentLoopBindings = {}) {
    this.config = config;
    this.signal = bindings.signal;
    this.sink = bindings.sink;
    this.usage = bindings.usage;
    this.injections = bindings.injections;
  }

  /** The config this loop drives turns with. */
  get agentConfig(): AgentConfig {
    return this.config;
  }

  /** The usage tracker bound at construction, when one was provided. */
  get usageTracker(): UsageTracker | undefined {
    return this.usage;
  }

  /** AgentLoop seam: drive one turn; rejects only on a broken Context wiring. */
  async runTurn(ctx: Context, userInput: string): Promise<void> {
    await this.runTurnOutcome(ctx, userInput);
  }

  /** Same turn, handing the terminal state back to the caller (hosts / tests). */
  async runTurnOutcome(ctx: Context, userInput: string): Promise<TurnOutcome> {
    const seams = resolveSeams(ctx);
    // The LOG owns the monotonic turn id counter, so ids stay unique across
    // loop instances and process restarts.
    const turnId = seams.session.nextTurnId();
    seams.session.append({ type: "turn_start", id: turnId });
    seams.session.append({ type: "user_message", text: userInput });

    const outcome = await this.driveSteps(seams);

    // P0-A: exactly one TurnEnd per turn, log and event stream written as a
    // pair from this single exit point.
    seams.session.append({ type: "turn_end", id: turnId, outcome });
    this.emit(turnEndEvent(outcome));
    return outcome;
  }

  /** The step loop: budget -> cancel checkpoint -> one model step. */
  private async driveSteps(seams: Seams): Promise<TurnOutcome> {
    let stepsDone = 0;
    for (;;) {
      // max_steps === 0 means unlimited steps (W220); a nonzero cap stops the
      // loop without a final answer, which is a step_limit, never completed.
      if (this.config.max_steps > 0 && stepsDone >= this.config.max_steps) return "step_limit";
      stepsDone += 1;
      if (isAborted(this.signal)) return "cancelled";
      const step = await this.runStep(seams);
      if (step.kind === "continue") continue;
      return step.kind === "cancelled" ? "cancelled" : step.outcome;
    }
  }

  /**
   * Derive the history from the log and trim it to the context budget. A
   * `context_window_tokens` of 0 disables trimming (back-compat).
   */
  private buildRequest(seams: Seams): ModelRequest {
    const trimmed = trimContext(
      seams.session.deriveMessages(),
      estimateTokens(this.config.system_prompt),
      this.config.context_window_tokens,
      this.config.context_trim_threshold,
      this.config.context_keep_recent,
    );
    return {
      model: this.config.model,
      system: this.config.system_prompt,
      messages: trimmed.messages,
      tools: seams.registry.schemas(),
      max_tokens: null,
      temperature: null,
    };
  }

  /** Start one model response; interruptible, never throws on provider failure. */
  private async generate(seams: Seams, request: ModelRequest): Promise<GenerateResult> {
    const raced = await raceAbort(this.signal, seams.llm.generate(request));
    if (raced.outcome === "aborted") return { kind: "cancelled" };
    if (raced.outcome === "failed") {
      // Generation failure is a terminal error state with a TurnEnd (R1),
      // never a silent return.
      return { kind: "failed", outcome: { error: { kind: "generate", message: errorMessage(raced.error) } } };
    }
    return { kind: "ok", stream: raced.value };
  }

  /** One step: inject what arrived mid-turn, generate, consume, decide. */
  private async runStep(seams: Seams): Promise<StepResult> {
    this.injectPending(seams);
    const started = await this.generate(seams, this.buildRequest(seams));
    if (started.kind === "cancelled") return { kind: "cancelled" };
    if (started.kind === "failed") return { kind: "final", outcome: started.outcome };

    const thinking = new ThinkingBuffer(seams.session);
    const stream = await this.consumeStream(started.stream, thinking);
    // Stream-end flush: trailing reasoning (providers stream it AFTER the
    // finish frame), a thinking-only stream and a mid-stream cancel all persist
    // here, ahead of the appends below.
    thinking.flush();
    // The Done event is deferred to this point, so any late thinking still
    // lands before the reply on the wire.
    if (stream.doneMessage !== null) this.emit(doneEvent(stream.doneMessage));
    return this.finishStep(seams, stream);
  }

  /**
   * Consume the response stream. A cancel drops the partial turn (no
   * incomplete AssistantMessage is flushed); a failed / torn stream records the
   * matching terminal state instead of pretending success.
   */
  private async consumeStream(stream: LlmStream, thinking: ThinkingBuffer): Promise<StreamOutcome> {
    const out = emptyStreamOutcome();
    const iter = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = await raceAbort(this.signal, iter.next());
      if (next.outcome === "aborted") {
        closeIterator(iter);
        out.cancelled = true;
        break;
      }
      if (next.outcome === "failed") {
        out.terminal = { error: { kind: "stream", message: errorMessage(next.error) } };
        break;
      }
      if (next.value.done === true) break;
      const event = next.value.value;
      if (event.kind === "text") {
        thinking.flush();
        this.emit({ kind: "text", delta: event.text });
      } else if (event.kind === "thinking") {
        thinking.push(event.text);
        this.emit({ kind: "thinking", delta: event.text });
      } else if (event.kind === "usage") {
        this.usage?.record(event.usage);
      } else if (event.kind === "done") {
        thinking.flush();
        absorbDone(out, event.message);
      } else {
        thinking.flush();
        out.terminal = terminalFromStreamEvent(event);
        break;
      }
    }
    return out;
  }

  /** Turn the consumed stream into the step verdict. */
  private async finishStep(seams: Seams, stream: StreamOutcome): Promise<StepResult> {
    if (stream.cancelled) return { kind: "cancelled" };
    if (!stream.sawDone) {
      // Stream ended without a terminal frame: a real terminal state, and no
      // empty AssistantMessage is flushed.
      return { kind: "final", outcome: stream.terminal ?? "interrupted" };
    }
    if (stream.toolCalls.length === 0) {
      seams.session.append({ type: "assistant_message", text: stream.assistantText });
      return { kind: "final", outcome: stream.terminal ?? "completed" };
    }
    // Deliberate divergence from the Rust loop (README §Divergences): a torn
    // stream after a done frame ends the turn instead of dispatching tools
    // under a sticky error outcome.
    if (stream.terminal !== null) return { kind: "final", outcome: stream.terminal };
    const cancelled = await this.dispatchToolCalls(seams, stream.toolCalls);
    return cancelled ? { kind: "cancelled" } : { kind: "continue" };
  }

  /**
   * Append every `tool_call` of the step first, then dispatch in batches of
   * `max_parallel_tool_calls` (clamped to >= 1) and append one `tool_result`
   * per call in model order. Returns true when a cancellation abandoned the
   * batches.
   */
  private async dispatchToolCalls(seams: Seams, calls: readonly ToolCall[]): Promise<boolean> {
    for (const call of calls) {
      seams.session.append({ type: "tool_call", id: call.id, name: call.name, args: call.args });
      this.emit(toolCallEvent(call));
    }
    const answered = new Set<string>();
    const limit = Math.max(1, this.config.max_parallel_tool_calls);
    let cancelled = false;
    for (let start = 0; start < calls.length; start += limit) {
      const batch = calls.slice(start, start + limit);
      const raced = await raceAbort(this.signal, this.dispatchBatch(seams.registry, batch));
      // Unreachable: dispatchCall is total, so a batch never rejects.
      if (raced.outcome === "failed") throw new AgentError(`tool dispatch failed: ${errorMessage(raced.error)}`);
      if (raced.outcome === "aborted") {
        cancelled = true;
        break;
      }
      for (const output of raced.value) this.recordToolResult(seams, output, answered);
    }
    if (cancelled) this.synthesizeCancelledResults(seams, calls, answered);
    return cancelled;
  }

  /** Dispatch one batch concurrently; results keep the model's call order. */
  private dispatchBatch(registry: ToolRegistry, batch: readonly ToolCall[]): Promise<ToolOutput[]> {
    return Promise.all(batch.map((call) => dispatchCall(registry, toToolInput(call))));
  }

  private recordToolResult(seams: Seams, output: ToolOutput, answered: Set<string>): void {
    this.emit(toolResultEvent(output));
    answered.add(output.call_id);
    seams.session.append({ type: "tool_result", id: output.call_id, value: output.value, error: output.error });
  }

  /**
   * W267: a cancel mid-dispatch drops the in-flight batch and every later
   * batch, which would leave the assistant `tool_calls` dangling — an
   * OpenAI-compatible upstream rejects that history with 400. One synthesized
   * cancelled result per unanswered call keeps the LOG protocol-valid: in the
   * model's call order, after every real result and before TurnEnd.
   */
  private synthesizeCancelledResults(seams: Seams, calls: readonly ToolCall[], answered: ReadonlySet<string>): void {
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const error = CANCELLED_BEFORE_EXECUTION;
      seams.session.append({ type: "tool_result", id: call.id, value: null, error });
      this.emit(toolResultEvent({ call_id: call.id, value: null, render: null, error, decision: null }));
    }
  }

  /**
   * W513 step boundary: append every message that arrived while the turn was
   * running as a `user_message` row, in arrival order, before the model call
   * that follows. Returns how many rows were appended.
   *
   * The log is the only source of truth, so the injected text is part of the
   * derived history of THIS turn and of every later step of it — and it is
   * written by the same append path as the turn's own input.
   */
  private injectPending(seams: Seams): number {
    const pending = this.injections?.drain() ?? [];
    for (const injection of pending) {
      seams.session.append({ type: "user_message", text: formatInjection(injection) });
    }
    return pending.length;
  }

  /** Route one turn event to the sink; without a sink the host renders nothing. */
  private emit(event: LoopEvent): void {
    this.sink?.(event);
  }
}
