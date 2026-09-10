/**
 * Driver-seam resolution for one turn.
 *
 * The loop never imports an implementation: it resolves the three seams the
 * Rust `run_turn` resolves from the shared `Context` — `Llm` (how to generate),
 * `SessionLog` (where the single source of truth lives) and `ToolRegistry`
 * (how to dispatch tool calls) — and fails loudly when the composition root
 * forgot one. Same three services, same order, as `crates/agent-loop/src/loop.rs`.
 */

import {
  AgentError,
  LLM_SERVICE,
  SESSION_LOG_SERVICE,
  TOOL_REGISTRY_SERVICE,
  type Context,
  type Llm,
  type SessionLog,
  type ToolCall,
  type ToolInput,
  type ToolOutput,
  type ToolRegistry,
} from "@celestea/core";
import { errorMessage } from "./cancel.js";

/** The three seams a turn resolves from the Context. */
export interface Seams {
  llm: Llm;
  session: SessionLog;
  registry: ToolRegistry;
}

/** Resolve the driver seams; a missing service is a wiring bug, not a state. */
export function resolveSeams(ctx: Context): Seams {
  const llm = ctx.get<Llm>(LLM_SERVICE);
  if (llm === undefined) throw new AgentError("missing LlmService in context");
  const session = ctx.get<SessionLog>(SESSION_LOG_SERVICE);
  if (session === undefined) throw new AgentError("missing SessionLog service in context");
  const registry = ctx.get<ToolRegistry>(TOOL_REGISTRY_SERVICE);
  if (registry === undefined) throw new AgentError("missing ToolRegistryService in context");
  return { llm, session, registry };
}

export function toToolInput(call: ToolCall): ToolInput {
  return { call_id: call.id, name: call.name, args: call.args };
}

/**
 * Dispatch one call, containing a seam violation: `ToolRegistry.dispatch`
 * captures tool errors in `ToolOutput.error` and must not throw, so an escaping
 * exception would otherwise leave the turn without a terminal state. Rust can
 * rely on `?`-free unwrapping; TS keeps the same totality explicitly.
 */
export async function dispatchCall(registry: ToolRegistry, input: ToolInput): Promise<ToolOutput> {
  try {
    return await registry.dispatch(input);
  } catch (error) {
    return { call_id: input.call_id, value: null, render: null, error: errorMessage(error), decision: null };
  }
}
