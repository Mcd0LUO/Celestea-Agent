/**
 * Summary-input rendering + the compaction prompt
 * (port of `celestea_studio/src/compact.rs:34-54,180-262`).
 *
 * The transcript handed to the summarising model is a flat, human-readable
 * rendering of the event stream (turn headings + per-role lines), clipped twice:
 * per event (so one huge tool result cannot eat the budget) and as a whole,
 * keeping the TAIL (recent history matters more than the opening pleasantries).
 *
 * All clipping is CHARACTER-wise, never byte-wise: a CJK transcript would
 * otherwise be cut mid-code-point and the summary request would be invalid UTF-8.
 */

import { serdeJsonString, type SessionEvent } from "@celestea/core";

/** Per-event clip inside the transcript (tool results / texts). */
export const TRANSCRIPT_EVENT_MAX_CHARS = 4_000;
/** Whole-transcript clip (~60k chars) before it is sent to the model. */
export const SUMMARY_INPUT_MAX_CHARS = 60_000;
/** How much summary text is kept in the synthetic head turn. */
export const SUMMARY_KEEP_MAX_CHARS = 20_000;
/** `max_tokens` of the summarising request. */
export const SUMMARY_MAX_TOKENS = 4_096;
/** Whole-request timeout of the summarising call. */
export const SUMMARY_TIMEOUT_MS = 90_000;

/** The four-section structured summary prompt (verbatim contract text). */
export const COMPACT_SYSTEM_PROMPT =
  "你是上下文压缩器。把用户提供的会话记录压缩成一份中文结构化摘要，" +
  "必须且只需包含以下四个小节（保留小节标题）：\n" +
  "1) 正在进行的任务：当前目标、所处阶段、尚未完成的部分。\n" +
  "2) 已做的决策：已经确定的技术/方案选择及其理由，包括被否决的方案。\n" +
  "3) 关键事实与文件改动：涉及的文件路径、函数/接口名、配置项、数据结论、报错信息等可复用的硬事实。\n" +
  "4) 待办：接下来要做的事，按优先级排列。\n" +
  "要求：忠于原始记录，不得编造；保留路径、标识符、数字、命令原样；压缩冗余寒暄与重复内容；直接输出摘要正文，不要任何前言、结语或解释。";

/** Character-wise clip with a truncation marker (`clip`). */
export function clip(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, max).join("")}…（截断）`;
}

/** Keep the TAIL of a text, with a leading marker when it was cut (`clip_tail`). */
export function clipTail(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `（更早内容已截断，仅保留最近 ${max} 字符）\n${chars.slice(chars.length - max).join("")}`;
}

/** One event's transcript line (`render_transcript`'s match arms). */
export function transcriptLine(ev: SessionEvent): string {
  const quarter = TRANSCRIPT_EVENT_MAX_CHARS / 4;
  switch (ev.type) {
    case "turn_start":
      return `\n--- 轮次 ${ev.id} ---\n`;
    case "turn_end":
      return "";
    case "user_message":
      return `【用户】${clip(ev.text, TRANSCRIPT_EVENT_MAX_CHARS)}\n`;
    case "assistant_message":
      return `【助手】${clip(ev.text, TRANSCRIPT_EVENT_MAX_CHARS)}\n`;
    case "thinking_delta":
      return `【思考】${clip(ev.text, quarter)}\n`;
    case "tool_call":
      return `【工具调用】${ev.name}(${clip(serdeJsonString(ev.args ?? null), quarter)})\n`;
    case "tool_result":
      return ev.error === null
        ? `【工具结果】${clip(serdeJsonString(ev.value ?? null), quarter)}\n`
        : `【工具结果】错误：${clip(ev.error, quarter)}\n`;
  }
}

/** The whole summary input: every event line, then one tail clip. */
export function renderTranscript(events: readonly SessionEvent[], max = SUMMARY_INPUT_MAX_CHARS): string {
  let out = "";
  for (const ev of events) out += transcriptLine(ev);
  return clipTail(out, max);
}
