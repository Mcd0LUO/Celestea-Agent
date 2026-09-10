/**
 * Raw chat-completions chunk parsing (P2a).
 *
 * Mirrors `crates/llm/src/client.rs`:
 *   parse_raw_chunk   — delta view of one SSE data payload;
 *   extract_reasoning — choices[].delta.reasoning_content, joined in wire order;
 *   thinking_event    — blank-gated thinking event for a reasoning delta;
 *   parse_arguments   — tool-call arguments (malformed JSON kept raw).
 *
 * Non-JSON payloads (heartbeats, noise) and payloads carrying neither a delta
 * nor usage (e.g. `{"choices":[]}`) return undefined, so the caller skips them.
 */

import { parseUsage, type Usage } from "../usage.js";
import type { StreamEvent } from "../seam.js";

/** One streamed tool-call fragment (id/name/arguments arrive piecemeal). */
export interface RawToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** The content + tool_calls part of a single choice's delta. */
export interface RawChoiceDelta {
  text?: string;
  toolCalls: RawToolCallDelta[];
}

/** One decoded chat-completions stream chunk (raw wire shape). */
export interface RawChunk {
  /** Joined reasoning_content across choices (absent when none). */
  reasoning?: string;
  /** Per-choice content / tool-call deltas, in wire order. */
  choices: RawChoiceDelta[];
  /** Provider-reported usage, when the chunk carries some. */
  usage?: Usage;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function choiceIndex(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Extract chain-of-thought text: DeepSeek streams the CoT in
 * choices[].delta.reasoning_content (absent for non-reasoning models);
 * multi-choice deltas join in wire order.
 */
export function extractReasoning(chunk: unknown): string | undefined {
  if (!isRecord(chunk)) return undefined;
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return undefined;
  const parts: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = choice["delta"];
    if (!isRecord(delta)) continue;
    const reasoning = str(delta["reasoning_content"]);
    if (reasoning !== undefined && reasoning !== "") parts.push(reasoning);
  }
  return parts.length === 0 ? undefined : parts.join("");
}

/** Parse one tool_calls array entry into a fragment. */
function parseToolCallDelta(call: unknown): RawToolCallDelta | undefined {
  if (!isRecord(call)) return undefined;
  const fn = isRecord(call["function"]) ? call["function"] : {};
  const fragment: RawToolCallDelta = { index: choiceIndex(call["index"]) };
  const id = str(call["id"]);
  const name = str(fn["name"]);
  const args = str(fn["arguments"]);
  if (id !== undefined) fragment.id = id;
  if (name !== undefined) fragment.name = name;
  if (args !== undefined) fragment.arguments = args;
  return fragment;
}

/** Parse one choices[] entry into its delta view, or undefined when empty. */
function parseChoiceDelta(choice: unknown): RawChoiceDelta | undefined {
  if (!isRecord(choice)) return undefined;
  const delta = choice["delta"];
  if (!isRecord(delta)) return undefined;
  const rawText = str(delta["content"]);
  const toolCalls: RawToolCallDelta[] = [];
  const rawCalls = delta["tool_calls"];
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const fragment = parseToolCallDelta(call);
      if (fragment !== undefined) toolCalls.push(fragment);
    }
  }
  const out: RawChoiceDelta = { toolCalls };
  if (rawText !== undefined && rawText !== "") out.text = rawText;
  if (out.text === undefined && toolCalls.length === 0) return undefined;
  return out;
}

/**
 * Parse one SSE data payload into the delta view. Returns undefined for
 * non-JSON payloads, `[DONE]`, and JSON payloads without deltas or usage.
 */
export function parseRawChunk(data: string): RawChunk | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const reasoning = extractReasoning(value);
  const usage = parseUsage(value);
  const choices: RawChoiceDelta[] = [];
  const rawChoices = value["choices"];
  if (Array.isArray(rawChoices)) {
    for (const choice of rawChoices) {
      const delta = parseChoiceDelta(choice);
      if (delta !== undefined) choices.push(delta);
    }
  }

  if (reasoning === undefined && choices.length === 0 && usage === undefined) return undefined;
  const chunk: RawChunk = { choices };
  if (reasoning !== undefined) chunk.reasoning = reasoning;
  if (usage !== undefined) chunk.usage = usage;
  return chunk;
}

/** Build a thinking event for a non-blank reasoning delta (blank-gated). */
export function thinkingEvent(reasoning: string): StreamEvent | null {
  return reasoning.trim() === "" ? null : { kind: "thinking", text: reasoning };
}

/** Parse accumulated tool-call arguments; malformed JSON is preserved raw. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
