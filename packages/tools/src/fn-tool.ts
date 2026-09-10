/**
 * `fnTool` — a `Tool` whose behaviour is a plain async closure.
 *
 * Keeps each builtin definition terse while satisfying the `Tool` seam exactly
 * (Rust `fn_tool` in `crates/tools/src/builtin.rs`). Tools that need the full
 * `ToolInput` (call id) or author their own `render` build the object directly.
 */

import type { Tool, ToolSpec } from "@celestea/core";

export function fnTool(spec: ToolSpec, execute: (args: unknown) => Promise<unknown>): Tool {
  return { spec: () => spec, execute };
}

/** The authored-render variant of [fnTool] (canonical value + human view). */
export function renderTool(
  spec: ToolSpec,
  executeWith: Tool["executeWith"] & ((input: never) => Promise<{ value: unknown; render: string | null }>),
  execute: (args: unknown) => Promise<unknown>,
): Tool {
  return { spec: () => spec, execute, executeWith };
}
