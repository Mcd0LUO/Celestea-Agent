/**
 * One turn, driven through the `AgentLoop` seam (Rust `runtime/src/run.rs`).
 *
 * Responsibilities, in order:
 *   1. **single concurrency slot** — a Runtime generation runs at most one turn;
 *      a second `runTurn` while busy is a [TurnBusyError] (409), never a queue;
 *   2. **receipt drain** — pending worker receipts are polled out of the host
 *      mailbox and appended to the session log BEFORE the input, so a receipt is
 *      real, model-visible history on the host's next turn (W232);
 *   3. **stream mapping** — every `LoopEvent` the loop emits is fed to the
 *      statusline tracker and mapped to one host frame, in log order;
 *   4. **cancel propagation** — the caller's `AbortSignal` is linked to the
 *      turn's own signal, which is (a) passed to the loop bindings and
 *      (b) provided on the turn scope under `TURN_ABORT_SERVICE`;
 *   5. **terminal state** — read back from the session log's own `turn_end`
 *      (the log is the single source of truth), never invented by the runtime.
 *   6. **usage ledger observation** (W728) — when a ledger is wired, the turn
 *      boundary is announced to it (pure observation; it can never throw).
 */

import {
  AGENT_LOOP_SERVICE,
  type AgentConfig,
  type AgentLoop,
  type Context,
  type InjectionSource,
  type PendingInjection,
  type LoopEvent,
  type SessionEvent,
  type SessionLog,
  type TurnOutcome,
} from "@celestea/core";
import { ComposeError, RuntimeReleasedError, TurnBusyError } from "./errors.js";
import type { FrameMapper, LoopEventSink, TurnFrame } from "./frames.js";
import type { TurnLedgerHooks } from "./ledger.js";
import type { StatusTracker } from "./status.js";
import { TURN_ABORT_SERVICE, TURN_SINK_SERVICE, USAGE_TRACKER_SERVICE } from "./tokens.js";
import type { UsageAccounting } from "./usage.js";

/** Host-side frame consumer (SSE publisher, CLI renderer, test collector). */
export type FrameSink = (frame: TurnFrame) => void;

export interface TurnOptions {
  /** Caller cancellation (linked into the turn's own signal). */
  signal?: AbortSignal;
  /** Frame consumer for this turn; absent = frames are dropped. */
  sink?: FrameSink;
}

/** Collaborators handed to a per-turn loop instance (Rust `with_bindings`). */
export interface LoopBindings {
  config: AgentConfig;
  signal: AbortSignal;
  sink: LoopEventSink;
  usage: UsageAccounting;
  /** Mid-turn injection source (absent = nothing can be injected). */
  injections?: InjectionSource;
}

/** Builds the per-turn `AgentLoop`; the host injects its concrete loop here. */
export type LoopFactory = (bindings: LoopBindings) => AgentLoop;

/** Anything waiting to be appended to the log (user text, receipt, relay). */
export type PendingReceipt = PendingInjection;

export interface TurnRunnerDeps {
  ctx: Context;
  /** Current session log (a rebind swaps the producer, so this is a getter). */
  session: () => SessionLog;
  status: StatusTracker;
  usage: UsageAccounting;
  agentConfig: AgentConfig;
  frameMapper: FrameMapper;
  /**
   * Usage ledger hooks (W728 §3 P0): the turn boundary is only known HERE, and
   * the ledger must not guess it from a counter. Observation only — the ledger
   * swallows its own IO failures, so a turn cannot fail because of bookkeeping.
   */
  ledger?: TurnLedgerHooks;
  /** Absent = the loop is resolved from `AGENT_LOOP_SERVICE` in the Context. */
  loopFactory?: LoopFactory;
  /**
   * The TURN-START drain (`next-turn` lane + session mailbox): receipts precede
   * the input (W232) and a follow-up queued while the session was idle is
   * appended before it (W515 §1: `placement: "queued"`).
   */
  drainPending?: () => PendingReceipt[];
  /**
   * The STEP-BOUNDARY source handed to the loop (`next-step` lane + session
   * mailbox). It carries `pending()` so the loop can refuse to close a turn
   * while a steering message is still waiting (W515 §1 invariant).
   */
  injections?: InjectionSource;
}

export class TurnRunner {
  private readonly deps: TurnRunnerDeps;
  private busy = false;
  private controller: AbortController | null = null;
  private turnNo = 0;
  private released = false;

  constructor(deps: TurnRunnerDeps) {
    this.deps = deps;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** The in-flight turn's signal, or null between turns. */
  get currentSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /** Turns started by this runner (diagnostics / tests). */
  get turnCount(): number {
    return this.turnNo;
  }

  /** Cancel the in-flight turn; returns false when nothing was running. */
  cancel(): boolean {
    if (this.controller === null) return false;
    this.controller.abort();
    return true;
  }

  /** Shutdown hook: stop driving, but keep no other state. */
  stop(): void {
    this.released = true;
    this.cancel();
  }

  async runTurn(input: string, opts: TurnOptions = {}): Promise<TurnOutcome> {
    if (this.released) throw new RuntimeReleasedError("the turn runner was stopped");
    if (this.busy) throw new TurnBusyError();
    this.busy = true;
    const controller = new AbortController();
    if (opts.signal !== undefined) linkAbort(opts.signal, controller);
    this.controller = controller;
    try {
      return await this.drive(input, opts, controller.signal);
    } finally {
      this.controller = null;
      this.busy = false;
    }
  }

  private async drive(input: string, opts: TurnOptions, signal: AbortSignal): Promise<TurnOutcome> {
    this.turnNo += 1;
    this.deps.status.beginTurn();
    const sink = this.makeSink(opts.sink);
    const scope = this.turnScope(signal, sink);
    const log = this.deps.session();
    this.injectReceipts(log);
    const start = log.events().length;
    const loop = this.resolveLoop(signal, sink);
    this.deps.ledger?.beginTurn(log);
    let failure: unknown = null;
    try {
      await loop.runTurn(scope, input);
    } catch (error) {
      failure = error;
    }
    try {
      const outcome = resolveOutcome(log.events(), start, signal, failure);
      this.deps.ledger?.endTurn(outcome);
      return outcome;
    } catch (error) {
      // A wiring failure still closes the ledger's turn before it propagates:
      // the usage already booked belongs to a turn that will have no total.
      this.deps.ledger?.endTurn("interrupted");
      throw error;
    }
  }

  /** Feed the tracker, then map the event onto one host frame. */
  private makeSink(userSink?: FrameSink): LoopEventSink {
    return (event: LoopEvent) => {
      this.observe(event);
      userSink?.(this.deps.frameMapper(event));
    };
  }

  /** W263口径: a step per tool CALL; deltas feed the rate window. */
  private observe(event: LoopEvent): void {
    if (event.kind === "text") this.deps.status.addChars(event.delta.length);
    else if (event.kind === "thinking") this.deps.status.addChars(event.delta.length);
    else if (event.kind === "tool_call") this.deps.status.addStep();
  }

  /**
   * The turn scope: the root context plus the per-turn services. A loop
   * constructed from the Context (no factory) can resolve the signal and sink
   * here without importing this package.
   */
  private turnScope(signal: AbortSignal, sink: LoopEventSink): Context {
    const scope = this.deps.ctx.scoped();
    scope.provide(TURN_ABORT_SERVICE, signal);
    scope.provide(TURN_SINK_SERVICE, sink);
    scope.provide(USAGE_TRACKER_SERVICE, this.deps.usage);
    return scope;
  }

  private resolveLoop(signal: AbortSignal, sink: LoopEventSink): AgentLoop {
    const factory = this.deps.loopFactory;
    if (factory !== undefined) {
      const injections = this.deps.injections;
      return factory({
        config: this.deps.agentConfig,
        signal,
        sink,
        usage: this.deps.usage,
        ...(injections === undefined ? {} : { injections }),
      });
    }
    const loop = this.deps.ctx.get<AgentLoop>(AGENT_LOOP_SERVICE);
    if (loop === undefined) {
      throw new ComposeError("no AgentLoop: pass a loopFactory or mount an agentLoopPlugin");
    }
    return loop;
  }

  /** Turn-start drain: receipts and interjections land BEFORE the input. */
  private injectReceipts(log: SessionLog): void {
    for (const receipt of this.drainPending()) {
      log.append({ type: "user_message", text: formatReceipt(receipt) });
    }
  }

  /** The single drain function shared by turn start and the step boundary. */
  private drainPending(): readonly PendingReceipt[] {
    return this.deps.drainPending?.() ?? [];
  }


}

/** `[from W1] content` — the receipt attribution the host log shows verbatim. */
export function formatReceipt(receipt: PendingReceipt): string {
  return receipt.from === "" ? receipt.text : `[from ${receipt.from}] ${receipt.text}`;
}

/** Link a caller signal into the turn's controller (idempotent, both directions safe). */
export function linkAbort(source: AbortSignal, target: AbortController): void {
  if (source.aborted) {
    target.abort();
    return;
  }
  source.addEventListener("abort", () => target.abort(), { once: true });
}

/**
 * The terminal state of the turn that started at `from`: the LAST `turn_end`
 * appended after that index, with legacy rows (missing outcome) defaulting to
 * `completed` exactly like the JSONL codec does.
 */
export function lastTurnEndOutcome(events: readonly SessionEvent[], from: number): TurnOutcome | null {
  for (let i = events.length - 1; i >= from; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.type === "turn_end") return ev.outcome ?? "completed";
  }
  return null;
}

/**
 * Resolve the outcome of a finished turn:
 *   1. a `turn_end` written by the loop wins — the log is the source of truth;
 *   2. otherwise the turn never terminated: a thrown error propagates (a wiring
 *      failure is not a terminal state), an aborted turn is `cancelled`, and a
 *      silently-stopped turn is `interrupted` (a torn turn is never `completed`).
 */
export function resolveOutcome(
  events: readonly SessionEvent[],
  from: number,
  signal: AbortSignal,
  failure: unknown,
): TurnOutcome {
  const fromLog = lastTurnEndOutcome(events, from);
  if (fromLog !== null) return fromLog;
  if (failure !== null && failure !== undefined) throw failure;
  return signal.aborted ? "cancelled" : "interrupted";
}
