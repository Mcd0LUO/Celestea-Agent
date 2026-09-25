/**
 * `run_code` — programmatic tool execution with a parent broker (W255;
 * TypeScript since W774, `crates/tools/src/run_code.rs`).
 *
 * One call = one round trip: the program runs under the *same* sandbox as
 * `run_shell`, its `tools.<name>(...)` bridge calls travel to this process as
 * one-line JSON on stdout, and each one is dispatched through the identical
 * `ToolRegistry` pipeline (schema → guards → execute) before the reply goes
 * back on stdin. The model sees only `main()`'s return value; the intermediate
 * rows stay in the session log as nested `ToolCall`/`ToolResult` events
 * (`id = "<parent>:c<n>"`, `parent_id = <parent>`), which `deriveMessages`
 * skips.
 *
 * Wiring is late-bound on purpose ([`RegistryHandle`]): the tool must be
 * registered *into* the registry it will dispatch through, so the handle is
 * bound right after registration (the `RegistryHandle` / `run_code_tool_with_handle`).
 */

import type { Sandbox, Tool, ToolExecOutcome, ToolInput, ToolRegistry, ToolSpec } from "@celestea/core";

import { descParam } from "../desc.js";
import { ToolFailure } from "../tool-failure.js";
import { brokerRun, type BrokerContext, type RunCodeEventSink } from "../run-code/broker.js";
import {
  DEFAULT_MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_LOG_BYTES,
  MAX_SUB_CALLS,
  MAX_SUB_OUTPUT_BYTES,
  RUN_CODE_ERROR_PREFIX,
  runCodeConfigFromEnv,
  type RunCodeConfig,
} from "../run-code/limits.js";

/**
 * Late-bound handle to the composed registry: `run_code` is registered before
 * the registry can be handed to it, so the assembly binds this afterwards and
 * dispatch resolves at execution time. The FIRST binding wins (legacy
 * `OnceLock<Weak<dyn ToolRegistry>>`).
 */
export class RegistryHandle {
  private registry: ToolRegistry | null = null;

  set(registry: ToolRegistry): void {
    if (this.registry === null) this.registry = registry;
  }

  resolve(): ToolRegistry | null {
    return this.registry;
  }
}

export interface RunCodeToolOptions {
  /** The execution boundary — the same provider `run_shell` runs under. */
  sandbox: Sandbox;
  /** Late-bound registry: sub-calls ride its guard + schema pipeline. */
  handle: RegistryHandle;
  /** Session-log sink for nested sub-call rows (optional). */
  events?: RunCodeEventSink;
  /** Tuning knobs; default = [`runCodeConfigFromEnv`]. */
  config?: RunCodeConfig;
}

/** Build the tool plus the handle the assembly must bind after registration. */
export function runCodeToolWithHandle(options: Omit<RunCodeToolOptions, "handle">): {
  tool: Tool;
  handle: RegistryHandle;
} {
  const handle = new RegistryHandle();
  return { tool: runCodeTool({ ...options, handle }), handle };
}

export function runCodeTool(options: RunCodeToolOptions): Tool {
  const config = options.config ?? runCodeConfigFromEnv();
  // §3.3: the advertised ceiling must be the one THIS host enforces, so the spec
  // is built from the effective config rather than from the module constant.
  const spec = runCodeSpec(config.maxTimeoutMs);
  return {
    spec: () => spec,
    execute: async (): Promise<unknown> => {
      // The broker needs the caller-assigned call id (sub-call ids embed it).
      throw new ToolFailure(RUN_CODE_ERROR_PREFIX, `${RUN_CODE_ERROR_PREFIX}: dispatched without a call id`);
    },
    executeWith: async (input: ToolInput): Promise<ToolExecOutcome> => {
      const registry = options.handle.resolve();
      if (registry === null) {
        throw new ToolFailure(
          "registry",
          `${RUN_CODE_ERROR_PREFIX}: code=registry msg="the tool registry is not bound"`,
        );
      }
      const ctx: BrokerContext = {
        sandbox: options.sandbox,
        registry,
        config,
        parentId: input.call_id,
        ...(options.events === undefined ? {} : { events: options.events }),
      };
      return brokerRun(ctx, input.args);
    },
  };
}

/**
 * The human/model-facing contract text. Kept as one block because it is diffed
 * byte-for-byte against `contracts/tools.json` (`sdk.test.ts`).
 *
 * `maxTimeoutMs` is a parameter because the ceiling became deployer-configurable
 * (§3.3, `CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS`); the frozen contract records the
 * DEFAULT posture (no env), which is exactly [DEFAULT_MAX_TIMEOUT_MS].
 */
function runCodeDesc(maxTimeoutMs: number): string {
  return (
    "Execute a program in the sandbox and get its final value in ONE round trip (parent-broker). " +
    "DEFAULT LANGUAGE: TypeScript, run by Node with native type stripping (no build step) — only ERASABLE TypeScript is allowed: " +
    "no `enum`, no `namespace`, no parameter properties, no `declare`; plain JavaScript always works. " +
    'Pass language: "python" for Python instead. ' +
    "Write the program as a `function main()` body (an indented body is wrapped for you), or as a complete script that defines main; " +
    "main() MAY be async and its resolved value (lossless JSON) is the final result. " +
    "Inside the program the SDK exposes four synchronous bridges dispatched through the normal guarded tool pipeline: " +
    "tools.read_file({path}) / tools.write_file({path, content}) / tools.list_dir({path}) / tools.run_shell({command}) " +
    "(Python: tools.read_file(path=...) etc.); a denied or failed sub-call raises ToolCallError (catch it and continue). " +
    "Bridge tools resolve relative paths against the TOOL workdir, not the program's cwd — pass absolute paths from inside the program. " +
    "Only log what the model needs: a non-protocol stdout line becomes a log line (≤" + MAX_LOG_BYTES + " bytes, UI render only); " +
    "intermediate sub-call results are recorded in the session log but context-retained (the model sees only the final value). " +
    "Hard limits: ≤" + MAX_SUB_CALLS + " sub-calls (the next one errors), wall clock ≤" + maxTimeoutMs + "ms (timeout_ms, default " + DEFAULT_TIMEOUT_MS + "; the ceiling is CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS), " +
    "sub-call output ledger ≤" + MAX_SUB_OUTPUT_BYTES + " bytes (truncated with a warning). " +
    "The child's CPU limit (RLIMIT_CPU) follows this run's wall clock, so raising timeout_ms raises the CPU budget with it; a CPU-cap kill is reported as cpu_exceeded. " +
    "No network; the same sandbox as run_shell (bwrap/raw/userspace + rlimits)."
  );
}

/**
 * `maxTimeoutMs` defaults to [DEFAULT_MAX_TIMEOUT_MS], so the frozen-contract
 * comparison (`runCodeSpec()` with no arguments) sees the shipped default; the
 * mounted tool passes its effective config, so `GET /api/tools` advertises the
 * ceiling that actually applies on that host.
 */
export function runCodeSpec(maxTimeoutMs: number = DEFAULT_MAX_TIMEOUT_MS): ToolSpec {
  return {
    name: "run_code",
    description: runCodeDesc(maxTimeoutMs),
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          enum: ["typescript", "python"],
          description:
            "Program language; default \"typescript\". TypeScript runs under Node's native type stripping (erasable syntax only: no enum/namespace/parameter properties) and needs no build; \"python\" runs under python3 -uB.",
        },
        code: {
          type: "string",
          description:
            "Program source in the chosen language: a \`function main()\` body (an indented body is wrapped for you) or a complete script that defines main. The engine injects the SDK preamble (tools bridge + protocol).",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: maxTimeoutMs,
          description:
            "Optional whole-run wall clock in ms. Default 120000; the hard cap is CELAESTEA_RUN_CODE_MAX_TIMEOUT_MS (default 120000, so it is unchanged unless the deployer raises it). CELAESTEA_RUN_CODE_TIMEOUT_MS tunes the default, never the cap. The child's CPU limit follows this value.",
        },
        desc: descParam(),
      },
      required: ["code"],
      additionalProperties: false,
    },
  };
}
