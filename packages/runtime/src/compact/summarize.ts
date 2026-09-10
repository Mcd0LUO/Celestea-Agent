/**
 * Summary generation for compaction, over the `Llm` SEAM
 * (port of `celestea_studio/src/compact.rs:270-340`).
 *
 * The host does not talk HTTP here: it asks the same `Llm` the engine uses, so
 * compose owns base_url / key / request format and this module stays free of
 * provider knowledge (and of any sibling-package import).
 *
 * Failure model: a broken stream, a provider failure or an empty answer is an
 * ERROR (never an empty summary), because a compaction that silently loses the
 * history is worse than no compaction at all. A total timeout bounds the call.
 */

import { userMessage, type Llm, type LlmStream, type ModelRequest } from "@celestea/core";
import { COMPACT_SYSTEM_PROMPT, SUMMARY_MAX_TOKENS, SUMMARY_TIMEOUT_MS } from "./transcript.js";

/** Turns a transcript into a summary; throws on failure. */
export type Summarizer = (transcript: string) => Promise<string>;

export interface LlmSummarizerOptions {
  llm: Llm;
  model: string;
  /** System prompt override (default: the frozen four-section contract). */
  system?: string;
  timeoutMs?: number;
}

/** The compaction request for one transcript. */
export function summaryRequest(model: string, transcript: string, system = COMPACT_SYSTEM_PROMPT): ModelRequest {
  return { model, system, messages: [userMessage(transcript)], tools: [], max_tokens: SUMMARY_MAX_TOKENS, temperature: null };
}

/** Reject when `promise` does not settle within `ms` (whole-call timeout). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Concatenate the text deltas; `failed` / `interrupted` / empty are errors. */
export async function collectSummaryText(stream: LlmStream): Promise<string> {
  let text = "";
  for await (const ev of stream) {
    if (ev.kind === "text") {
      text += ev.text;
      continue;
    }
    if (ev.kind === "failed") throw new Error(`摘要请求失败：${ev.message}`);
    if (ev.kind === "interrupted") throw new Error("摘要请求中断（流未给出终态）");
    if (ev.kind === "done") break;
  }
  if (text.trim() === "") throw new Error("摘要响应为空");
  return text;
}

/** A [Summarizer] backed by any `Llm` implementation. */
export function llmSummarizer(opts: LlmSummarizerOptions): Summarizer {
  const timeoutMs = opts.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  return async (transcript: string): Promise<string> => {
    const req = summaryRequest(opts.model, transcript, opts.system ?? COMPACT_SYSTEM_PROMPT);
    let stream: LlmStream;
    try {
      stream = await withTimeout(opts.llm.generate(req), timeoutMs, "摘要请求");
    } catch (e) {
      throw new Error(`摘要请求失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await withTimeout(collectSummaryText(stream), timeoutMs, "摘要流读取");
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("摘要响应缺少正文");
    return trimmed;
  };
}
