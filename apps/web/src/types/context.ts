// ============================================================================
// types/context.ts — W726 只读上下文快照的线格式（点状态栏上下文圆环查看）。
//
// W784：**纯搬家**。这段原本长在 `src/types.ts` 尾部，而 `types.ts` 已用满自己的
// 模块体积上限（657/657，棘轮只许降不许升），本轮提问卡片必须往 `types.ts` 加类型
// —— 于是按 `tools/check-module-size.mjs` 的规矩「超了就拆」把这段自成一体的快照
// 类型挪出来，由 `src/types.ts` 原样再导出（import 路径与拆分前逐字兼容，
// api.ts / ui/contextview.ts 一行未改）。
// ============================================================================

/** 工具（名称 + 说明 + 参数结构）。 */
export interface ContextToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  /** 该条目超长被服务端截断。 */
  truncated?: boolean;
}

/** 一条消息（role: user / assistant / tool）。 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  /** 该条目超长被服务端截断。 */
  truncated?: boolean;
}

export interface ContextCounts {
  system_chars?: number;
  tool_count?: number;
  message_count?: number;
}

export interface ContextUsageInfo {
  used?: number;
  window?: number;
  ratio?: number;
  /** 用量为估算值（非精确计量）。 */
  estimated?: boolean;
}

export interface SessionContextResp {
  ok?: boolean;
  session?: string;
  model?: string;
  system?: string;
  tools?: ContextToolInfo[];
  messages?: ContextMessage[];
  counts?: ContextCounts;
  context?: ContextUsageInfo;
  /** 整份快照存在被截断的条目。 */
  truncated?: boolean;
  error?: string;
}
