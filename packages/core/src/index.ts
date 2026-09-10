/**
 * `@celestea/core` — the semantic kernel: the frozen contract types, the
 * serde-exact SessionEvent codec, the model-visible Message model, and the
 * plugin seams (Plugin / Context / EventBus / SessionLog / Llm / ToolGuard).
 *
 * Dependency direction: core imports NOTHING from the other packages. Every
 * concrete implementation (session log, llm provider, tools, agent loop) is a
 * plugin mounted into a Context at compose time.
 *
 * Module map:
 *   types.ts         frozen P0 contracts (SessionEvent union, SSE, endpoints…)
 *   message.ts       Role / Content / ToolCall / Message / Usage   (message.rs)
 *   stream.ts        ModelRequest / StreamEvent / LlmError         (message.rs, llm.rs)
 *   session-event.ts SessionEvent JSONL codec (validate / serialize)  (session_log.rs)
 *   session-log.ts   SessionLog seam
 *   plugin.ts        Plugin seam + NamedRegistry                   (plugin.rs)
 *   context.ts       Context service container                     (context.rs)
 *   event-bus.ts     EventBus seam (on/bail/waterfall)             (event_bus.rs)
 *   llm.ts           Llm seam + LlmRegistry                        (llm.rs)
 *   tool.ts          Tool / ToolGuard / ToolRegistry seams         (tool.rs)
 *   agent.ts         AgentLoop seam + AgentConfig                  (agent.rs)
 *   json.ts          JSON helpers + serde-exact text
 *   sse-bus.ts       SDK-side SSE broadcast bus
 *   redact.ts        secret redaction for fixtures / reports
 *   repo.ts          repository-relative path helpers
 *   errors.ts        shared error types
 *   contracts/       contract-file loaders (frozen data in contracts/)
 */

export * from "./types.js";
export * from "./message.js";
export * from "./stream.js";
export * from "./session-event.js";
export * from "./session-log.js";
export * from "./plugin.js";
export * from "./context.js";
export * from "./event-bus.js";
export * from "./llm.js";
export * from "./tool.js";
export * from "./agent.js";
export * from "./json.js";
export * from "./sse-bus.js";
export * from "./errors.js";
export * from "./redact.js";
export * from "./repo.js";
export * from "./contracts/index.js";
