/**
 * `@celestea/workers` — worker orchestration as plugins over the `core` seams.
 *
 * Responsibility: keep the state of every worker THIS process owns
 * (`registry.tsv` parse/serialize + in-memory table with per-process row
 * ownership), address conversations (`SessionRegistry`), deliver messages
 * between them (`SessionMailbox` with park/wake semantics), drive each worker
 * through a serial mailbox event loop, mechanically close the loop with a report
 * file plus a one-line receipt, settle each row's lifecycle state (W736: DONE /
 * FAILED are written, they are no longer a permanent RUNNING), keep the liveness
 * verdict in an independent watchdog plugin, and expose the three orchestration
 * tools (`spawn_worker` / `session_send_message` / `worker_status`).
 *
 * Dependency direction: workers -> core only. The driver seams (`Llm`,
 * `ToolRegistry`, `AgentLoop`) and the worker session log are injected by the
 * composition root (`packages/runtime`), so this package never imports a sibling
 * L1 implementation (ARCHITECTURE.md §1.3 D2).
 *
 * Module map (Rust -> TS):
 *   registry-tsv.ts  registry.tsv row parse/serialize/summary  (workers/types.rs)
 *   types.ts         session/mailbox value types + UTC stamps  (workers/types.rs)
 *   log.ts           default worker session log (records only)
 *   sessions.ts      SessionRegistry + id/title/workspace resolve  (session/registry.rs)
 *   mailbox.ts       SessionMailbox: queue + park/wake         (session/mailbox.rs)
 *   registry.ts      WorkerRegistry: table state + driver seams (workers/registry.rs)
 *   driver.ts        mailbox event loop (brief -> park -> deliver)  (registry.rs:299-450)
 *   receipt.ts       report file + WORKER_<wid>_DONE/FAILED receipt (registry.rs:551-620)
 *   watchdog.ts      liveness judgement as an independent plugin   (workers/watchdog.rs)
 *   tools.ts         the three worker tools + contract specs   (workers/tools.rs)
 *   plugin.ts        Context registration (WORKER_REGISTRY_SERVICE)  (workers/plugin.rs)
 *
 * Public API = this file. Everything else is an internal module.
 */

export * from "./registry-tsv.js";
export * from "./types.js";
export * from "./log.js";
export * from "./sessions.js";
export * from "./mailbox.js";
export * from "./registry.js";
export * from "./driver.js";
export * from "./receipt.js";
export * from "./watchdog.js";
export * from "./tools.js";
export * from "./plugin.js";
