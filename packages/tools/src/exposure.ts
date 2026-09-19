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
 *
 * W806 (P0) adds the second, dynamic layer without adding a second decorator:
 * `hidden` may be a LIVE PROVIDER, `order` fixes the wire order to a stable
 * disclosure order, and `onHidden` lets a policy remember a refused direct call.
 * See `disclosure.ts` for the policy itself. Nothing about the mode fold or the
 * `run_code` escape hatch changes.
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
 * which is why the execution face is exactly these eight names (M7).
 *
 * W884 adds `load_skill` to the keep list. It is a PURE READ of the session's
 * own skill layers (no writes, no process, no network), and — unlike the four
 * SDK-covered tools — it is NOT reachable from a `run_code` program
 * (`SDK_TOOLS` exposes only read_file / write_file / list_dir / run_shell).
 * Folding it would therefore make skills UNREACHABLE in execution mode while the
 * turn-start catalog still advertises them: a prompt that lies about what the
 * model can do, which §6.5 of the disclosure design forbids. Keeping it costs
 * one schema and preserves progressive disclosure in both modes.
 */
export const EXECUTION_TOOL_NAMES: readonly string[] = [
  "run_code",
  "http_request",
  "process_control",
  "spawn_worker",
  "send_message",
  "stop_worker",
  "worker_status",
  "load_skill",
  // F4 step 2b: the browser tools are NOT SDK-covered (SDK_TOOLS stays the
  // four file tools), so folding them would make them unreachable in execution
  // mode while the turn-start catalog still advertises them -- the same
  // "prompt must not lie" rule that kept load_skill (W884).
  "browser_open",
  "browser_act",
  // B2 (F3 P1): remember/forget WRITE the workspace's own memory layer. Folding
  // them would make persistent memory unreachable in execution mode while the
  // turn-start memory block still advertises the feature -- the same "prompt
  // must not lie" rule that kept load_skill (W884) and the browser tools (F4).
  "remember",
  "forget",
];

/**
 * The frozen guidance text of one folded call (S3). It names the `{tool}` slot
 * and gives the model the TWO documented ways out (R1/R2): write a program, or
 * switch the session back to standard mode.
 */
export const EXECUTION_GUIDANCE =
  "'{tool}' is not directly callable in execution mode: write ONE `run_code` program that calls tools.{tool}(...) — a program's sub-calls always run — or switch the session back to standard mode";

/**
 * W806: the refusal text of a tool that is merely NOT YET disclosed. It is
 * deliberately distinct from [EXECUTION_GUIDANCE]: the name was withheld by the
 * dynamic layer, not folded by the mode, so "write a program" would be the wrong
 * advice. The refused call IS the request — the name joins the face at the next
 * turn boundary (design §7.1, Q1/Q4 pending).
 */
export const DISCLOSURE_GUIDANCE =
  "'{tool}' is not offered yet: it is disclosed at the NEXT turn boundary — this refused call is the request";

/** `tool_unavailable_in_mode: '<name>' …` — the refusal text of one folded call. */
export function unavailableError(name: string, guidance: string = EXECUTION_GUIDANCE): string {
  return `${TOOL_UNAVAILABLE_CODE}: ${guidance.split("{tool}").join(name)}`;
}

export interface ExposureOptions {
  /**
   * Tool names the model must not call directly (still registered inside).
   * A fixed array, or a provider read once per `schemas()` / `dispatch()` call
   * (W806: the dynamic layer publishes a new snapshot at a turn boundary).
   */
  hidden: readonly string[] | (() => readonly string[]);
  /** Refusal text template; `{tool}` is replaced with the folded name. */
  guidance?: string;
  /**
   * W806: per-name guidance, wins over [guidance]. A face can fold some names
   * by mode and withhold others dynamically, and the two refusals must not
   * borrow each other's prose.
   */
  guidanceFor?: (name: string) => string;
  /**
   * W806: stable disclosure order. When present, `schemas()` emits the visible
   * specs in exactly this order, appending any visible name the list missed.
   * Because a disclosure order only grows by appending, the wire array stays
   * append-only across a session — the cache-safe shape (design §3.5/S2).
   */
  order?: readonly string[] | (() => readonly string[]);
  /**
   * W806: called once when `dispatch` refuses a name because it is hidden. The
   * dynamic policy records it and discloses it at the NEXT turn boundary; this
   * is the only place a refusal can turn into a proposal.
   */
  onHidden?: (name: string) => void;
}

/**
 * The exposure of `execution` mode over a registry holding [names]: every name
 * outside [EXECUTION_TOOL_NAMES] is folded (§5.2 #3).
 */
export function executionExposure(names: readonly string[]): ExposureOptions {
  const kept = new Set(EXECUTION_TOOL_NAMES);
  return { hidden: names.filter((name) => !kept.has(name)), guidance: EXECUTION_GUIDANCE };
}

/** Read a fixed list or a live provider EXACTLY once per reader call. */
function readNames(value: readonly string[] | (() => readonly string[])): readonly string[] {
  return typeof value === "function" ? value() : value;
}

/**
 * Filter specs by an exposure — the rule `ExposedRegistry.schemas()` starts from.
 * Stable ORDER is the decorator's own stateful projection (see `stableProjection`),
 * not a pure function of this call: a name must keep the wire position it FIRST
 * had, even when a tool registers after the policy was built.
 */
export function exposedSpecs(specs: readonly ToolSpec[], options: ExposureOptions): ToolSpec[] {
  const hidden = new Set(readNames(options.hidden));
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
 *
 * W806 keeps this STATIC on purpose: the rendered `{{tools}}` list is the
 * mode's disclosable universe, never the per-turn disclosed subset. System text
 * is serialized BEFORE tools, so making it follow disclosure would invalidate
 * the whole request prefix from token 0 (design §3.4/P4).
 *
 * W857 adds the optional [blocked] list: the permission baseline's `toolDeny`
 * (W9). It is an INTERSECTION applied AFTER the fold — never a union — so a name
 * the mode already folded cannot be restored and a name outside the folded face
 * simply has no effect. Callers that read the same face as a composed instance
 * (`RealRuntimeAdapter.sessionTools` vs `engineTools`' `DisclosurePolicy`)
 * pass the same list through here so the two paths cannot drift (W791 §10.5 #2).
 */
export function faceForMode(specs: readonly ToolSpec[], mode: string, blocked: readonly string[] = []): ToolSpec[] {
  const face = mode !== "execution" ? [...specs] : exposedSpecs(specs, executionExposure(specs.map((spec) => spec.name)));
  if (blocked.length === 0) return face;
  const denied = new Set(blocked);
  return face.filter((spec) => !denied.has(spec.name));
}

/** A call the decorator REFUSED: a `deny`, with the refusal text as the error. */
function folded(callId: string, error: string): ToolOutput {
  return { call_id: callId, value: null, render: null, error, decision: { kind: "deny", reason: error } };
}

class ExposedRegistry implements ToolRegistry {
  private readonly options: ExposureOptions;
  private readonly guidance: string;
  /** Names already WIRE-ORDERED, in first-seen order (append-only). */
  private emitted: string[] = [];

  constructor(private readonly inner: ToolRegistry, options: ExposureOptions) {
    this.options = options;
    this.guidance = options.guidance ?? EXECUTION_GUIDANCE;
  }

  /** The inner registry (never a copy) — the handle `run_code` is bound to. */
  get innerRegistry(): ToolRegistry {
    return this.inner;
  }

  /** The names this face hides (diagnostics / compose assertions). */
  hiddenNames(): string[] {
    return [...readNames(this.options.hidden)];
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
    return this.stableProjection(this.inner.schemas());
  }

  /**
   * The stable disclosure order (W806/S2): a visible name keeps the position it
   * FIRST had on this face and a name seen for the first time is appended at the
   * TAIL — never inserted, never reordered. The policy order is only the seed,
   * so a tool registered after the policy was built (the worker tools do) lands
   * at the end instead of jumping ahead of a later dynamic disclosure.
   */
  private stableProjection(specs: readonly ToolSpec[]): ToolSpec[] {
    const hidden = new Set(readNames(this.options.hidden));
    const visible = specs.filter((spec) => !hidden.has(spec.name));
    const visibleNames = visible.map((spec) => spec.name);
    const visibleSet = new Set(visibleNames);
    const preferred = this.options.order === undefined ? visibleNames : readNames(this.options.order);
    const known = new Set(this.emitted);
    for (const name of preferred) {
      if (!visibleSet.has(name) || known.has(name)) continue;
      known.add(name);
      this.emitted.push(name);
    }
    for (const name of visibleNames) {
      if (known.has(name)) continue;
      known.add(name);
      this.emitted.push(name);
    }
    // A name no longer visible leaves the memory; if it ever comes back it is
    // appended at the tail, never re-inserted.
    this.emitted = this.emitted.filter((name) => visibleSet.has(name));
    const byName = new Map(visible.map((spec) => [spec.name, spec]));
    return this.emitted.map((name) => byName.get(name) as ToolSpec);
  }

  async dispatch(input: ToolInput): Promise<ToolOutput> {
    const hidden = new Set(readNames(this.options.hidden));
    if (hidden.has(input.name)) {
      this.noteHidden(input.name);
      return folded(input.call_id, unavailableError(input.name, this.options.guidanceFor?.(input.name) ?? this.guidance));
    }
    return this.inner.dispatch(input);
  }

  /**
   * Tell the policy a direct call was refused. A broken observer must never turn
   * a refuse-before-execution into a throw (the deny is already decided).
   */
  private noteHidden(name: string): void {
    try {
      this.options.onHidden?.(name);
    } catch {
      /* the refusal stands; a policy bug is not a dispatch failure */
    }
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
