// ============================================================================
// types/history.ts — 会话历史（GET /api/sessions/{id}/messages）线格式。
//   W805：从 types.ts 整族拆出（守模块体积棘轮），并新增可选 attachments
//   （只有引用；无附件时完全省略，与既有 golden 逐字节一致）。
//   types.ts 原样再导出，调用方零改动。
// ============================================================================
import type { AttachmentRef } from './attachment';

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'thinking' | 'inbox' | 'question';

/**
 * 消息契约（W252 结构化，无兼容层）：
 *   user/assistant/thinking → content 文本；
 *   tool → kind='call'（tool_call_id/tool_name/tool_args）
 *          或 kind='result'（tool_call_id/tool_value/tool_error）。
 */
export interface HistoryMsg {
  role: HistoryRole;
  /** 普通消息文本（tool 消息无此字段）。 */
  content?: string;
  /**
   * tool 消息：'call' | 'result'；
   * user 消息（W515）：'steering'（插话）/ 'queued'（排队）；
   * 'inbox'（worker 回执 / 系统注入）；
   * W784 提问行：'question'（模型问了）/ 'answer'（作答或超时结算）。
   */
  kind?: 'call' | 'result' | 'steering' | 'queued' | 'inbox' | 'question' | 'answer';
  /**
   * W805：该 user 消息携带的图片引用（元数据）。缺省 = 无附件，字段被省略；
   * P0 无字节回读端点，历史回放只能渲染元数据（设计 §7.4 已知限制）。
   */
  attachments?: AttachmentRef[];
  /**
   * W784：提问/回答两行的请求 id（靠它配对；设计 §7.2 的「有问无答」判定）。
   * 注：这两行的 `content` 承载**数组**（问题 / 答案），而 content 字段是文本口径
   * —— 读取收口在 ui/question/format.ts 的 payloadOf()。
   */
  question_id?: string;
  /** W784：'question' 行的绝对时限。 */
  question_expires_at?: number;
  /** W784：'answer' 行是否因时限到期而结算。 */
  question_timed_out?: boolean;
  /** W515：inbox 条目的来源标记（worker id 等）。 */
  source?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_args?: unknown;
  tool_value?: unknown;
  tool_error?: string | null;
}

export interface MessagesResp {
  ok?: boolean;
  session?: string;
  messages?: HistoryMsg[];
  error?: string;
}
