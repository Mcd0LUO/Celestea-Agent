/**
 * Tool-result retention (W855) — bound what ONE step may keep inline, and make
 * every omitted byte retrievable.

 * B6 (W855) split the two halves of a result:
 *   - the session LOG stores the ORIGINAL value (`retainToolResult().logged`);
 *   - the MODEL/SSE face is the bounded head/tail window + locator notice
 *     (`retainToolResult().face`), rendered by the shared core primitives so a
 *     replay of the same log reproduces the live model context byte for byte.

 * Contract discipline (mirrors dsh-output-retention / dsh-spill):
 *   - an omission means THE BUDGET kept something out. An upstream that
 *     returned an incomplete body keeps its own domain field and is never
 *     described as "truncated" here;
 *   - the notice names the omitted amount EXACTLY and always carries a
 *     retrieval instruction (the spill locator);
 *   - cutting never returns broken UTF-8: head/tail are cut on code-point
 *     boundaries;
 *   - a spill that fails is BEST-EFFORT: the inline text is kept and the tool
 *     call still succeeds (never turned into an error).

 * The policy is session-scoped and lives in the Context under
 * [RETENTION_SERVICE]; the agent loop reads it once per turn. The persistence
 * half (where the bytes go) belongs to the host, NOT this L1 package.
 */

import { renderOmittedText, retainHeadTail, toolSurfaceText, toolSurfaceValue, type ToolOutput, type ToolResultSurface } from "@celestea/core";

/** Context service token: the retention policy of THIS session. */
export const RETENTION_SERVICE = "celestea.agent-loop.ToolResultRetention";

/**
 * Tools whose results are NEVER rewritten by retention (W855 #8b).
 *
 * `read_file` is how the model retrieves a spilled locator; rewriting a read
 * result into another "read_file <locator>" notice would invite a
 * read -> spill -> read loop (`dsh-spill-policy` skips the same tool). The
 * skipped result does NOT debit the step budget: those bytes are outside the
 * retention budget by policy. W846: `read_file` now paginates with
 * `offset`/`limit`, but each page is still bounded by the tool's 256 KiB
 * budget, so the skip stays correct — a page stays inline up to that cap and
 * the model advances with `nextOffset` instead of a retention locator.
 */
export const RETENTION_SKIP_TOOLS: ReadonlySet<string> = new Set(["read_file"]);

/** A persisted full-text tool result. */
export interface SpillRef {
  /** Where the full text lives (a path the model can read back). */
  locator: string;
  /** Exact byte size of the persisted text. */
  bytes: number;
  /** A concrete instruction for getting the text back. */
  retrievalHint: string;
}

export interface ToolResultRetention {
  /** A single result whose model-visible text exceeds this is retained. */
  singleResultBytes: number;
  /** Cumulative model-visible bytes one step may keep inline. */
  stepResultBytes: number;
  /** Head window kept inline when a result is retained. */
  previewHeadBytes: number;
  /** Tail window kept inline when a result is retained. */
  previewTailBytes: number;
  /** Persist the full text; null = best-effort failure (keep it inline). */
  spill(text: string, meta: { callId: string }): Promise<SpillRef | null>;
}

/** Default single-result threshold: 64 KiB (~16k tokens). */
export const DEFAULT_SINGLE_RESULT_BYTES = 64 * 1024;
/** Default per-step cumulative threshold: 128 KiB (~32k tokens). */
export const DEFAULT_STEP_RESULT_BYTES = 128 * 1024;
/** Default inline head window: 4 KiB. */
export const DEFAULT_PREVIEW_HEAD_BYTES = 4 * 1024;
/** Default inline tail window: 1 KiB. */
export const DEFAULT_PREVIEW_TAIL_BYTES = 1024;

/** Mutable per-step budget cursor (one per dispatchToolCalls call). */
export interface StepRetention {
  consumedBytes: number;
}

export function newStepRetention(): StepRetention {
  return { consumedBytes: 0 };
}

// W855 (B6): the pure cut/render primitives live in core so the projection can
// render the face without importing this L1 policy layer. Re-exported here so
// the package keeps its stable import path.
export { cutPrefixCodePoints, cutSuffixCodePoints, retainHeadTail } from "@celestea/core";
export type { RetainedText } from "@celestea/core";

/** The text retention measures and persists: a string value stays RAW (so the
 * spill file is readable), anything else is the model-visible JSON. */
export function retentionText(output: ToolOutput): string {
  if (typeof output.error === "string" && output.error.length > 0) return "Error: " + output.error;
  return typeof output.value === "string" ? output.value : toolSurfaceText(output.value, undefined);
}

/** The two surfaces of one tool result: what the log keeps vs what the model sees. */
export interface ToolResultFaces {
  /** The log row: the ORIGINAL value, plus the optional surface descriptor. */
  logged: ToolOutput;
  /** The model/SSE face: `value`/`render` replaced by the rendered surface. */
  face: ToolOutput;
}

/** Apply a tool-authored surface (or none) to the face; the log keeps the original. */
export function faceToolOutput(output: ToolOutput): ToolResultFaces {
  if (output.surface === undefined) return { logged: output, face: output };
  const face = toolSurfaceValue(output.value, output.surface); // RAW (SSE/UI) face
  return { logged: output, face: { ...output, value: face, render: typeof face === "string" ? face : output.render } };
}

/**
 * Apply retention to ONE tool output, returning BOTH surfaces.
 *
 * A result is retained when it exceeds the single-result threshold OR when it
 * would push this step past the cumulative threshold. On ANY spill failure the
 * ORIGINAL is kept inline (fail-soft).
 */
export async function retainToolResult(
  output: ToolOutput,
  policy: ToolResultRetention,
  step: StepRetention,
  toolName: string | null = null,
): Promise<ToolResultFaces> {
  const text = retentionText(output);
  const bytes = Buffer.byteLength(text, "utf8");
  // W855 #8b: a read tool's result IS the retrieval path, not a payload to
  // spill; skipping it prevents read -> spill -> read (and does not debit the
  // step budget — see RETENTION_SKIP_TOOLS).
  if (toolName !== null && RETENTION_SKIP_TOOLS.has(toolName)) return faceToolOutput(output);
  // W855 decision (architect, 2026-09-18): ONLY a successful STRING result is
  // rewritten. An object result's value shape is part of the tool contract
  // (consumers branch on typeof value === "object"), so this layer NEVER
  // changes its type; shrinking a large object is the tool's own decision
  // (deferred). Error results are messages, not payloads, and pass through too.
  // Non-string results still count toward the step budget.
  if (output.error !== null || typeof output.value !== "string") {
    step.consumedBytes += bytes;
    return faceToolOutput(output);
  }
  const overSingle = bytes > policy.singleResultBytes;
  const overStep = step.consumedBytes + bytes > policy.stepResultBytes;
  if (!overSingle && !overStep) {
    step.consumedBytes += bytes;
    return faceToolOutput(output);
  }
  let ref: SpillRef | null = null;
  try {
    ref = await policy.spill(text, { callId: output.call_id });
  } catch {
    ref = null;
  }
  if (ref === null) {
    // Best-effort: the tool call stays successful and keeps its full result.
    step.consumedBytes += bytes;
    return faceToolOutput(output);
  }
  const window = retainHeadTail(text, policy.previewHeadBytes, policy.previewTailBytes);
  const surface: ToolResultSurface = {
    kind: "omitted",
    omitted_bytes: window.omittedBytes,
    total_bytes: window.totalBytes,
    locator: ref.locator,
    retrieval_hint: ref.retrievalHint,
    head_bytes: policy.previewHeadBytes,
    tail_bytes: policy.previewTailBytes,
  };
  const face = renderOmittedText(text, surface);
  step.consumedBytes += Buffer.byteLength(face, "utf8");
  return { logged: { ...output, surface }, face: { ...output, value: face, render: face, surface } };
}

/**
 * Back-compat wrapper: the FACE only (what the model/SSE sees). Callers that
 * must also persist the ORIGINAL use [retainToolResult].
 */
export async function retainToolOutput(
  output: ToolOutput,
  policy: ToolResultRetention,
  step: StepRetention,
  toolName: string | null = null,
): Promise<ToolOutput> {
  return (await retainToolResult(output, policy, step, toolName)).face;
}
