/**
 * Context-budget utilities for the agent loop — port of
 * `crates/agent-loop/src/context.rs` (W220).
 *
 * Token estimation operates on the model-facing messages only and decides
 * *when* to trim; it is deliberately approximate (UTF-8 bytes / 4) and never
 * used to bill or to report usage. Real numbers come from the provider
 * (`core.Usage`) and are handled by [UsageTracker].
 *
 * Contract notes (all mirrored by unit tests, same as the Rust module):
 *   - `contextWindowTokens === 0` disables trimming entirely;
 *   - over budget, the `contextKeepRecent` most-recent messages survive, plus
 *     every `system` message (always kept, always first);
 *   - removal is marked with ONE short system message so the model knows;
 *   - every cut lands on a system/user boundary, so an assistant tool-call
 *     group is never split and the history never starts with an orphan tool
 *     message.
 */

import {
  isTextContent,
  isToolCallContent,
  serdeJsonString,
  systemMessage,
  type Message,
  type Role,
} from "@celestea/core";

/** Per-message structural overhead (role + framing) in the estimate. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Per-tool-call structural overhead in the estimate. */
const TOOL_CALL_OVERHEAD_TOKENS = 10;
/** Marker text prefix (contract: consumers key off `[context-trimmed]`). */
export const TRIMMED_MARKER_PREFIX = "[context-trimmed]";

/** Estimate the token count of a text fragment (UTF-8 bytes / 4, rounded up). */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 4);
}

/** Estimate the token count of one message (content + structural overhead). */
export function estimateMessageTokens(msg: Message): number {
  let total = MESSAGE_OVERHEAD_TOKENS;
  for (const content of msg.content) {
    if (isTextContent(content)) total += estimateTokens(content.content);
    else if (isToolCallContent(content)) {
      const call = content.content;
      total += TOOL_CALL_OVERHEAD_TOKENS + estimateTokens(call.name) + estimateTokens(serdeJsonString(call.args));
    }
  }
  if (msg.tool_call_id !== null) total += estimateTokens(msg.tool_call_id);
  return total;
}

/** Estimate the total token count of a message list. */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

/** The outcome of one trim pass over the derived history (`TrimOutcome`). */
export interface TrimOutcome {
  /** How many messages were removed (0 = nothing trimmed). */
  removedMessages: number;
  /** Estimated tokens of the removed messages. */
  removedTokens: number;
  /** True when the history was actually trimmed this pass. */
  trimmed: boolean;
}

/** The trimmed history plus what the pass did. */
export interface TrimResult {
  messages: Message[];
  outcome: TrimOutcome;
}

const NOT_TRIMMED: TrimOutcome = { removedMessages: 0, removedTokens: 0, trimmed: false };

/**
 * Mark the removal of earlier messages with one short system message, so the
 * model knows older context was dropped instead of silently missing it.
 */
export function trimmedMarkerMessage(removedMessages: number, removedTokens: number): Message {
  return systemMessage(
    `${TRIMMED_MARKER_PREFIX} Earlier conversation was trimmed to fit the context budget: ` +
      `${removedMessages} message(s) ~${removedTokens} tokens removed. Continue from the recent ` +
      "messages below; ask the user to restate any earlier detail you need.",
  );
}

function isCutBoundary(role: Role): boolean {
  return role === "system" || role === "user";
}

/** Indices of `rest` where a protocol-safe suffix may start. */
function safeCutPositions(rest: readonly Message[]): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    const role = rest[i]?.role;
    if (role !== undefined && isCutBoundary(role)) cuts.push(i);
  }
  return cuts;
}

/**
 * Pick the cut index: prefer keeping exactly `keepRecent` messages, trim
 * further when that suffix is still over budget (keep the most that fits), and
 * fall back to the last safe boundary when nothing fits.
 */
function pickCut(cuts: readonly number[], keepRecent: number, fits: (candidate: number) => boolean): number {
  const withinKeep = cuts.find((c) => c >= keepRecent);
  const fitsBudget = cuts.find((c) => fits(c));
  if (withinKeep !== undefined && fitsBudget !== undefined) return withinKeep >= fitsBudget ? withinKeep : fitsBudget;
  if (withinKeep !== undefined) return withinKeep;
  if (fitsBudget !== undefined) return fitsBudget;
  return cuts[cuts.length - 1] ?? 0;
}

/**
 * Trim an over-budget message history to fit the context window (W220 v1).
 *
 * `systemTokens` is the estimated size of the outside system prompt
 * (`ModelRequest.system`): it is never trimmed but counts into the budget.
 */
export function trimContext(
  messages: readonly Message[],
  systemTokens: number,
  contextWindowTokens: number,
  threshold: number,
  keepRecent: number,
): TrimResult {
  if (contextWindowTokens === 0) return { messages: [...messages], outcome: NOT_TRIMMED };
  const budget = Math.max(1, Math.floor(contextWindowTokens * Math.min(Math.max(threshold, 0), 1)));
  if (systemTokens + estimateMessagesTokens(messages) <= budget) {
    return { messages: [...messages], outcome: NOT_TRIMMED };
  }

  const systems: Message[] = [];
  const rest: Message[] = [];
  for (const msg of messages) {
    if (msg.role === "system") systems.push(msg);
    else rest.push(msg);
  }
  if (rest.length === 0) return { messages: [...systems], outcome: NOT_TRIMMED };

  const cuts = safeCutPositions(rest);
  // No safe boundary: refuse to risk breaking the tool-call protocol.
  if (cuts.length === 0) return { messages: [...systems, ...rest], outcome: NOT_TRIMMED };

  const keep = Math.max(1, keepRecent);
  const cut = pickCut(cuts, Math.max(0, rest.length - keep), (candidate) => {
    return systemTokens + estimateMessagesTokens(rest.slice(candidate)) <= budget;
  });

  const removed = rest.slice(0, cut);
  const outcome: TrimOutcome = {
    removedMessages: removed.length,
    removedTokens: estimateMessagesTokens(removed),
    trimmed: removed.length > 0,
  };
  if (!outcome.trimmed) return { messages: [...systems, ...rest], outcome: NOT_TRIMMED };
  return {
    messages: [...systems, trimmedMarkerMessage(outcome.removedMessages, outcome.removedTokens), ...rest.slice(cut)],
    outcome,
  };
}
