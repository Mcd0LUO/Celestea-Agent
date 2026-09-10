/**
 * `compact` — context compaction (Rust `celestea_studio/src/compact.rs`).
 *
 * W259 semantics: only COMPLETE turns count, the newest K survive renumbered,
 * and the pre-compaction log is always recoverable from the single-copy
 * `cli-main.jsonl.precompact` backup. The summary itself is produced through
 * the `Llm` seam (see ./summarize.ts), so this package needs no provider.
 */

export * from "./plan.js";
export * from "./transcript.js";
export * from "./rewrite.js";
export * from "./summarize.js";
export * from "./run.js";
