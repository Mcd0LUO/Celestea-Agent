/**
 * The OFFLINE engine LLM — a deterministic, in-process `Llm` seam implementation.
 *
 * Purpose: the TS host must be testable and replayable with ZERO network access
 * (`禁真网`). This adapter answers every `generate()` from a local script, so a
 * real turn (real `DefaultAgentLoop`, real `ToolRegistry`, real session log)
 * runs end to end without a provider.
 *
 * It is not a stub that fakes the loop: the loop, the tool dispatch, the log and
 * the SSE frames are the production ones. Only the model is local.
 *
 * Two behaviours:
 *   - a normal turn answers with the next scripted step (text / thinking /
 *     tool calls / usage), defaulting to a deterministic `echo:` reply;
 *   - a COMPACTION request (the four-section summarizer prompt) answers with a
 *     deterministic four-section summary derived from the transcript, so a
 *     compaction is reproducible byte for byte across runs.
 *
 * `deltaMs` interleaves real delays between frames: a test can abort mid-stream
 * and observe the cooperative cancel path instead of a turn that already
 * finished.
 */

import { createHash } from "node:crypto";
import {
  assistantText,
  type Llm,
  type LlmStream,
  type Message,
  type ModelRequest,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from "@celestea/core";
import { COMPACT_SYSTEM_PROMPT } from "@celestea/runtime";

/** One scripted model step. */
export interface OfflineStep {
  thinking?: string;
  text?: string;
  tool_calls?: readonly ToolCall[];
  /** Answer with a provider failure instead of a done frame. */
  fail?: string;
  /** Answer with a torn stream (the `interrupted` terminal state). */
  interrupted?: boolean;
}

export interface OfflineLlmOptions {
  /**
   * Steps consumed in order (a caller-supplied array is kept LIVE, so a test can
   * append steps after the engine was composed); once exhausted the default
   * deterministic echo step is used.
   */
  script?: OfflineStep[];
  /** Delay between frames in ms (0 = as fast as the microtask queue allows). */
  deltaMs?: number;
  /** Text chunk size per `text` delta frame. */
  chunkChars?: number;
  /** Summary text override for compaction requests. */
  summary?: (transcript: string) => string;
  /**
   * W729: every request the engine actually sent (`system` + messages), so a
   * test can assert WHICH system prompt each session's turn carried instead of
   * re-deriving it. Shared across instances when the caller passes one array.
   */
  onRequest?: (req: ModelRequest) => void;
}

export interface OfflineLlm extends Llm {
  /** How many `generate()` calls were served (diagnostics / assertions). */
  readonly calls: number;
}

/** Text of the last user message (the echo source / summary input). */
function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m === undefined || m.role !== "user") continue;
    return m.content.map((c) => (c.type === "text" ? c.content : "")).join("");
  }
  return "";
}

/** Deterministic usage so `cache_hit_ratio` / `context_usage` are assertable. */
export function offlineUsage(req: ModelRequest, answer: string): Usage {
  let chars = req.system?.length ?? 0;
  for (const m of req.messages) for (const c of m.content) chars += c.type === "text" ? c.content.length : 0;
  const prompt = Math.ceil(chars / 4);
  const completion = Math.max(1, Math.ceil(answer.length / 4));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cache_read: Math.floor(prompt / 2), reasoning_tokens: 0 };
}

/** True when the request is the compaction summarizer (not a chat turn). */
export function isCompactionRequest(req: ModelRequest): boolean {
  return req.system !== null && req.system.includes(COMPACT_SYSTEM_PROMPT.slice(0, 12));
}

/** The default offline summary: four sections + a stable digest of the input. */
export function offlineSummary(transcript: string): string {
  const digest = createHash("sha256").update(transcript, "utf8").digest("hex").slice(0, 12);
  const last = transcript.trimEnd().split("\n").slice(-1)[0] ?? "";
  return [
    "1) 正在进行的任务：离线确定性摘要（mock LLM），输入摘要见下方 digest。",
    "2) 已做的决策：结构由 compact 计划固定（摘要轮 + 最近 K 轮），摘要正文由本 mock 生成。",
    `3) 关键事实与文件改动：transcript ${transcript.length} 字符，digest ${digest}。`,
    `4) 待办：最近一行记录：${last.slice(0, 200)}`,
  ].join("\n");
}

/** Split text into fixed-size chunks (never splitting a code point). */
export function chunkText(text: string, size: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out.length === 0 ? [""] : out;
}

/** Assistant message of a step (tool calls win over text, like the provider). */
export function stepMessage(step: OfflineStep): Message {
  const calls = step.tool_calls ?? [];
  if (calls.length === 0) return assistantText(step.text ?? "");
  return { role: "assistant", content: calls.map((c) => ({ type: "tool_call", content: c })), tool_call_id: null };
}

/** The frame list of one scripted step (before timing is applied). */
export function stepFrames(step: OfflineStep, req: ModelRequest, chunk: number): StreamEvent[] {
  const frames: StreamEvent[] = [];
  if (step.fail !== undefined) return [{ kind: "failed", kindOf: "generate", message: step.fail }];
  if (step.interrupted === true) return [{ kind: "interrupted" }];
  const thinking = step.thinking ?? "";
  if (thinking !== "") for (const piece of chunkText(thinking, chunk)) frames.push({ kind: "thinking", text: piece });
  const text = step.text ?? "";
  if (text !== "") for (const piece of chunkText(text, chunk)) frames.push({ kind: "text", text: piece });
  frames.push({ kind: "usage", usage: offlineUsage(req, text) });
  frames.push({ kind: "done", message: stepMessage(step) });
  return frames;
}

/** Yield frames, optionally with a delay between them. */
async function* emit(frames: readonly StreamEvent[], delayMs: number): LlmStream {
  for (const frame of frames) {
    if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
    yield frame;
  }
}

/** Build the deterministic offline engine LLM. */
export function createOfflineLlm(opts: OfflineLlmOptions = {}): OfflineLlm {
  const chunk = Math.max(1, opts.chunkChars ?? 24);
  const delayMs = Math.max(0, opts.deltaMs ?? 0);
  const summary = opts.summary ?? offlineSummary;
  const script = opts.script ?? [];
  let calls = 0;

  const stepFor = (req: ModelRequest): OfflineStep => {
    if (isCompactionRequest(req)) return { text: summary(lastUserText(req)) };
    return script.shift() ?? { text: `echo: ${lastUserText(req)}` };
  };

  return {
    get calls(): number {
      return calls;
    },
    generate(req: ModelRequest): Promise<LlmStream> {
      calls += 1;
      opts.onRequest?.(req);
      return Promise.resolve(emit(stepFrames(stepFor(req), req, chunk), delayMs));
    },
  };
}
