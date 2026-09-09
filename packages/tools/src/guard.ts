/**
 * ToolGuard seam (P2 placeholder).
 *
 * The real guard is CELESTEA_TOOL_ROOTS-based path whitelisting
 * (crates/tools/src/guard.rs, 16 cases). P0 only freezes the decision shape so
 * callers can be written against it now.
 */

import type { ToolDecision } from "@celestea/core";

export interface GuardContext {
  /** Roots allowed for filesystem reads/writes (CELESTEA_TOOL_ROOTS). */
  roots: readonly string[];
  /** Session working directory. */
  workdir: string;
}

export interface ToolGuard {
  check(toolName: string, args: unknown): ToolDecision;
}

export class UnimplementedGuard implements ToolGuard {
  check(toolName: string): ToolDecision {
    return { kind: "ask", reason: `guard not implemented in P0 (tool=${toolName})` };
  }
}

export const GUARD_TEST_CASE_COUNT = 16;
