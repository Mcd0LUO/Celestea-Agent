/**
 * The LLM seam — the vocabulary a provider adapter and its callers share.
 *
 * A1 (W746): the seam vocabulary is CORE's. `@celestea/core` is the single
 * source of `Llm` / `Message` / `Content` / `Role` / `ToolCall` / `ToolSpec` /
 * `ModelRequest` / `Usage` / `LlmError`, and this module re-exports it instead
 * of redeclaring a second, structurally-identical universe. The old
 * `TODO(core-seam)` ("core's seam is still in flight") is discharged: core has
 * exported all of these since W271, and `packages/llm` now imports core.
 *
 * Field names and content tag names are contract, not style (`type` +
 * `content`, `tool_call_id`, flat usage counters): do not rename anything.
 *
 * ONE member cannot be a pure re-export — see [StreamEvent].
 */

import type {
  Content,
  Message,
  ModelRequest,
  StreamEvent as CoreStreamEvent,
  TextContent,
} from "@celestea/core";

// The seam vocabulary, verbatim from core (values keep their identity too, so
// `userMessage(...)` here IS core's `userMessage(...)`).
export {
  assistantText,
  assistantToolCall,
  messageToolCalls,
  ROLES,
  systemMessage,
  toolResultMessage,
  userMessage,
} from "@celestea/core";
export type {
  Content,
  LlmError,
  LlmErrorKind,
  LlmErrorOptions,
  Message,
  ModelRequest,
  Role,
  TextContent,
  TimeoutStage,
  ToolCall,
  ToolCallContent,
  ToolSpec,
  Usage,
} from "@celestea/core";

/**
 * `StreamEvent` — core's streamed-turn union with exactly ONE member widened.
 *
 * A provider's SSE idle guard is a terminal `failed{kindOf:"timeout"}` (Rust:
 * `StreamEvent::Failed { kind, .. }` with a free-form kind whose live values
 * are "stream" and "timeout"), while core's union lists "generate" | "stream".
 *
 * TODO(core-timeout-kind) — why the widening stays HERE for now: folding it
 * into core needs three files this cut may not touch or must not change:
 *   1. `contracts/session-event.schema.json` freezes `TurnOutcome.error.kind`
 *      to exactly ["generate","stream"], and W744 EXECUTES that schema
 *      (`tests/contract-parity.test.ts:68,119`): widening core's
 *      `TurnOutcome.error.kind` would let the engine mint rows the frozen
 *      contract rejects;
 *   2. `packages/agent-loop/src/step.ts:49` forwards `kindOf` into
 *      `TurnOutcome.error.kind` verbatim, so `StreamEvent.failed.kindOf`
 *      cannot be widened alone (agent-loop is W747's file);
 *   3. `contracts/` is frozen — a real widening is a contract change with a
 *      decision record, not a worker's bounded cut.
 * Until then the delta is this single member: everything else is derived from
 * core's union, so a variant added in core appears here automatically.
 */
export type StreamEvent =
  | Exclude<CoreStreamEvent, { kind: "failed" }>
  | { kind: "failed"; kindOf: "generate" | "stream" | "timeout"; message: string };

/**
 * A request DRAFT — what a DIRECT caller of this provider may pass: every field
 * of core's `ModelRequest` optional except `messages`.
 *
 * The engine always hands over a fully-filled core `ModelRequest` (which IS a
 * draft: it is assignable to this type), but the provider is also driven
 * one-shot (`packages/llm/**` tests, an embedding host), where `model` /
 * `system` / `tools` / `max_tokens` / `temperature` are simply absent — the
 * wire mapper's documented "absent == empty" fallbacks handle exactly that, and
 * have always handled it. Keeping the permissive form HERE (instead of
 * loosening core's `ModelRequest`, which `apps/studio` reads as a fully-filled
 * shape) is what makes the shared seam strict and the provider usable.
 */
export type ModelRequestDraft = Partial<ModelRequest> & { messages: Message[] };

/** The streamed turn: an async iterable of events. */
export type LlmStream = AsyncIterable<StreamEvent>;

/**
 * The `Llm` seam every provider adapter implements: core's `Llm` with the
 * [StreamEvent] widening above (hence not a re-export — the return type is the
 * provider's stream). A provider stream is therefore NOT assignable to core's
 * `Llm`; the single host adapter converts it (and drops "timeout" to "stream"
 * for the frozen contract): `apps/studio/src/runtime/llm-assembly.ts:69-96`.
 */
export interface Llm {
  /** Start a streaming turn; pre-stream failures reject with an LlmError. */
  generate(req: ModelRequestDraft): Promise<LlmStream>;
}

// ---------------------------------------------------------------------------
// Message helpers over core's shapes (convenience, not seam vocabulary)
// ---------------------------------------------------------------------------

/** Concatenate the text parts of a message's content (joined with "\n"). */
export function collectMessageText(content: readonly Content[]): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.content)
    .join("\n");
}

/** Drain a stream into an array (helper for tests/CLI; consumers stream live). */
export async function collectStream(stream: LlmStream): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
