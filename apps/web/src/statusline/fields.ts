// ============================================================================
// statusline/fields.ts — W758 从 src/statusline.ts 拆出（纯搬运，无行为变更）：
//   状态快照字段筛选（statusline 渲染 + chat.ts 的每会话快照共用）。纯函数、
//   零 DOM，可由 node 直接加载断言。
// ============================================================================
import type { StatusSnapshot } from '../types';

/** W514：状态字段筛选（statusline 渲染 + chat.ts 的每会话快照共用）。 */
export function pickStatusFields(p: StatusSnapshot): StatusSnapshot {
  const out: StatusSnapshot = {};
  if (p.model !== undefined) out.model = p.model;
  if (p.reasoning_effort !== undefined) out.reasoning_effort = p.reasoning_effort;
  if (p.steps !== undefined) out.steps = p.steps;
  if (p.tokens_per_sec !== undefined) out.tokens_per_sec = p.tokens_per_sec;
  if (p.context_usage !== undefined) out.context_usage = p.context_usage;
  if (p.usage !== undefined) out.usage = p.usage; // W263 缓存命中率
  if (p.busy !== undefined) out.busy = p.busy; // W514 运行态
  return out;
}
