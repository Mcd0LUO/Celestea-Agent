/**
 * Tool-spec parity: the IMPLEMENTATION registry vs `contracts/tools.json`
 * (W744, audit D2 — only `run_code` used to be compared).
 *
 * `GET /api/tools` serves `ToolRegistry.schemas()` of the composed engine, so
 * the registry is the implementation of record. Every field the model sees
 * (name, description, parameters) is compared here, and a finding names the
 * tool, the field and the JSON path of the difference.
 */

import { firstJsonDiff, type ToolSpec, type ToolsContract } from "@celestea/core";

export interface ToolParityFinding {
  tool: string;
  field: "name" | "description" | "parameters";
  detail: string;
}

/** Compare every implementation spec with its frozen contract entry. */
export function compareToolSpecs(contract: ToolsContract, impl: readonly ToolSpec[]): ToolParityFinding[] {
  const byName = new Map(contract.tools.map((tool) => [tool.name, tool]));
  const out: ToolParityFinding[] = [];
  for (const spec of impl) {
    const entry = byName.get(spec.name);
    if (entry === undefined) {
      out.push({ tool: spec.name, field: "name", detail: `the registry registers '${spec.name}', which contracts/tools.json does not declare (declared: ${contract.tools.map((t) => t.name).join(", ")})` });
      continue;
    }
    if (spec.description !== entry.description) {
      out.push({ tool: spec.name, field: "description", detail: `description drifted: registry=${JSON.stringify(spec.description)} contract=${JSON.stringify(entry.description)}` });
    }
    const diff = firstJsonDiff(entry.parameters, spec.parameters, `$.tools[${spec.name}].parameters`);
    if (diff !== null) out.push({ tool: spec.name, field: "parameters", detail: `parameters drifted at ${diff}` });
  }
  return out;
}

/** Contract tools that no implementation spec covers (the other half of 100%). */
export function uncoveredTools(contract: ToolsContract, impl: readonly ToolSpec[], covered: readonly string[]): ToolParityFinding[] {
  const names = new Set([...impl.map((spec) => spec.name), ...covered]);
  return contract.tools
    .filter((tool) => !names.has(tool.name))
    .map((tool) => ({ tool: tool.name, field: "name", detail: `contracts/tools.json declares '${tool.name}' but no implementation registry/source covers it` }));
}

/** One-line rendering of the findings (empty string when parity holds). */
export function describeFindings(findings: readonly ToolParityFinding[]): string {
  return findings.map((f) => `tool '${f.tool}' field ${f.field}: ${f.detail}`).join("\n");
}
