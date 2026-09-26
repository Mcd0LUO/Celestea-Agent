// ============================================================================
// ui/usage/stats.ts — 「使用统计」的**纯计算**（零 DOM、零 i18n、零网络）。
// ----------------------------------------------------------------------------
//   算法逐条照抄参考实现（ZCode 的 usage-stats-builder.ts / UsageHeatmap.tsx /
//   AppUsageDailyModelTrendChart.tsx），只把框架换成纯函数：
//     · levelFor         —— >0.75→4、>0.5→3、>0.25→2、否则 1（0 用量恒 0 档）
//     · streak           —— 从今天往前扫，遇到 0 就断；最长连续另算
//     · 52 周网格        —— 按自然周对齐（每列第一行是周日）
//     · 月份标签 span    —— 相邻同月合并，超过 12 个月只留最近 12 个的文字
//     · 趋势图 Y 轴      —— 跟随**可见序列的单点峰值**（用每日总量会把曲线压扁）
//   这些函数都不依赖 DOM，因此可以直接单测（tests/w9103-usage-stats.test.ts）。
// ============================================================================
import type { DayModelPoint, DayPoint } from './model';

const DAY_MS = 86_400_000;
/** 热力图固定 52 列 × 7 行（与参考实现同口径）。 */
export const HEATMAP_WEEKS = 52;
export const HEATMAP_DAYS = 7;
/** 底部月份标签最多显示 12 个月（52 周可能横跨 13 个月）。 */
export const VISIBLE_MONTH_LABELS = 12;
/** 趋势图最多画 6 条模型序列。 */
export const TOP_MODELS = 6;

/** 0–4 五档。0 用量或全零数据恒为 0（不画「有活动」的假格子）。 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** 用 UTC 日历分量做日期算术（账本的 key 就是 UTC 日期，不引入本地时区偏移）。 */
export function dayIndexOf(dateKey: string): number {
  return Math.floor(Date.parse(dateKey + 'T00:00:00.000Z') / DAY_MS);
}

/** dayIndex → `YYYY-MM-DD`。 */
export function dateOfDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

/** UTC 星期（0 = 周日）。列内第一行是周日，网格据此对齐。 */
export function utcWeekday(dayIndex: number): number {
  return new Date(dayIndex * DAY_MS).getUTCDay();
}

/**
 * 用量 → 0–4 档。`tokens<=0` 或 `max<=0` 恒 0（后者避免除零，也避免「全零数据
 * 却整片亮起」）。边界取**严格大于**，与参考实现一致。
 */
export function levelFor(tokens: number, max: number): HeatLevel {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

/** 一格热力图。 */
export interface HeatCell {
  date: string;
  level: HeatLevel;
  totalTokens: number;
  turnCount?: number;
  toolCallCount?: number;
}

/** 一列（一周，7 格；不足 7 天补 0 格）。 */
export interface HeatWeek {
  weekIndex: number;
  days: HeatCell[];
}

export interface Heatmap {
  startDate: string;
  endDate: string;
  maxTokens: number;
  weeks: HeatWeek[];
}

function emptyCell(date: string): HeatCell {
  return { date, level: 0, totalTokens: 0 };
}

/**
 * 52 周 × 7 天网格。
 *   窗口**锚定在 endDate 所在自然周的周六**（每列第一行是周日），向前铺 52 列 ——
 *   于是最近的活动恒在右下角，今天所在的一周恒在最右列（GitHub 式贡献图的读法）。
 *   数据窗口之外补 0 格：缺数据与「当天没有用量」在视觉上是同一件事（都是没用量），
 *   但**只有真的有这一天的数据**才会带 turn/tool 明细。
 */
export function buildHeatmap(days: DayPoint[], endDate: string): Heatmap {
  const byDate = new Map(days.map((d) => [d.date, d] as const));
  const maxTokens = days.reduce((m, d) => (d.totalTokens > m ? d.totalTokens : m), 0);
  const endDayIndex = dayIndexOf(endDate);
  const endWeekStart = endDayIndex - utcWeekday(endDayIndex);
  const startDayIndex = endWeekStart - (HEATMAP_WEEKS - 1) * HEATMAP_DAYS;

  const weeks: HeatWeek[] = [];
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const cells: HeatCell[] = [];
    for (let d = 0; d < HEATMAP_DAYS; d++) {
      const date = dateOfDayIndex(startDayIndex + w * HEATMAP_DAYS + d);
      const point = byDate.get(date);
      if (!point) {
        cells.push(emptyCell(date));
        continue;
      }
      const cell: HeatCell = {
        date,
        level: levelFor(point.totalTokens, maxTokens),
        totalTokens: point.totalTokens,
      };
      // 只有真的带了才写键 —— 写 0 会被读成「当天确实没有工具调用」。
      if (point.turnCount !== undefined) cell.turnCount = point.turnCount;
      if (point.toolCallCount !== undefined) cell.toolCallCount = point.toolCallCount;
      cells.push(cell);
    }
    weeks.push({ weekIndex: w, days: cells });
  }
  return {
    startDate: dateOfDayIndex(startDayIndex),
    endDate: dateOfDayIndex(startDayIndex + HEATMAP_WEEKS * HEATMAP_DAYS - 1),
    maxTokens,
    weeks,
  };
}

/** 摘要条（5 格）的数据。`longestSessionMs` 为 null = 数据源答不了（不编）。 */
export interface UsageSummary {
  totalTokens: number;
  peakDayTokens: number;
  activeDays: number;
  currentStreakDays: number;
  longestStreakDays: number;
  longestSessionMs: number | null;
}

/**
 * 从今天往前扫的连续天数统计。
 *   当前连续 = 从 `endDate` 起**连续**有 token 的天数（今天为 0 ⇒ 0，不是「昨天起算」）；
 *   最长连续 = 窗口内任意一段连续有 token 的最长长度。
 *   两段分开算，因为「今天断了」不该抹掉历史最长记录。
 *
 *   `longestSessionMs` 由**调用方**从 `group_by=session` 的 first_ts/last_ts 传入
 *   （本函数只看按天数据，答不了「一次会话持续多久」）；缺省 null = 数据源答不了，
 *   界面显示 `—`，绝不编 0。
 */
export function buildSummary(
  days: DayPoint[],
  endDate: string,
  longestSessionMs: number | null = null,
): UsageSummary {
  const totalTokens = days.reduce((s, d) => s + d.totalTokens, 0);
  const peakDayTokens = days.reduce((m, d) => (d.totalTokens > m ? d.totalTokens : m), 0);
  const byDate = new Map(days.map((d) => [d.date, d.totalTokens] as const));
  const endDayIndex = dayIndexOf(endDate);
  const startDayIndex =
    days.length > 0
      ? days.reduce((m, d) => Math.min(m, dayIndexOf(d.date)), endDayIndex)
      : endDayIndex;

  let activeDays = 0;
  let currentStreakDays = 0;
  let longestStreakDays = 0;
  let running = 0;
  let streakBroken = false;
  for (let di = endDayIndex; di >= startDayIndex; di--) {
    const tokens = byDate.get(dateOfDayIndex(di)) ?? 0;
    if (tokens > 0) {
      activeDays++;
      running++;
      if (running > longestStreakDays) longestStreakDays = running;
      if (!streakBroken) currentStreakDays++;
    } else {
      // 第一个 0 就是「当前连续」的断点；再往前的 0 只影响 running。
      streakBroken = true;
      running = 0;
    }
  }
  return {
    totalTokens,
    peakDayTokens,
    activeDays,
    currentStreakDays,
    longestStreakDays,
    longestSessionMs,
  };
}

/** 底部月份标签：相邻同月合并成一条，`span` = 该月占了几列。 */
export interface MonthLabel {
  key: string;
  /** 月份（`YYYY-MM`），渲染层据此本地化；空串 = 文字被隐藏（保留 span 以对齐列）。 */
  month: string;
  span: number;
}

/**
 * 一列归入哪个月：**周内包含 1 日就归入新月份**，否则按周日所在月。
 *   用周日判断会把非周日的每月 1 日推迟到下一周，月份文案最多错开一列。
 */
export function monthDateOfWeek(week: HeatWeek): string {
  const first = week.days.find((c) => c.date.endsWith('-01'));
  if (first) return first.date;
  return week.days[0]?.date ?? '';
}

/**
 * 月份标签（按列 span 合并）。52 周可能横跨 13 个月，直接全画会在底部同时出现
 * 去年与今年的同月文案 —— 保留多余起始月份的 span（维持对齐），只清空其文字，
 * 于是底部最多显示**最近 12 个月**。
 */
export function buildMonthLabels(weeks: HeatWeek[]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  for (const week of weeks) {
    const monthDate = monthDateOfWeek(week);
    const month = monthDate.slice(0, 7);
    const last = labels[labels.length - 1];
    if (last && last.month === month) {
      last.span++;
      continue;
    }
    labels.push({ key: month + '#' + String(week.weekIndex), month, span: 1 });
  }
  const hidden = Math.max(0, labels.length - VISIBLE_MONTH_LABELS);
  for (let i = 0; i < hidden; i++) {
    const label = labels[i];
    if (label) label.month = '';
  }
  return labels;
}

/** 每周/累计模式下，一列的填充格数（自下往上填，最少 1 格、最多 7 格）。 */
export function filledRowsFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const rows = Math.ceil((value / max) * HEATMAP_DAYS);
  return Math.min(HEATMAP_DAYS, Math.max(1, rows));
}

/** 热力图三种模式：每日 / 每周 / 累计。 */
export type HeatMode = 'daily' | 'weekly' | 'cumulative';

/** 一列在**当前模式**下要画的格子（weekly/cumulative 自下往上填）。 */
export interface HeatColumn {
  key: string;
  monthDate: string;
  /** 该列的汇总值（daily 模式为 null：每格各画各的）。 */
  value: number | null;
  cells: HeatCell[];
}

/**
 * 把 52 周网格摊成「显示列」。weekly = 该周合计；cumulative = 到该周为止的累计。
 *   两档的档位都相对**本模式自己的最大值**（否则累计模式最后一列永远是最深档，
 *   前面全被压成最浅档，读不出节奏）。
 */
export function buildColumns(weeks: HeatWeek[], mode: HeatMode): HeatColumn[] {
  if (mode === 'daily') {
    return weeks.map((w) => ({
      key: 'daily-' + String(w.weekIndex),
      monthDate: monthDateOfWeek(w),
      value: null,
      cells: w.days,
    }));
  }
  const weekTotals = weeks.map((w) => w.days.reduce((s, c) => s + c.totalTokens, 0));
  const values: number[] = [];
  let running = 0;
  for (const total of weekTotals) {
    running = mode === 'cumulative' ? running + total : total;
    values.push(running);
  }
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  return weeks.map((w, i) => {
    const value = values[i] ?? 0;
    const level = levelFor(value, max);
    const filled = filledRowsFor(value, max);
    return {
      key: mode + '-' + String(w.weekIndex),
      monthDate: monthDateOfWeek(w),
      value,
      cells: w.days.map((cell, offset) => ({
        // 自下往上填：最后 offset 格是亮的。
        date: cell.date,
        level: offset >= HEATMAP_DAYS - filled ? level : 0,
        totalTokens: cell.totalTokens,
      })),
    };
  });
}

// ---- 趋势图（每日 Token，按模型分序列） --------------------------------------

/** 一条模型序列。 */
export interface ChartSeries {
  modelId: string;
  /** 每个日期一个点（与 `dates` 等长；缺的日期补 0）。 */
  values: number[];
}

export interface ChartData {
  dates: string[];
  series: ChartSeries[];
  /**
   * Y 轴上限 = **可见序列的单点峰值**。
   *   图中是独立折线而非堆叠图：用每日总量当上限会把多模型之和（以及被截掉的
   *   模型）算进来，实际可见曲线被压在底部 —— 这正是参考实现注释里踩过的坑。
   */
  maxTokens: number;
}

/**
 * 按模型聚合的每日序列 → 图表数据。
 *   · 模型按区间内总量降序取前 `topN`（其余不画，也**不参与** Y 轴与日期轴）；
 *   · 日期轴取**被选中模型**出现过的日期并集升序 —— 某天只有被截掉的模型在用时
 *     不画那一列：否则可见序列会在末尾多出一个全是 0 的假「低谷」；
 *   · 缺的日期补 0（折线要连续，不能跳点）。
 */
export function buildChart(points: DayModelPoint[], topN = TOP_MODELS): ChartData {
  const totals = new Map<string, number>();
  for (const p of points) {
    if (p.date === '' || p.totalTokens <= 0) continue;
    totals.set(p.modelId, (totals.get(p.modelId) ?? 0) + p.totalTokens);
  }
  const topIds = [...totals.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, topN)
    .map(([id]) => id);
  const visible = new Set(topIds);

  const dates = new Set<string>();
  for (const p of points) {
    if (p.date === '' || p.totalTokens <= 0) continue;
    if (visible.has(p.modelId)) dates.add(p.date);
  }
  const sortedDates = [...dates].sort();

  const index = new Map(sortedDates.map((d, i) => [d, i] as const));
  const series: ChartSeries[] = topIds.map((modelId) => ({
    modelId,
    values: new Array<number>(sortedDates.length).fill(0),
  }));
  const seriesOf = new Map(series.map((s) => [s.modelId, s] as const));
  for (const p of points) {
    const s = seriesOf.get(p.modelId);
    const i = index.get(p.date);
    if (!s || i === undefined || p.totalTokens <= 0) continue;
    s.values[i] = (s.values[i] ?? 0) + p.totalTokens;
  }
  let maxTokens = 0;
  for (const s of series) {
    for (const v of s.values) if (v > maxTokens) maxTokens = v;
  }
  return { dates: sortedDates, series, maxTokens };
}

/**
 * X 轴刻度抽稀：≤14 天全画；>45 天每 7 个画一个，否则每 5 个；首尾恒画。
 *   首尾必须画 —— 否则用户看不到区间的起止日期。
 */
export function shouldShowAxisLabel(index: number, total: number): boolean {
  if (total <= 14) return true;
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}
