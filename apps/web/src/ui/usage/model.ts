// ============================================================================
// ui/usage/model.ts — 「使用统计」的数据形状与解析（纯函数，零 DOM、零 i18n）。
// ----------------------------------------------------------------------------
//   唯一数据源是**已有**的用量账本聚合（GET /api/usage/ledger），本模块只做
//   「线上形状 → 领域形状」的解析与校验，不新增任何聚合口径、不读契约外的字段。
//
//   三条诚实纪律（照抄账本自己的口径）：
//     · cost 可能是 null —— **未知价格不是 0**。本模块把 null 原样保留（不 `?? 0`），
//       页面据此显示「未定价」而不是 ¥0；
//     · `ok:false` 是「这里没有账本」（HTTP 200，请求被理解了），与网络/500 失败
//       是**两件事**，因此分成三种 reason 分别说明；
//     · 契约里没有的字段就不编 —— 账本按**步骤行**折叠（一次模型请求一行），
//       它既没有轮数、也没有工具调用数、更没有时间跨度。有则显示，无则省略。
// ============================================================================

/** 一行账本携带的 token 明细（字段全部可选：老服务可能缺项）。 */
export interface LedgerTokens {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cache_read?: number;
  reasoning_tokens?: number;
}

/** 一行聚合结果（`group_by` 决定的 key + 累计量）。 */
export interface LedgerRow {
  key?: string;
  tokens?: LedgerTokens;
  /** `null` = 该组没有一行被定价（**未知**，不是 0）。 */
  cost?: unknown;
  records?: number;
  unpriced_records?: number;
  /**
   * 该组的时间跨度（epoch **秒**）：组内最旧/最新一条步骤行的 `ts`。
   * 后端已补这两个键；老服务没有 ⇒ 调用方如实显示 `—`，**不编数**。
   */
  first_ts?: number;
  last_ts?: number;
}

/** 聚合响应体（`ok:false` 时只有 `ok` + `error`）。 */
export interface LedgerResp {
  ok?: boolean;
  error?: string;
  currency?: string;
  group_by?: string;
  rows?: LedgerRow[];
  unpriced_models?: string[];
  price_version?: string | null;
  totals?: { cost?: unknown; unpriced_models?: string[]; records?: number };
}

/** 读不出来的三种原因 —— 三句不同的话，不合并成一句「加载失败」。 */
export type LedgerFailure = 'disabled' | 'unavailable' | 'unreadable';

/** 一天的活动（热力图与摘要条的唯一输入单位）。 */
export interface DayPoint {
  /** UTC 日期 `YYYY-MM-DD`（账本 `day` 维度的 key 就是这个）。 */
  date: string;
  totalTokens: number;
  /** 账本不提供 → 省略（不写 0，0 会被读成「当天确实没有工具调用」）。 */
  turnCount?: number;
  toolCallCount?: number;
}

/**
 * 费用视图。**未知价格不是 0**：
 *   `total === null` ⇒ 这个区间里没有任何一行被定价，界面必须显示「未定价」；
 *   `unpricedModels` 列出价格表覆盖不到的模型，界面据此说明「为什么未定价」。
 */
export interface CostView {
  total: number | null;
  currency: string;
  unpricedModels: string[];
}

/** 解析结果：要么有数据，要么有一个**说得清**的原因。 */
export type LedgerRead =
  | { ok: true; days: DayPoint[]; cost: CostView }
  | { ok: false; reason: LedgerFailure };

/** 有限数才认，其余（缺项 / null / NaN / 字符串）一律当 0 —— 但**不**用于 cost。 */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 有限数才认；否则 null（**保持未知**，与 `num` 的「当 0」是两种语义）。 */
export function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` 且真的是一个合法日期（挡住 2026-13-45 这类）。 */
export function isDateKey(v: unknown): boolean {
  if (typeof v !== 'string' || !DATE_KEY.test(v)) return false;
  const ms = Date.parse(v + 'T00:00:00.000Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

/** 服务端的 `error` 文案 → 三种原因之一（未知一律归入「读不出来」）。 */
export function failureOf(error: unknown): LedgerFailure {
  const text = typeof error === 'string' ? error : '';
  if (text.includes('disabled')) return 'disabled';
  if (text.includes('unavailable')) return 'unavailable';
  return 'unreadable';
}

/**
 * 费用：优先读 `totals.cost`（整个区间），回落成逐行相加。
 *   两条路径都**保持 null 语义** —— 一行都没定价时结果是 null（未知），不是 0。
 */
function costOf(resp: LedgerResp): CostView {
  const currency = typeof resp.currency === 'string' ? resp.currency : '';
  const models = resp.unpriced_models ?? resp.totals?.unpriced_models ?? [];
  const unpricedModels = Array.isArray(models) ? models.filter((m) => typeof m === 'string') : [];
  const fromTotals = resp.totals === undefined ? null : numOrNull(resp.totals.cost);
  if (fromTotals !== null) return { total: fromTotals, currency, unpricedModels };
  let sum: number | null = null;
  for (const row of resp.rows ?? []) {
    const c = numOrNull(row.cost);
    if (c !== null) sum = (sum ?? 0) + c;
  }
  return { total: sum, currency, unpricedModels };
}

/**
 * 聚合响应 → 按天升序的 DayPoint[]（+ 费用视图）。
 *   · `ok:false` ⇒ 如实回报原因（不伪造空数组，那会被画成「真的没有用量」）；
 *   · 非法日期 key 的行**丢弃**（宁可少一天，也不把垃圾画进热力图）；
 *   · 同一天出现多行时相加（正常不会，但相加比覆盖更不容易丢量）。
 */
export function parseLedgerDays(resp: LedgerResp): LedgerRead {
  if (resp.ok !== true) return { ok: false, reason: failureOf(resp.error) };
  const rows = Array.isArray(resp.rows) ? resp.rows : [];
  const byDate = new Map<string, DayPoint>();
  for (const row of rows) {
    if (!isDateKey(row.key)) continue;
    const key = row.key as string;
    const total = num(row.tokens?.total_tokens);
    const prev = byDate.get(key);
    if (prev) prev.totalTokens += total;
    else byDate.set(key, { date: key, totalTokens: total });
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, days, cost: costOf(resp) };
}

/** 一天里某个模型的用量（趋势图的输入单位）。 */
export interface DayModelPoint {
  date: string;
  modelId: string;
  totalTokens: number;
}

/** 账本自己给「模型没上报」的占位标签（照抄 `UNKNOWN_MODEL_LABEL`）。 */
export const UNKNOWN_MODEL = '(unknown model)';

/** `day_model` 维度的 key 分隔符（`<YYYY-MM-DD>|<model>`）。 */
export const DAY_MODEL_SEP = '|';

/**
 * 模型维度的聚合响应 → 某一天的 (模型, token) 明细。
 *   `date` 留空由调用方填（逐日开窗时调用方知道是哪一天）。
 */
export function parseLedgerModels(resp: LedgerResp): DayModelPoint[] {
  if (resp.ok !== true) return [];
  const rows = Array.isArray(resp.rows) ? resp.rows : [];
  const out: DayModelPoint[] = [];
  for (const row of rows) {
    const modelId = typeof row.key === 'string' ? row.key.trim() : '';
    const total = num(row.tokens?.total_tokens);
    // 0 用量的模型没有可见趋势点，收进来只会让图例变长、Y 轴被无关序列影响。
    if (total <= 0) continue;
    out.push({ date: '', modelId: modelId === '' ? UNKNOWN_MODEL : modelId, totalTokens: total });
  }
  return out;
}

/**
 * `day_model` 维度（一次请求拿全区间）→ (日期, 模型, token) 明细。
 *   key = `"<YYYY-MM-DD>|<model>"`；日期非法或总量为 0 的行丢弃。
 *   模型名里若本身含 `|`，只按**第一个**分隔符切（模型名原样保留）。
 */
export function parseDayModel(resp: LedgerResp): DayModelPoint[] {
  if (resp.ok !== true) return [];
  const rows = Array.isArray(resp.rows) ? resp.rows : [];
  const out: DayModelPoint[] = [];
  for (const row of rows) {
    const key = typeof row.key === 'string' ? row.key : '';
    const at = key.indexOf(DAY_MODEL_SEP);
    if (at < 0) continue;
    const date = key.slice(0, at);
    if (!isDateKey(date)) continue;
    const raw = key.slice(at + 1).trim();
    const total = num(row.tokens?.total_tokens);
    if (total <= 0) continue;
    out.push({ date, modelId: raw === '' ? UNKNOWN_MODEL : raw, totalTokens: total });
  }
  return out;
}

/**
 * 「最长聊天时长」：对 `group_by=session` 的每行取 `last_ts - first_ts` 的最大值（毫秒）。
 *   没有任何一行带全这两个时间戳 ⇒ **null**（数据源答不了，如实显示 `—`，不编 0）。
 */
export function longestSessionMs(resp: LedgerResp): number | null {
  if (resp.ok !== true) return null;
  const rows = Array.isArray(resp.rows) ? resp.rows : [];
  let best: number | null = null;
  for (const row of rows) {
    const first = numOrNull(row.first_ts);
    const last = numOrNull(row.last_ts);
    if (first === null || last === null) continue;
    // 负跨度是不可能的（同一行的 min<=max）；真出现就当 0，不倒扣。
    const span = Math.max(0, last - first) * 1000;
    if (best === null || span > best) best = span;
  }
  return best;
}
