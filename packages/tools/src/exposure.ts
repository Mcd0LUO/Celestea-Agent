/**
 * `exposedRegistry` — the MODEL-VISIBLE face of one session's tool registry.
 *
 * `docs/modes-standard-vs-execution.md` §5.2 #1/#2 (P1): in `execution` mode the
 * four SDK-covered tools (`read_file` / `write_file` / `list_dir` / `run_shell`)
 * are no longer offered for a DIRECT call — they are reached from inside a
 * `run_code` program. The engine's registry keeps every tool registered; what
 * changes is the face the model sees and the door a model-initiated call knocks
 * on.
 *
 * Two invariants make this a decorator and not a second registry:
 *
 * 1. **The verdict never lies** (`registry.ts`, W738 P1): a folded call is
 *    REFUSED before anything runs, so it is reported as a `deny` whose reason is
 *    the very text the caller sees — never an `allow` for a call the seam
 *    declined to execute.
 * 2. **`run_code` sub-calls are NOT folded** (§5.2 #2, M8): the `run_code` tool
 *    holds a `RegistryHandle` bound to the INNER registry (`plugin.ts`), and this
 *    decorator is only ever the Context-provided face. A program's
 *    `tools.read_file(...)` therefore rides the inner pipeline unchanged —
 *    nothing here inspects the `:c<n>` id shape of a sub-call.
 *
 * `register` / `addGuard` / `get` pass straight through: the decorator never
 * owns tools or guards, it only filters what is LISTED and gates what is
 * DISPATCHED BY NAME from the model side.
 */

import type { Tool, ToolGuard, ToolInput, ToolOutput, ToolRegistry, ToolSpec } from "@celestea/core";

/**
 * Stable marker of a folded call (S3/M8). It is part of the observable contract:
 * a caller branches on this token, never on the prose around it.
 */
export const TOOL_UNAVAILABLE_CODE = "tool_unavailable_in_mode";

/**
 * The tool face of `execution` mode — module-level data, never a literal list at
 * a call site (K3, §5.2 #3). `standard` mode exposes the whole registry.
 *
 * The list is a KEEP list on purpose: a tool registered later (W783's
 * `ask_user_question`, a future orchestration tool) must be *decided* about
 * rather than silently inherited by both modes. Anything outside it is folded —
 * which is why the execution face is exactly these six names (M7).
 */
export const EXECUTION_TOOL_NAMES: readonly string[] = [
  "run_code",
  "http_request",
  "process_control",
  "spawn_worker",
  "session_send_message",
  "worker_status",
];

/**
 * The frozen guidance text of one folded call (S3). It names the `{tool}` slot
 * and gives the model the TWO documented ways out (R1/R2): write a program, or
 * switch the session back to standard mode.
 */
export const EXECUTION_GUIDANCE =
  "'{tool}' is not directly callable in execution mode: write ONE `run_code` program that calls tools.{tool}(...) — a program's sub-calls always run — or switch the session back to standard mode";

/** `tool_unavailable_in_mode: '<name>' …` — the refusal text of one folded call. */
export function unavailableError(name: string, guidance: string = EXECUTION_GUIDANCE): string {
  return `${TOOL_UNAVAILABLE_CODE}: ${guidance.split("{tool}").join(name)}`;
}

export interface ExposureOptions {
  /** Tool names the model must not call directly (still registered inside). */
  hidden: readonly string[];
  /** Refusal text template; `{tool}` is replaced with the folded name. */
  guidance?: string;
}

/**
 * The exposure of `execution` mode over a registry holding [names]: every name
 * outside [EXECUTION_TOOL_NAMES] is folded (§5.2 #3).
 */
export function executionExposure(names: readonly string[]): ExposureOptions {
  const kept = new Set(EXECUTION_TOOL_NAMES);
  return { hidden: names.filter((name) => !kept.has(name)), guidance: EXECUTION_GUIDANCE };
}

/** Filter specs by an exposure — the ONE rule `ExposedRegistry.schemas()` applies. */
export function exposedSpecs(specs: readonly ToolSpec[], options: ExposureOptions): ToolSpec[] {
  const hidden = new Set(options.hidden);
  return specs.filter((spec) => !hidden.has(spec.name));
}

/**
 * The model-visible face of a spec list under a mode literal: `execution` folds
 * everything outside [EXECUTION_TOOL_NAMES], `standard` (and any unknown value)
 * keeps the list as it is.
 *
 * This is the COMPOSE-TIME reading of the same rule, and it exists because the
 * face has to be knowable BEFORE the instance that will expose it exists: the
 * system prompt of a session is assembled while that very session is being
 * composed (`sessionSystemPrompt`), so asking the registry for "the live
 * instance" would answer with the PREVIOUS generation — or, on the first
 * compose, with the detached default's 11-tool face (design §10.5 #2).
 */
export function faceForMode(specs: readonly ToolSpec[], mode: string): ToolSpec[] {
  if (mode !== "execution") return [...specs];
  return exposedSpecs(specs, executionExposure(specs.map((spec) => spec.name)));
}

/** A call the decorator REFUSED: a `deny`, with the refusal text as the error. */
function folded(callId: string, error: string): ToolOutput {
  return { call_id: callId, value: null, render: null, error, decision: { kind: "deny", reason: error } };
}

class ExposedRegistry implements ToolRegistry {
  private readonly hidden: Set<string>;
  private readonly options: ExposureOptions;
  private readonly guidance: string;

  constructor(private readonly inner: ToolRegistry, options: ExposureOptions) {
    this.hidden = new Set(options.hidden);
    this.options = options;
    this.guidance = options.guidance ?? EXECUTION_GUIDANCE;
  }

  /** The inner registry (never a copy) — the handle `run_code` is bound to. */
  get innerRegistry(): ToolRegistry {
    return this.inner;
  }

  /** The names this face hides (diagnostics / compose assertions). */
  hiddenNames(): string[] {
    return [...this.hidden];
  }

  register(tool: Tool): void {
    this.inner.register(tool);
  }

  addGuard(guard: ToolGuard): void {
    this.inner.addGuard(guard);
  }

  get(name: string): Tool | undefined {
    return this.inner.get(name);
  }

  schemas(): ToolSpec[] {
    return exposedSpecs(this.inner.schemas(), this.options);
  }

  async dispatch(input: ToolInput): Promise<ToolOutput> {
    if (this.hidden.has(input.name)) return folded(input.call_id, unavailableError(input.name, this.guidance));
    return this.inner.dispatch(input);
  }
}

/**
 * Wrap [inner] in the mode's model-visible face. The returned registry shares
 * the inner registry's tools and guard chain (nothing is copied), so a sub-call
 * that reaches the inner pipeline runs exactly as a direct call always did.
 */
export function exposedRegistry(inner: ToolRegistry, options: ExposureOptions): ToolRegistry {
  return new ExposedRegistry(inner, options);
}
