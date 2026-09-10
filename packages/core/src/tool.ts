/**
 * Tool + ToolGuard seams — port of `crates/core/src/tool.rs`.
 *
 * A guard is the "waterfall" step of dispatch: it may Allow, Deny or Ask, and
 * the first non-Allow decision short-circuits the chain. The registry runs the
 * guard chain and then the tool, capturing errors instead of throwing.
 *
 * `ToolDecision` keeps the P0 TS shape (`{kind:"allow"}` / `{kind:"deny",reason}`
 * / `{kind:"ask",reason}`) declared in `./types.ts` — it is the contract the
 * tools package and the API surface already use, and it is the same three
 * variants as Rust's enum.
 */

import type { ToolDecision, ToolSpec } from "./types.js";

export interface ToolInput {
  call_id: string;
  name: string;
  args: unknown;
}

/** `Tool::execute_with` result: canonical value + optional authored rendering. */
export interface ToolExecOutcome {
  value: unknown;
  render: string | null;
}

export interface ToolOutput {
  call_id: string;
  /** Canonical, machine-readable result value. Never a display rendering. */
  value: unknown;
  /** Human-readable rendering, decoupled from the canonical value. */
  render: string | null;
  error: string | null;
  /** The guard verdict for this dispatch (null when no guard ran). */
  decision: ToolDecision | null;
}

export interface Tool {
  spec(): ToolSpec;
  execute(args: unknown): Promise<unknown>;
  /**
   * W255 run_code: tools that need the caller-assigned `call_id` (run_code
   * embeds it in `<parent>:c<n>` sub-call ids) or that author their own
   * `render` override this; the default delegates to `execute`.
   */
  executeWith?(input: ToolInput): Promise<ToolExecOutcome>;
}

export interface ToolGuard {
  /**
   * Rust `ToolGuard::check`. Note the Rust guard chain collects the FIRST
   * non-Allow verdict, so a later Allow never un-denies an earlier Deny.
   */
  check(input: ToolInput): Promise<ToolDecision>;
}

export interface ToolRegistry {
  register(tool: Tool): void;
  addGuard(guard: ToolGuard): void;
  get(name: string): Tool | undefined;
  /**
   * The model-facing specs. Sorted by name, exactly like Rust
   * `ToolRegistry::schemas` (crates/tools/src/registry.rs) — a deterministic
   * order keeps the prompt prefix stable across registrations.
   */
  schemas(): ToolSpec[];
  /** Run the guard chain, then the tool. Errors are captured, not thrown. */
  dispatch(input: ToolInput): Promise<ToolOutput>;
}

/** Well-known tokens for the tool services in a Context. */
export const TOOL_REGISTRY_SERVICE = "celestea.core.ToolRegistry";
export const TOOL_GUARD_SERVICE = "celestea.core.ToolGuard";
