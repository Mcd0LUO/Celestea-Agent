/**
 * Tool registry built from the frozen contract (contracts/tools.json).
 *
 * P0 ships the registry + guard seam only; the real executors land in P2.
 * The 10 tool names are contract: they must match GET /api/tools exactly.
 */

import { loadTools } from "@celestea/core";
import type { ToolDecision, ToolSpec } from "@celestea/core";

export interface Tool {
  spec(): ToolSpec;
  /** P2 fills this in; P0 always answers `ask` so nothing runs by accident. */
  decide(args: unknown): ToolDecision;
}

export class ContractToolRegistry {
  private readonly byName = new Map<string, Tool>();

  register(tool: Tool): void {
    this.byName.set(tool.spec().name, tool);
  }

  /** Sorted by name, exactly like ToolRegistry::schemas (crates/tools/src/registry.rs:41-46). */
  schemas(): ToolSpec[] {
    return [...this.byName.values()].map((t) => t.spec()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  names(): string[] {
    return this.schemas().map((s) => s.name);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }
}

export interface StubToolOptions {
  /** P2 replaces this with the real guarded decision. */
  decision?: ToolDecision;
}

export function stubTool(spec: ToolSpec, opts: StubToolOptions = {}): Tool {
  const decision = opts.decision ?? { kind: "ask", reason: "P0 skeleton: executor not implemented" };
  return { spec: () => spec, decide: () => decision };
}

/** Build the 10-tool registry from the frozen contract. */
export function registryFromContract(): ContractToolRegistry {
  const reg = new ContractToolRegistry();
  for (const t of loadTools().tools) {
    reg.register(stubTool({ name: t.name, description: t.description, parameters: t.parameters }));
  }
  return reg;
}

export const TOOL_COUNT = 10;
