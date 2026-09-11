/**
 * `@celestea/runtime` — the assembly layer (L2): `compose(profile)` mounts every
 * plugin into one `Context` and hands back a wired, runnable engine generation.
 *
 * Responsibility: assembly (plugin mount order, seam resolution, sanitized
 * config), lifecycle (hot swap, session rebind, idempotent shutdown, explicit
 * release), turn driving (single concurrency slot, frame stream,
 * cancellation, terminal state from the log), and the statusline
 * (`StatusTracker` + `UsageTracker`).
 *
 * Dependency direction: runtime -> core + L1 packages. Assembly stays
 * injection-based (the concrete agent loop arrives through
 * `ComposeConfig.loopFactory`, the frame mapper through `frameMapper`, the
 * session log through `sessionBinding`/plugins, and the worker registry either
 * through a host plugin or the built-in worker wiring); the two L1 edges this
 * package does import are the worker seam (`@celestea/workers`) and the
 * session-log/checkpoint contract (`@celestea/session`, E §1.3 P0).
 *
 * Module map (Rust -> TS):
 *   profile.ts         frozen 12-key profile + compose step list  (runtime/config.rs)
 *   agent-config.ts    profile -> AgentConfig + step floor       (compose.rs:196-204)
 *   sanitize.ts        sanitized config projection for /api/config
 *   usage.ts           UsageTracker (latest/total/cache_hit_ratio) (agent-loop/loop.rs)
 *   status.ts          StatusTracker + statusline payload        (studio/main.rs:253-620)
 *   frames.ts          LoopEvent -> SSE frame mapping            (studio/main.rs:667-713)
 *   session-binding.ts session id/dir + log opener + rebind      (compose.rs:131-146)
 *   turn-runner.ts     one turn: busy slot, sink, cancel, outcome (runtime/run.rs)
 *   inbox.ts           per-session mid-turn injection queue      (W513)
 *   session-registry.ts session id -> independent Runtime        (W513)
 *   worker-wiring.ts   worker driver seams + host receipt drain  (compose.rs:148-193)
 *   runtime.ts         Runtime handles + lifecycle               (compose.rs:44-281)
 *   recovery.ts        boot recovery: close a turn a crash left open (E §1.3)
 *   gen.ts             Gen + GenerationHub (hot swap)            (studio/main.rs:340-420)
 *   compose.ts         compose(config) — mount order             (runtime/compose.rs)
 *   compact/           context compaction (W259)                 (studio/src/compact.rs)
 *   tokens.ts          runtime service tokens
 *   errors.ts          TurnBusyError / RuntimeReleasedError / ComposeError
 *
 * Public API = this file. Everything else is an internal module.
 */

export * from "./profile.js";
export * from "./tokens.js";
export * from "./errors.js";
export * from "./agent-config.js";
export * from "./sanitize.js";
export * from "./usage.js";
export * from "./pricing.js";
export * from "./ledger.js";
export * from "./ledger-llm.js";
export * from "./status.js";
export * from "./frames.js";
export * from "./session-binding.js";
export * from "./turn-runner.js";
export * from "./inbox.js";
export * from "./session-registry.js";
export * from "./recovery.js";
export * from "./worker-wiring.js";
export * from "./runtime.js";
export * from "./gen.js";
export * from "./compose.js";
export * from "./compact/index.js";
