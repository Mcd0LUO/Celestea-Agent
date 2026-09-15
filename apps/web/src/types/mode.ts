// ============================================================================
// types/mode.ts — 会话工作方式（标准模式 / 执行模式）线格式（W788）。
//
//   权威依据：docs/modes-standard-vs-execution.md §2.2（模式是会话元数据）、
//   §3.1（P0 创建期可选 mode；P1 才有切换端点）。
//   字面量与 session.json.mode、POST /api/sessions 请求体完全一致；UI 一律
//   显示中文标签（mode 值不直接暴露给用户，设计 §8）。
//
//   为什么单独一个文件：types.ts 有模块体积棘轮（只许降不许升），按 W784 的
//   ./types/context、./types/question 先例拆出，types.ts 原样再导出。
// ============================================================================

/** 会话工作方式（与 session.json.mode 同字面量）。 */
export type SessionMode = 'standard' | 'execution';

/**
 * POST /api/sessions/{id}/mode 响应（设计 §3.1 P1）。
 *   200 → {ok:true, session, mode, effective:'next_turn'}
 *   409 → {ok:false, error}：轮次进行中（冻结文案，见 UI 侧 §3.2）
 *   404/405 → 该部署未提供该端点；400 → 非法 mode
 * effective 是**生效时机**：next_turn = 不打断在飞轮次，下一轮边界生效。
 */
export interface SessionModeResp {
  ok?: boolean;
  session?: string;
  mode?: SessionMode;
  effective?: string;
  error?: string;
}
