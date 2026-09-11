/**
 * `ToolRegistryImpl` — the dispatch pipeline of the tool seam.
 *
 * One dispatch runs four stages, in this order (a hard pipeline, not a
 * convention):
 *   1. **schema** — `args` are validated against `tool.spec().parameters`
 *      (`toolargs: code=schema …`, the tool never runs);
 *   2. **guard** — the guard chain runs in registration order and the FIRST
 *      non-`Allow` decision short-circuits (`denied: toolguard: …`) — a later
 *      `Allow` never un-denies an earlier `Deny`;
 *   3. **execute** — through `executeWith` when the tool overrides it, else
 *      `execute(args)`;
 *   4. **structure** — the result is a `ToolOutput`: canonical `value`, an
 *      optional authored `render`, captured `error`, and the guard `decision`
 *      as a first-class field.
 *
 * Errors are captured, never thrown across the seam (Rust parity:
 * `crates/tools/src/registry.rs`).
 *
 * **The verdict never lies (W738 P1)**: `decision` describes what the seam did
 * with the call, so a call the seam REFUSED to run (unknown tool, schema
 * rejection) is a `deny`, never an `allow` — an `allow` there would tell the
 * caller (and the audit log) that a rejected call passed every check. A tool that
 * did run and then failed keeps `allow`: the guards really did allow it and the
 * verdict is not a success flag.
 */

import type { Tool, ToolDecision, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolSpec } from "@celestea/core";

import { GUARD_ERROR_PREFIX, TOOLARG_ERROR_PREFIX, contractError, errorText, quoteMessage } from "./errors.js";
import { validateArgs } from "./schema.js";

const ALLOW: ToolDecision = { kind: "allow" };

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly guards: ToolGuard[] = [];

  register(tool: Tool): void {
    this.tools.set(tool.spec().name, tool);
  }

  addGuard(guard: ToolGuard): void {
    this.guards.push(guard);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Registered tool names, in registration order (`schemas()` sorts instead). */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** The guard chain, in evaluation order (diagnostics / compose assertions). */
  guardChain(): readonly ToolGuard[] {
    return this.guards;
  }

  schemas(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async dispatch(input: ToolInput): Promise<ToolOutput> {
    const tool = this.tools.get(input.name);
    if (tool === undefined) return refused(input.call_id, `unknown tool: ${input.name}`);

    const invalid = validateArgs(tool.spec().parameters, input.args);
    if (invalid !== null) {
      return refused(input.call_id, contractError(TOOLARG_ERROR_PREFIX, "schema", invalid.message));
    }

    const decision = await this.runGuards(input);
    if (decision.kind === "deny") return decisionFailure(input.call_id, "deny", decision.reason);
    if (decision.kind === "ask") return decisionFailure(input.call_id, "ask", decision.reason);

    return this.runTool(tool, input);
  }

  private async runTool(tool: Tool, input: ToolInput): Promise<ToolOutput> {
    try {
      const outcome =
        tool.executeWith === undefined
          ? { value: await tool.execute(input.args), render: null }
          : await tool.executeWith(input);
      return {
        call_id: input.call_id,
        value: outcome.value,
        render: outcome.render ?? humanRender(outcome.value),
        error: null,
        decision: ALLOW,
      };
    } catch (e) {
      return failure(input.call_id, errorText(e));
    }
  }

  private async runGuards(input: ToolInput): Promise<ToolDecision> {
    for (const guard of this.guards) {
      let decision: ToolDecision;
      try {
        decision = await guard.check(input);
      } catch (e) {
        decision = { kind: "deny", reason: contractError(GUARD_ERROR_PREFIX, "guard_error", errorText(e)) };
      }
      if (decision.kind !== "allow") return decision;
    }
    return ALLOW;
  }
}

/**
 * A call that ran and then failed: the guards allowed it, so the verdict is
 * `allow` — `error` carries the failure (`decision` is not a success flag).
 */
function failure(callId: string, error: string): ToolOutput {
  return { call_id: callId, value: null, render: null, error, decision: ALLOW };
}

/**
 * A call the seam REFUSED before execution (unknown tool / invalid args): the
 * verdict is a `deny` whose reason is the very error the caller sees, so
 * "refused" can never be reported as "allowed" (W738 P1).
 */
function refused(callId: string, error: string): ToolOutput {
  return { call_id: callId, value: null, render: null, error, decision: { kind: "deny", reason: error } };
}

function decisionFailure(callId: string, kind: "deny" | "ask", reason: string): ToolOutput {
  // Rust parity: a Deny surfaces as `denied: <reason>`, an Ask as `ask: <reason>`.
  return {
    call_id: callId,
    value: null,
    render: null,
    error: `${kind === "deny" ? "denied" : "ask"}: ${reason}`,
    decision: kind === "deny" ? { kind: "deny", reason } : { kind: "ask", reason },
  };
}

/** Registry seeded with tools + guards (guards run in the given order). */
export function createToolRegistry(tools: readonly Tool[] = [], guards: readonly ToolGuard[] = []): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  for (const tool of tools) registry.register(tool);
  for (const guard of guards) registry.addGuard(guard);
  return registry;
}

/**
 * Best-effort human-readable rendering of a successful result (Rust
 * `human_render`): a `{stdout, stderr, exit_code}` object condenses to a stream
 * summary; plain text and everything else keep the generic value view (`null`).
 */
export function humanRender(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const isStreamShape = "stdout" in obj || "stderr" in obj || "exit_code" in obj;
  if (!isStreamShape) return null;
  const lines: string[] = [];
  if (obj["exit_code"] !== undefined && obj["exit_code"] !== null) lines.push(`exit_code: ${String(obj["exit_code"])}`);
  if (typeof obj["stdout"] === "string" && obj["stdout"] !== "") lines.push(`stdout: ${obj["stdout"]}`);
  if (typeof obj["stderr"] === "string" && obj["stderr"] !== "") lines.push(`stderr: ${obj["stderr"]}`);
  const rendered = lines.join("\n").trimEnd();
  return rendered === "" ? null : rendered;
}

/** Stamp a guard denial reason with the contract prefix (compose-time helper). */
export function guardDenyReason(code: string, message: string): string {
  return contractError(GUARD_ERROR_PREFIX, code, quoteMessage(message));
}
