// ============================================================================
// ui/usage/fetch.ts — 「使用统计」的取数（唯一 fetch 出口是 ../api）。
// ----------------------------------------------------------------------------
//   数据源只有**一个**已存在的端点：GET /api/usage/ledger。三次请求：
//     · `group_by=day`       —— 热力图 + 摘要条（key 就是 UTC 日期 `YYYY-MM-DD`）；
//     · `group_by=day_model` —— 趋势图（一次拿全区间，key = `<date>|<model>`）；
//     · `group_by=session`   —— 「最长聊天时长」（每行的 last_ts - first_ts）。
//
//   趋势图**两条路径**（按派工者通告：主路径 day_model，回退逐日开窗）：
//     新服务：`day_model` 一次请求拿全区间（day×model 交叉维度）；
//     老服务：该维度不存在 ⇒ **422**，此时回退成「对区间内每一天各发一次
//             `group_by=model&since=<当天>&until=<当天 23:59:59>`」。
//     回退不是返工而是必要的兼容：端点契约冻结、老服务仍在跑（本机 3777 实测 422）。
//     实测扇出成本（本机生产实例，30 天窗口）：顺序 87ms / 并发 36ms —— 账本是本地
//     文件、按秒解析，这点扇出可接受；仍**串行化**，不给服务端制造突发。
//
//   区间口径：`until` 取「今天 23:59:59」而不是「现在」，因为账本的 `ts` 是秒级、
//   闭区间，取整点会漏掉今天最后一秒内的行。
// ============================================================================
import { api } from '../../api';
import {
  longestSessionMs,
  parseDayModel,
  parseLedgerDays,
  parseLedgerModels,
  type DayModelPoint,
  type LedgerRead,
} from './model';

const DAY_SEC = 86_400;

/** 一次取数的完整结果（趋势图失败不影响热力图与摘要条）。 */
export interface UsageData {
  /** 热力图 + 摘要条的输入。 */
  ledger: LedgerRead;
  /** 趋势图的输入；取数失败时为空数组（图自己显示空态）。 */
  trend: DayModelPoint[];
  /** 「最长聊天时长」（毫秒）；数据源答不了时 null（界面显示 `—`）。 */
  longestSessionMs: number | null;
}

/** `YYYY-MM-DD` → 当天 00:00:00 UTC 的 epoch 秒。 */
export function dayStartSec(dateKey: string): number {
  return Math.floor(Date.parse(dateKey + 'T00:00:00.000Z') / 1000);
}

/** 今天（UTC）的 `YYYY-MM-DD` —— 账本的 day key 就是 UTC 口径。 */
export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 最近 `days` 天的 UTC 日期，**升序**（最后一个是今天）。 */
export function recentDays(days: number, now = Date.now()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now - i * DAY_SEC * 1000).toISOString().slice(0, 10));
  }
  return out;
}

/** 422 = 该 `group_by` 值不被这个服务认识（老服务没有 `day_model`）。 */
function isUnsupported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 422;
}

/**
 * 取整个区间的按天用量（一次请求）+ 趋势图 + 最长聊天时长。
 *   热力图与摘要条要的是**全量**（累计口径），因此 `day` 那次请求**不带**
 *   since/until：窗口在本地按 52 周网格裁，这样「累计 Token 数」才是真的累计。
 *   三次请求互相独立：任一次失败只影响它自己那块（其余照常显示）。
 */
export async function loadUsage(rangeDays: number, now = Date.now()): Promise<UsageData> {
  const ledgerResp = await api.usageLedger({ group_by: 'day' });
  const ledger = parseLedgerDays(ledgerResp);
  if (!ledger.ok) return { ledger, trend: [], longestSessionMs: null };
  const [trend, longest] = await Promise.all([
    loadTrend(rangeDays, now),
    loadLongestSession(),
  ]);
  return { ledger, trend, longestSessionMs: longest };
}

/** 最长聊天时长：`group_by=session` 的每行取 `last_ts - first_ts` 的最大值。 */
async function loadLongestSession(): Promise<number | null> {
  try {
    return longestSessionMs(await api.usageLedger({ group_by: 'session' }));
  } catch {
    return null; // 取不到 ⇒ null（界面显示 —，不编 0）
  }
}

/** 趋势图：优先一次拿全区间（`day_model`），老服务 422 时回退逐日开窗。 */
async function loadTrend(rangeDays: number, now: number): Promise<DayModelPoint[]> {
  const days = recentDays(rangeDays, now);
  try {
    const resp = await api.usageLedger({ group_by: 'day_model' });
    const points = parseDayModel(resp);
    if (points.length > 0) return points;
    // 空结果也可能是「这个服务不认这个维度但没报错」——继续走回退更稳。
  } catch (err) {
    if (!isUnsupported(err)) return [];
  }
  return loadTrendByDay(days);
}

/**
 * 回退路径：对每一天取一次 `group_by=model`。
 *   串行 + 逐日 try/catch —— 某一天取不到只是那天的线断一格（补 0），
 *   不能让整个趋势图消失；全部失败时返回空数组，图显示空态。
 */
async function loadTrendByDay(days: string[]): Promise<DayModelPoint[]> {
  const out: DayModelPoint[] = [];
  for (const date of days) {
    const start = dayStartSec(date);
    try {
      const resp = await api.usageLedger({
        group_by: 'model',
        since: start,
        until: start + DAY_SEC - 1,
      });
      for (const point of parseLedgerModels(resp)) out.push({ ...point, date });
    } catch {
      // 单日失败：跳过（该日补 0），不影响其它天与热力图。
    }
  }
  return out;
}
