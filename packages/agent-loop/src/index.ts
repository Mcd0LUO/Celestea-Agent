/**
 * `@celestea/agent-loop` — the AgentLoop implementation: turn/step driving,
 * context-budget trimming, cooperative cancellation and the five terminal
 * states, as a plugin over the `core` seams.
 *
 * Dependency direction: agent-loop -> core only. The loop resolves `Llm`,
 * `SessionLog` and `ToolRegistry` from the Context at turn start, so this
 * package never imports a provider, a storage backend or a tool implementation.
 *
 * Module map (Rust -> TS):
 *   loop.ts          DefaultAgentLoop, the step loop            (loop.rs)
 *   step.ts          per-step verdict types + folds             (loop.rs)
 *   seams.ts         Context -> Llm/SessionLog/ToolRegistry      (loop.rs:204-213)
 *   cancel.ts        AbortSignal checkpoints, synth. result text (loop.rs:181-200)
 *   context-trim.ts  token estimate + trim_context              (context.rs)
 *   usage.ts         UsageTracker                               (loop.rs:49-89)
 *   events.ts        LoopEvent builders + EventSink             (events.rs)
 *   thinking.ts      W252 thinking-burst aggregation            (loop.rs:165-171)
 *   plugin.ts        AGENT_LOOP_SERVICE registration            (runtime/src/compose.rs)
 *   sse.ts           LoopEvent -> SSE frame mapping             (studio/src/main.rs:667)
 *
 * Public API = this file. Everything else is an internal module.
 */

export * from "./loop.js";
export * from "./cancel.js";
export * from "./context-trim.js";
export * from "./usage.js";
export * from "./events.js";
export * from "./plugin.js";
export * from "./sse.js";
