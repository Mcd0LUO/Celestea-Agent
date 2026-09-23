// ============================================================================
// types/tool-events.ts — W1467：工具类 SSE 事件的线格式（从 types.ts 拆出）。
//
//   为什么单独成模块：`types.ts` 撞上了前端模块体积棘轮（baseline 559 行），
//   而 W1467 要给 tool / tool_result 两个 payload 各加一个 parent_id 字段。
//   按棘轮规矩「要么拆、要么登记」，这里拆 —— 纯搬家 + 两个新字段，
//   `types.ts` 原样再导出，调用方零改动。
// ============================================================================

import type { SseMeta } from '../types';

/**
 * `tool` 事件：模型发起一次工具调用。
 *
 * W1467：`parent_id` 只在 **run_code 子调用**帧上出现 —— 那是程序里
 * `tools.read_file(...)` 之类的 SDK 桥接调用，由 broker 派发并记录
 * （`packages/tools/src/run-code/broker.ts`），模型看到的始终只有外层那一次
 * run_code。子调用自己的 id 形如 `<parent_id>:c<n>`。
 *
 * 契约位置：`contracts/sse-events.json` 的 `payloadExtensions.tool`。
 * 缺省 = 顶层调用（老服务不发这个键，渲染与改动前逐字一致）。
 */
export interface ToolPayload extends SseMeta {
  id: string;
  name?: string;
  args?: unknown;
  parent_id?: string;
}

/**
 * `tool_result` 事件：一次工具调用的结果。
 *
 * W1467：`parent_id` 与 [ToolPayload.parent_id] 同源同义（同一个 run_code 调用
 * 的 id），声明在 `payloadExtensions.tool_result`。
 */
export interface ToolResultPayload extends SseMeta {
  id: string;
  ok?: boolean;
  value?: unknown;
  render?: string;
  error?: string | null;
  decision?: 'allow' | 'deny' | 'ask' | null;
  parent_id?: string;
}
