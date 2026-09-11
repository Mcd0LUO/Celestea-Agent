/**
 * The worker driver: one mailbox event loop per driven session (Rust W232,
 * `WorkerRegistry::run_driver_loop`).
 *
 * Sequence per driven worker:
 *   1. **brief turn** — run the self-contained brief once, state `in-turn`;
 *   2. **receipt** — mechanically close the loop (report file + mailbox receipt)
 *      exactly once, Ok or Err alike;
 *   3. **mailbox loop** — park on `mailbox.recv(sid)` in state `idle`; every
 *      arriving message becomes the input of a new serial turn (so the same
 *      worker never runs two turns at once), then park again;
 *   4. **exit** — the session was removed, or the stop signal fired. Exiting
 *      always releases the park, which is what makes shutdown bounded, and
 *      reports the reason through `onExit` so the registry can settle the row
 *      (W736): a loop that ends without a verdict means the worker never
 *      delivered.
 *
 * The driver resolves the three driver seams (`Llm`, `ToolRegistry`,
 * `AgentLoop`) from the host and re-provides them into a FRESH per-worker
 * Context whose `SessionLog` is the worker's own — that is how one shared loop
 * instance drives many conversations without ever seeing the host's history.
 */

import {
  AGENT_LOOP_SERVICE,
  Context,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type AgentLoop,
  type Llm,
  type ToolRegistry,
} from "@celestea/core";
import type { SessionMailbox } from "./mailbox.js";
import type { SessionRegistry } from "./sessions.js";
import type { WorkerSession } from "./types.js";

/** The three seams a driven worker needs (Rust `attach_drivers`). */
export interface WorkerDrivers {
  llm: Llm;
  tools: ToolRegistry;
  agentLoop: AgentLoop;
}

/** Per-worker Context: host seams (shared) + this worker's own session log. */
export function workerContext(session: WorkerSession, drivers: WorkerDrivers): Context {
  const ctx = Context.root();
  ctx.provide(LLM_SERVICE, drivers.llm);
  ctx.provide(TOOL_REGISTRY_SERVICE, drivers.tools);
  ctx.provide(SESSION_LOG_SERVICE, session.log);
  ctx.provide(AGENT_LOOP_SERVICE, drivers.agentLoop);
  return ctx;
}

export type WorkerState = "idle" | "in-turn";

/** Why a driver loop ended (W736: `onExit` reports it to the registry). */
export type DriverExit = "session-gone" | "stopped";

export interface DriverLoopOptions {
  sid: string;
  brief: string;
  drivers: WorkerDrivers;
  sessions: SessionRegistry;
  mailbox: SessionMailbox;
  /** Stop signal: fires on `stopDriver` / `abortAllNow` / registry release. */
  signal: AbortSignal;
  /** State annotation sink (the registry writes the `state=` tsv token). */
  onState: (sid: string, state: WorkerState) => void;
  /** Receipt protocol closure; runs once after the brief turn. */
  receipt?: (sid: string, failure: string | null) => void;
  /**
   * W736: the loop ended without settling its own row (session vanished, or the
   * stop signal fired). The registry turns a still-RUNNING row into FAILED —
   * a row already settled by its receipt is left untouched.
   */
  onExit?: (sid: string, reason: DriverExit) => void;
}

/** Drive one worker until its session disappears or the stop signal fires. */
export async function runDriverLoop(opts: DriverLoopOptions): Promise<void> {
  const session = opts.sessions.get(opts.sid);
  if (session === undefined) {
    opts.onExit?.(opts.sid, "session-gone");
    return;
  }
  const ctx = workerContext(session, opts.drivers);
  const failure = await runBriefTurn(opts, ctx);
  opts.receipt?.(opts.sid, failure);
  await runMailboxLoop(opts, ctx);
  opts.onExit?.(opts.sid, exitReason(opts));
}

/** A removed session is the crash path; anything else is a deliberate stop. */
function exitReason(opts: DriverLoopOptions): DriverExit {
  return opts.sessions.get(opts.sid) === undefined ? "session-gone" : "stopped";
}

async function runBriefTurn(opts: DriverLoopOptions, ctx: Context): Promise<string | null> {
  opts.onState(opts.sid, "in-turn");
  try {
    await opts.drivers.agentLoop.runTurn(ctx, opts.brief);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** Park -> wake -> deliver, until the session goes away or the stop fires. */
async function runMailboxLoop(opts: DriverLoopOptions, ctx: Context): Promise<void> {
  while (!opts.signal.aborted && opts.sessions.get(opts.sid) !== undefined) {
    opts.onState(opts.sid, "idle");
    const msg = await opts.mailbox.recv(opts.sid, opts.signal);
    if (msg === null || opts.sessions.get(opts.sid) === undefined) return;
    opts.onState(opts.sid, "in-turn");
    try {
      await opts.drivers.agentLoop.runTurn(ctx, msg.content);
    } catch {
      // A failed mailbox turn must not kill the loop: the worker stays
      // addressable (the next message is a new turn), exactly like Rust.
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
