// ============================================================================
// types/goal.ts — A3：持久目标（POST /api/sessions/{id}/goal）。
//   冻结契约（架构侧 2026-09-19）：body { text }（空串 = 清除/完成）；
//   200 = { ok, goal: { text, createdAt, updatedAt } | null }。
//   目标不驱动自动续跑（P0 明确不做）：只做「持久可见 + 每轮注入上下文」。
// ============================================================================

/** 一个持久目标（服务端回声）。 */
export interface GoalInfo {
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/sessions/{id}/goal 响应；goal=null 表示当前无目标。 */
export interface GoalResp {
  ok?: boolean;
  goal?: GoalInfo | null;
  error?: string;
}
