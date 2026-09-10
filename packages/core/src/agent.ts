/**
 * AgentLoop seam — port of `crates/core/src/agent.rs`.
 *
 * The loop drives one user turn against a Context: append to the session log,
 * step the model, dispatch tool calls, write the final assistant message. The
 * concrete loop lives in packages/agent-loop and is plugged in at compose time.
 */

import type { Context } from "./context.js";

export interface AgentConfig {
  model: string;
  system_prompt: string;
  max_steps: number;
  max_parallel_tool_calls: number;
  /** Model context window in tokens; 0 disables context trimming. */
  context_window_tokens: number;
  /** Trim factor (0..=1) of the window that triggers old-message trimming. */
  context_trim_threshold: number;
  /** How many most-recent messages to keep when trimming (plus system). */
  context_keep_recent: number;
}

/** Rust `AgentConfig::default()` — values are contract (identity prompt included). */
export function defaultAgentConfig(): AgentConfig {
  return {
    model: "deepseek-chat",
    system_prompt: "You are celestea, an AI agent. You are concise, accurate and direct.",
    max_steps: 16,
    max_parallel_tool_calls: 4,
    context_window_tokens: 65_536,
    context_trim_threshold: 0.8,
    context_keep_recent: 10,
  };
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentLoop {
  /** Drive one user turn; rejects with [AgentError] on a terminal failure. */
  runTurn(ctx: Context, userInput: string): Promise<void>;
}

/** Well-known token for the agent loop service in a Context. */
export const AGENT_LOOP_SERVICE = "celestea.core.AgentLoop";
