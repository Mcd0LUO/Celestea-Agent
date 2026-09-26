// ============================================================================
// types/usage.ts — 「使用统计」的线上形状（GET /api/usage/ledger）。
//   放在独立文件的原因与 ./goal、./plugin 同款：types.ts 有模块体积棘轮，
//   本轮不追加它的行数（先例：ui/attachments.ts 直接 import ./types/attachment）。
//   字段全部可选 —— 老服务可能缺项，调用方必须按「缺失 ≠ 0」处理。
// ============================================================================

/** 一行账本聚合的 token 明细。 */
export interface UsageLedgerTokens {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_read?: number;
  reasoning_tokens?: number;
}

/** 一行聚合结果。`cost` 为 `null` = 未定价（**未知**，不是 0）。 */
export interface UsageLedgerRow {
  key?: string;
  tokens?: UsageLedgerTokens;
  cost?: unknown;
  records?: number;
  unpriced_records?: number;
}

/**
 * `GET /api/usage/ledger` 的响应体。
 *   `ok:false`（HTTP 200，请求被理解了）表示**这里没有账本**：
 *   `usage ledger disabled` / `usage ledger unavailable`。
 *   网络失败与 5xx 由 api.ts 抛 ApiError，与这个分支是两件事。
 */
export interface UsageLedgerResp {
  ok?: boolean;
  error?: string;
  currency?: string;
  group_by?: string;
  rows?: UsageLedgerRow[];
  unpriced_models?: string[];
  price_version?: string | null;
}

/** `GET /auth/check`：`{ok:true,user:"<用户名>"}`；未登录 401（api.ts 抛错）。 */
export interface AuthCheckResp {
  ok?: boolean;
  user?: string;
}
