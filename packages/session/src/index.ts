/**
 * `@celestea/session` — the SessionLog implementations (plugin form).
 *
 * Responsibility: record SessionEvents in insertion order (in memory and as an
 * append-only JSONL file), replay/repair a persisted log, own the monotonic
 * turn-id counter, and project the two message views:
 *   - the Studio projection (`projectMessages`, per-event, golden vs Rust HTTP);
 *   - the engine model-visible history (`deriveMessages`, Rust derive_messages).
 *
 * This package depends only on `@celestea/core` and is consumed by mounting
 * `inMemorySessionLogPlugin` / `persistentSessionLogPlugin` into a Context.
 *
 * Module map:
 *   log/derive.ts      derive_messages + balance_tool_calls   (session/log.rs)
 *   log/memory.ts      InMemorySessionLog                     (session/log.rs)
 *   log/file.ts        JSONL file replay / naming             (session/persistent.rs)
 *   log/persistent.ts  PersistentSessionLog                   (session/persistent.rs)
 *   plugin.ts          Context registration (SESSION_LOG_SERVICE)
 *   jsonl.ts           file-level parse/serialize + codec re-exports
 *   messages.ts        Studio projection + deriveMessages facade
 *   turn-id.ts         turn id math + audit
 *   replay.ts          replay analysis + SSE transcript derivation
 *   checkpoint.ts      checkpoint.json sidecar: shape + atomic read/write
 *   checkpoint-log.ts  SessionLog decorator: turn boundary -> checkpoint
 *   checkpoint-recovery.ts  boot decision table (§1.2.3), append-only repair
 */

export * from "./log/derive.js";
export * from "./log/memory.js";
export * from "./log/file.js";
export * from "./log/persistent.js";
export * from "./plugin.js";
export * from "./jsonl.js";
export * from "./messages.js";
export * from "./turn-id.js";
export * from "./replay.js";
export * from "./checkpoint.js";
export * from "./checkpoint-log.js";
export * from "./checkpoint-recovery.js";
