/**
 * Test doubles for the workers tests: a scripted `AgentLoop` and a mailbox
 * helper. Only `core` types are involved, so these tests stay independent of the
 * sibling L1 packages that are being written in parallel.
 */

import {
  SESSION_LOG_SERVICE,
  type AgentLoop,
  type Context,
  type SessionLog,
} from "@celestea/core";
import { recordingSessionLog } from "./log.js";
import type { WorkerDrivers } from "./driver.js";
import type { ToolInput, ToolOutput, ToolRegistry, ToolSpec } from "@celestea/core";

export interface ScriptedTurn {
  assistant?: string;
  fail?: string;
}

export interface ScriptedLoop {
  loop: AgentLoop;
  /** Inputs seen, in order. */
  inputs: string[];
  /** Contexts handed to the loop (per-worker Context with its own log). */
  contexts: Context[];
  /** Blocks a turn until `release()` is called (driver concurrency tests). */
  gate: { wait: () => Promise<void>; release: () => void };
  /** Logs the loop appended to, in call order. */
  logs: SessionLog[];
}

/** An `AgentLoop` that writes a protocol-valid turn into the context's log. */
export function scriptedLoop(plan?: (input: string, turn: number) => ScriptedTurn): ScriptedLoop {
  const inputs: string[] = [];
  const contexts: Context[] = [];
  const logs: SessionLog[] = [];
  let releaseGate: (() => void) | null = null;
  let gatePromise: Promise<void> | null = null;
  const gate = {
    wait: (): Promise<void> => {
      gatePromise ??= new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return gatePromise;
    },
    release: (): void => {
      releaseGate?.();
      gatePromise = null;
      releaseGate = null;
    },
  };
  const loop: AgentLoop = {
    async runTurn(ctx: Context, input: string): Promise<void> {
      inputs.push(input);
      contexts.push(ctx);
      const log = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
      if (log === undefined) throw new Error("scripted loop: no session log");
      logs.push(log);
      const turnId = log.nextTurnId();
      log.append({ type: "turn_start", id: turnId });
      log.append({ type: "user_message", text: input });
      const step = plan?.(input, inputs.length) ?? {};
      if (step.fail !== undefined) throw new Error(step.fail);
      log.append({ type: "assistant_message", text: step.assistant ?? `echo:${input}` });
      log.append({ type: "turn_end", id: turnId, outcome: "completed" });
    },
  };
  return { loop, inputs, contexts, logs, gate };
}

/** A complete driver seam set around one scripted loop. */
export function scriptedDrivers(scripted: ScriptedLoop, tools: ToolRegistry | null = null): WorkerDrivers {
  return {
    llm: { generate: () => Promise.reject(new Error("scripted drivers: no llm calls")) },
    tools: tools ?? emptyRegistry(),
    agentLoop: scripted.loop,
  };
}

/** A recording `ToolRegistry`: registration order is what the plugin tests assert. */
export class FakeToolRegistry implements ToolRegistry {
  readonly order: string[] = [];

  register(tool: { spec(): ToolSpec }): void {
    this.order.push(tool.spec().name);
  }

  addGuard(): void {
    return undefined;
  }

  get(): undefined {
    return undefined;
  }

  schemas(): ToolSpec[] {
    return [];
  }

  dispatch(input: ToolInput): Promise<ToolOutput> {
    return Promise.resolve({ call_id: input.call_id, value: null, render: null, error: null, decision: null });
  }
}

export function emptyRegistry(): ToolRegistry {
  return {
    register: () => undefined,
    addGuard: () => undefined,
    get: () => undefined,
    schemas: () => [],
    dispatch: (input) => Promise.resolve({ call_id: input.call_id, value: null, render: null, error: null, decision: null }),
  };
}

/** Wait until `cond` holds (driver wake-up assertions), with a hard ceiling. */
export async function waitUntil(cond: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("waitUntil: condition never held");
}

/** A registry bound to an in-memory-only table with a recording log factory. */
export function memoryRegistryOptions(): { tsvPath: null; logFactory: typeof recordingSessionLog; now: () => number } {
  return { tsvPath: null, logFactory: recordingSessionLog, now: () => Date.parse("2026-09-10T00:00:00Z") };
}
