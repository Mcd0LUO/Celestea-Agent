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
  messageTexts,
  type AgentConfig,
  type AgentLoop,
  type Context,
  type InjectionSource,
  type LoopEvent,
  type LlmStream,
  type ModelRequest,
  type ImageRef,
  type StreamEvent,
  type ToolCall,
  type ToolOutput,
  type ToolRegistry,
  type TurnOutcome,
} from "@celestea/core";
import { CANCELLED_BEFORE_EXECUTION, closeIterator, errorMessage, isAborted, raceAbort } from "./cancel.js";
import { estimateTokens, trimContext } from "./context-trim.js";
import { doneEvent, toolCallEvent, toolResultEvent, turnEndEvent, type EventSink } from "./events.js";
import { isPerturbable } from "./perturbation.js";
import { releaseAfterStream } from "./repetition-cut.js";
import { CollapseDriver } from "./repetition-driver.js";
import { createRepetitionGuard, DEEPSEEK_REPETITION_THRESHOLDS, type RepetitionChannel, type RepetitionEvidence, type RepetitionGuard, type RepetitionThresholds } from "./repetition.js";
import { planRepetition, type RepetitionDiagnostics } from "./repetition-recovery.js";
import { dispatchCall, resolveSeams, toToolInput, type Seams } from "./seams.js";
import { absorbDone, emptyStreamOutcome, terminalFromStreamEvent, type GenerateResult, type StepResult, type StreamOutcome } from "./step.js";
import { ThinkingBuffer } from "./thinking.js";
import { UsageTracker } from "./usage.js";
import {
  RETENTION_SERVICE,
  faceToolOutput,
  newStepRetention,
  retainToolResult,
  type StepRetention,
  type ToolResultRetention,
} from "./retention.js";

/** Optional collaborators of one loop instance (`with_bindings`). */
export interface AgentLoopBindings {
  /** Cooperative cancellation; absent = the turn can never be cancelled. */
  signal?: AbortSignal;
  /** Turn-event sink; absent = events are dropped (the host owns rendering). */
  sink?: EventSink;
  /** Shared usage accounting; absent = provider usage is not recorded. */
  usage?: UsageTracker;
  /** Mid-turn injection source (W513); absent = the turn takes no interjections. */
  injections?: InjectionSource;
  /**
   * W1510: override the degenerate-repetition thresholds, or `false` to disable
   * detection. Absent = the calibrated defaults, applied ONLY to DeepSeek-family
   * models (see `repetition.ts`); every other model is never detected.
   */
  repetition?: RepetitionThresholds | false;
  /**
   * W1510: how many collapsed attempts may be DISCARDED and re-issued inside one
   * step before the guard switches to truncating the stream instead. The ported
   * default is 2. `0` disables the retry arm entirely (first conviction
   * truncates).
   */
  repetitionRetries?: number;
  /**
   * W1510: where the diagnostics of a conviction go. Absent = the conviction is
   * still logged to the turn's own event stream, but no sidecar copy and no
   * JSONL line are written. A conviction DISCARDS text, so the copy is the only
   * surviving record of what was thrown away.
   */
  repetitionDiagnostics?: RepetitionDiagnostics;
  /**
   * W1510: the session this loop drives, stamped on every conviction log line.
   * Absent = the line carries `null`, which is honest rather than invented.
   */
  sessionId?: string | null;
}

/** Bound of the "do not close while a steering message waits" extension. */
export const MAX_STEER_EXTENSIONS = 8;

/**
 * W1510: discarded-and-reissued attempts per step before the guard truncates.
 * Ported from the plugin's `maxDegenerationRetries: 2` — two chances to get a
 * clean attempt, then a cut, because a model that has collapsed three times on
 * the same context will do it again.
 */
export const DEFAULT_REPETITION_RETRIES = 2;

export class DefaultAgentLoop implements AgentLoop {
  private readonly config: AgentConfig;
  private readonly signal: AbortSignal | undefined;
  private readonly sink: EventSink | undefined;
  private readonly usage: UsageTracker | undefined;
  private readonly injections: InjectionSource | undefined;
  /** W1510: the resolved guard factory (null = detection is off for this loop). */
  private readonly repetition: RepetitionThresholds | null;
  /** W1510: discarded-and-reissued attempts allowed per step (see the binding). */
  private readonly repetitionRetries: number;
  /** W1510: sidecar copy + JSONL log of every conviction (absent = none). */
  private readonly diagnostics: RepetitionDiagnostics | null;
  /**
   * W1510: the session id stamped on a conviction's log line, learned from the
   * bindings (the log row's own session) — the loop has no other way to name it.
   */
  private sessionId: string | null = null;
  /** W855: resolved from the Context once per turn (null = retention off). */
  private retention: ToolResultRetention | null = null;

  constructor(config: AgentConfig, bindings: AgentLoopBindings = {}) {
    this.config = config;
    this.signal = bindings.signal;
    this.sink = bindings.sink;
    this.usage = bindings.usage;
    this.injections = bindings.injections;
    this.repetition = bindings.repetition === false ? null : (bindings.repetition ?? DEEPSEEK_REPETITION_THRESHOLDS);
    this.repetitionRetries = Math.max(0, bindings.repetitionRetries ?? DEFAULT_REPETITION_RETRIES);
    this.diagnostics = bindings.repetitionDiagnostics ?? null;
    this.sessionId = bindings.sessionId ?? null;
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
  async runTurn(ctx: Context, userInput: string | null, attachments?: readonly ImageRef[]): Promise<void> {
    await this.runTurnOutcome(ctx, userInput, attachments);
  }

  /**
   * W725: the EXACT request the next step would build for `ctx` — the same
   * `buildRequest` the turn uses (system prompt + post-trim derived history +
   * `registry.schemas()`), so a read-only context snapshot can never drift from
   * what the model is actually sent.
   *
   * Read-only by construction: it never appends to the log, never dispatches a
   * tool and never touches the step budget or the usage tracker.
   */
  contextSnapshot(ctx: Context): ModelRequest {
    return this.buildRequest(resolveSeams(ctx));
  }

  /** Same turn, handing the terminal state back to the caller (hosts / tests). */
  async runTurnOutcome(ctx: Context, userInput: string | null, attachments?: readonly ImageRef[]): Promise<TurnOutcome> {
    const seams = resolveSeams(ctx);
    // W855: the host provides the session-scoped retention policy; absent = off.
    this.retention = ctx.get<ToolResultRetention>(RETENTION_SERVICE) ?? null;
    // The LOG owns the monotonic turn id counter, so ids stay unique across
    // loop instances and process restarts.
    const turnId = seams.session.nextTurnId();
    seams.session.append({ type: "turn_start", id: turnId });
    // W804: the turn's own input carries this turn's attachments. The condition
    // keeps the no-attachment row byte-identical to the pre-W804 shape.
    // W855 (C8): a `null` input with no attachments writes NO row — the turn's
    // user content is whatever the drain already injected (see the AgentLoop
    // seam doc). `null` + attachments still writes the `""`-text image row.
    if (attachments !== undefined && attachments.length > 0) {
      seams.session.append({ type: "user_message", text: userInput ?? "", attachments: [...attachments] });
    } else if (userInput !== null) {
      seams.session.append({ type: "user_message", text: userInput });
    }

    let outcome: TurnOutcome = "interrupted";
    let failure: unknown;
    let failed = false;
    try {
      outcome = await this.driveSteps(seams);
    } catch (error) {
      // W813 P2-runTurnOutcome: a seam throw while deriving the request / driving
      // a step used to escape BEFORE the single TurnEnd write, leaving turn_start
      // dangling (the watchdog then keeps the worker RUNNING forever). Capture it
      // as this turn's terminal state, write the pair below, then rethrow so the
      // broken seam is still visible to the caller.
      failed = true;
      failure = error;
      outcome = { error: { kind: "generate", message: errorMessage(error) } };
    }

    // P0-A: exactly one TurnEnd per turn, log and event stream written as a pair
    // from this single exit point — reached on the throw path too.
    seams.session.append({ type: "turn_end", id: turnId, outcome });
    this.emit(turnEndEvent(outcome));
    if (failed) throw failure;
    return outcome;
  }

  /**
   * The step loop: budget -> cancel checkpoint -> one model step.
   *
   * W515 §1 invariant: a turn must NOT reach its terminal state while the
   * `next-step` lane still holds something — the message is drained and answered
   * inside THIS turn (that is what makes "closing -> inject" real). The
   * extension is bounded, and a cancelled turn still stops immediately.
   */
  private async driveSteps(seams: Seams): Promise<TurnOutcome> {
    let stepsDone = 0;
    let extensions = 0;
    // W1510: retries spent on collapsed attempts in THIS step. A discarded
    // attempt produced no message, so it must not be debited against the step
    // budget — otherwise a collapsing model would silently shorten the turn.
    let retries = 0;
    for (;;) {
      // max_steps === 0 means unlimited steps (W220); a nonzero cap stops the
      // loop without a final answer, which is a step_limit, never completed.
      if (this.config.max_steps > 0 && stepsDone >= this.config.max_steps) return "step_limit";
      stepsDone += 1;
      if (isAborted(this.signal)) return "cancelled";
      const step = await this.runStep(seams, retries);
      if (step.kind === "continue") {
        retries = 0;
        continue;
      }
      if (step.kind === "retry") {
        retries = step.retriesUsed;
        stepsDone -= 1;
        continue;
      }
      if (step.kind === "final" && extensions < MAX_STEER_EXTENSIONS && this.pendingSteering() > 0) {
        extensions += 1;
        continue;
      }
      return step.kind === "cancelled" ? "cancelled" : step.outcome;
    }
  }

  /** Steering messages still waiting (the close guard of W515 §1). */
  private pendingSteering(): number {
    return this.injections?.pending?.() ?? 0;
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
  private async runStep(seams: Seams, retries: number): Promise<StepResult> {
    this.injectPending(seams);
    const started = await this.generate(seams, this.buildRequest(seams));
    if (started.kind === "cancelled") return { kind: "cancelled" };
    if (started.kind === "failed") return { kind: "final", outcome: started.outcome };

    const thinking = new ThinkingBuffer(seams.session, this.holdbackChars());
    const stream = await this.consumeStream(started.stream, thinking, this.guardFor(), retries);
    // Stream-end release: trailing reasoning (providers stream it AFTER the
    // finish frame), a thinking-only stream and a mid-stream cancel all persist
    // here, ahead of the appends below. W1510 moved the POLICY into
    // `repetition-cut.ts` (discard the attempt, or keep the prefix before the
    // onset); a healthy stream still takes the plain `flush()` path.
    stream.prunedChars = releaseAfterStream(stream, thinking, seams.session).prunedChars;
    // The Done event is deferred to this point, so any late thinking still
    // lands before the reply on the wire.
    if (stream.doneMessage !== null) this.emit(doneEvent(stream.doneMessage));
    return this.finishStep(seams, stream);
  }

  /**
   * W1510: how much text is held back so a truncation can land on the true
   * onset. Only the truncation arm uses it; while the retry budget lasts the
   * attempt is discarded whole and nothing needs holding.
   */
  private holdbackChars(): number {
    return this.diagnostics?.holdbackChars ?? 0;
  }

  /** W1510: the guard for THIS step (null = model out of scope); rebuilt per step. */
  private guardFor(): RepetitionGuard | null {
    if (this.repetition === null) return null;
    return createRepetitionGuard(this.config.model, this.repetition);
  }

  /**
   * Consume the response stream. A cancel drops the partial turn (no
   * incomplete AssistantMessage is flushed); a failed / torn stream records the
   * matching terminal state instead of pretending success.
   *
   * W1510: every `text` AND `thinking` delta is fed to the DeepSeek repetition
   * guard, on its own channel. Reasoning must be covered: the production
   * incident (session `--src-unreg--`) collapsed entirely inside `reasoning`
   * while the answer text stayed healthy, so a text-only guard would never have
   * fired. When the guard convicts, the stream is abandoned exactly like a
   * cancel — the degenerate partial output is DISCARDED, never appended, and the
   * buffered reasoning burst is dropped with it — and the verdict is carried out
   * on `out.repetition` for the driver to act on.
   */
  private async consumeStream(
    stream: LlmStream,
    thinking: ThinkingBuffer,
    guard: RepetitionGuard | null,
    retries: number,
  ): Promise<StreamOutcome> {
    const out = emptyStreamOutcome();
    out.retries = retries;
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
        out.streamedText += event.text;
        this.emit({ kind: "text", delta: event.text });
        if (this.convicts(guard, event.text, "text", iter, out)) break;
      } else if (event.kind === "thinking") {
        thinking.push(event.text);
        out.reasoningText += event.text;
        this.emit({ kind: "thinking", delta: event.text });
        if (this.convicts(guard, event.text, "thinking", iter, out)) break;
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
    out.retriesUsed = out.repetition === null ? retries : out.repetitionPlan?.retriesUsed ?? retries;
    return out;
  }

  /**
   * W1510: feed one delta to the guard and, on a conviction, abandon the stream
   * (the provider iterator is closed; nothing is appended). The plan is decided
   * here because it depends on the attempt's own retry budget.
   */
  private convicts(
    guard: RepetitionGuard | null,
    delta: string,
    channel: RepetitionChannel,
    iter: AsyncIterator<StreamEvent>,
    out: StreamOutcome,
  ): boolean {
    const evidence = guard?.push(delta, channel) ?? null;
    if (evidence === null) return false;
    closeIterator(iter);
    const plan = planRepetition(out.retries, this.repetitionRetries);
    out.repetition = evidence;
    out.repetitionPlan = plan;
    return true;
  }

  /** Turn the consumed stream into the step verdict. */
  private async finishStep(seams: Seams, stream: StreamOutcome): Promise<StepResult> {
    if (stream.repetition !== null) return this.collapsed(seams, stream);
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
    // Deliberate divergence from the legacy loop (README §Divergences): a torn
    // stream after a done frame ends the turn instead of dispatching tools
    // under a sticky error outcome.
    if (stream.terminal !== null) return { kind: "final", outcome: stream.terminal };
    const cancelled = await this.dispatchToolCalls(seams, stream.toolCalls);
    return cancelled ? { kind: "cancelled" } : { kind: "continue" };
  }

  /**
   * W1510: this attempt collapsed into degenerate repetition. Which ported arm
   * runs is decided by the plan the guard already made: RETRY discards the whole
   * attempt (nothing was appended, so nothing about it can enter the context) and
   * re-issues it on a perturbed route; TRUNCATE keeps the healthy prefix and asks
   * the model to close the turn in ONE answer.
   */
  private async collapsed(seams: Seams, stream: StreamOutcome): Promise<StepResult> {
    const evidence = stream.repetition;
    const plan = stream.repetitionPlan;
    if (evidence === null || plan === null) return { kind: "cancelled" };
    const driver = this.driverFor(seams);
    driver.log(stream, plan);
    if (plan.action === "retry") {
      // The re-issued attempt must not repeat the same request verbatim.
      if (isPerturbable(seams.llm)) seams.llm.noteRetry();
      return { kind: "retry", evidence, retriesUsed: plan.retriesUsed };
    }
    await driver.wrapUp(evidence, plan);
    return { kind: "final", outcome: "interrupted" };
  }

  /** W1510: the driver for THIS turn — it holds the seams the recovery needs. */
  private driverFor(seams: Seams): CollapseDriver {
    return new CollapseDriver({
      session: seams.session,
      llm: seams.llm,
      signal: this.signal,
      diagnostics: this.diagnostics,
      sessionId: this.sessionId,
      model: this.config.model,
      buildRequest: () => this.buildRequest(seams),
      emit: (event) => this.emit(event),
    });
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
    // W855 #8b: retention is skipped for read tools, so the post-execute path
    // must know which tool produced each output (the model's call order).
    const names = new Map(calls.map((call) => [call.id, call.name] as const));
    const limit = Math.max(1, this.config.max_parallel_tool_calls);
    // W855: ONE cumulative budget per step, debited in model order.
    const step = newStepRetention();
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
      for (const output of raced.value)
        await this.recordToolResult(seams, output, answered, step, names.get(output.call_id) ?? null);
    }
    if (cancelled) this.synthesizeCancelledResults(seams, calls, answered);
    return cancelled;
  }

  /** Dispatch one batch concurrently; results keep the model's call order. */
  private dispatchBatch(registry: ToolRegistry, batch: readonly ToolCall[]): Promise<ToolOutput[]> {
    return Promise.all(batch.map((call) => dispatchCall(registry, toToolInput(call))));
  }

  private async recordToolResult(
    seams: Seams,
    output: ToolOutput,
    answered: Set<string>,
    step: StepRetention,
    toolName: string | null,
  ): Promise<void> {
    // W855 (B6): the LOG keeps the ORIGINAL value + a `surface` descriptor; the
    // MODEL/SSE face is rendered from it (retention's bounded window, or a
    // tool-authored truncation note). A failed spill keeps the original inline.
    // W855 #8b: `toolName` lets the policy exempt read tools (no read loop).
    const faces =
      this.retention === null ? faceToolOutput(output) : await retainToolResult(output, this.retention, step, toolName);
    this.emit(toolResultEvent(faces.face));
    answered.add(faces.logged.call_id);
    seams.session.append({
      type: "tool_result",
      id: faces.logged.call_id,
      value: faces.logged.value,
      error: faces.logged.error,
      ...(faces.logged.surface === undefined ? {} : { surface: faces.logged.surface }),
    });
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
      // W888: a mid-turn interjection (worker relay / inbox) is an injected row,
      // not the human's next typed message.
      seams.session.append({ type: "user_message", text: formatInjection(injection), origin: "steering" });
    }
    return pending.length;
  }

  /** Route one turn event to the sink; without a sink the host renders nothing. */
  private emit(event: LoopEvent): void {
    this.sink?.(event);
  }
}
