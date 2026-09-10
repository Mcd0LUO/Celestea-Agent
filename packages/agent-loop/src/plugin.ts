/**
 * The agent loop as a PLUGIN (rule 3: everything is a plugin).
 *
 * The composition root mounts this plugin to provide a [DefaultAgentLoop] under
 * the well-known `AGENT_LOOP_SERVICE` token, exactly like `celestea-runtime`
 * provides `AgentLoopService(DefaultAgentLoop::…)` in Rust. The loop itself
 * still resolves `Llm` / `SessionLog` / `ToolRegistry` from the Context at turn
 * start, so a plugin never `new`s another package's implementation.
 *
 * Mount order matters at compose time: the three driver seams must be provided
 * BEFORE a turn runs (not before mounting — the loop resolves lazily).
 */

import { AGENT_LOOP_SERVICE, definePlugin, type AgentConfig, type Plugin } from "@celestea/core";
import { DefaultAgentLoop, type AgentLoopBindings } from "./loop.js";

/** Build a loop without touching a Context (hosts that drive turns directly). */
export function createAgentLoop(config: AgentConfig, bindings: AgentLoopBindings = {}): DefaultAgentLoop {
  return new DefaultAgentLoop(config, bindings);
}

/**
 * Provide a [DefaultAgentLoop] into the Context. A later mount of the same
 * token wins, so a test can swap in a scripted loop over the real one.
 */
export function agentLoopPlugin(
  config: AgentConfig,
  bindings: AgentLoopBindings = {},
  name = "celestea.agent-loop.DefaultAgentLoop",
): Plugin {
  return definePlugin(name, (ctx) => ctx.provide(AGENT_LOOP_SERVICE, new DefaultAgentLoop(config, bindings)));
}
