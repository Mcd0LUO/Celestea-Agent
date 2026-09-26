/**
 * W9103 · 使用统计的**纯函数**单测（level 分档 / streak / 月份 span / 图表数据 / 解析）。
 *
 * 这些函数不依赖 DOM，所以直接 import 前端模块（与 tests/ 里其它前端用例同款：
 * pathToFileURL 动态 import，不复刻逻辑）。i18n 的 `t()` 在 node 下可用（无 DOM 依赖）。
 */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const WEB = join(process.cwd(), 'apps', 'web', 'src');
const at = (rel: string): string => pathToFileURL(join(WEB, rel)).href;

interface StatsMod {
  levelFor(tokens: number, max: number): number;
  buildSummary(
    days: { date: string; totalTokens: number }[],
    endDate: string,
    longestSessionMs?: number | null,
  ): {
    totalTokens: number;
    peakDayTokens: number;
    activeDays: number;
    currentStreakDays: number;
    longestStreakDays: number;
    longestSessionMs: number | null;
  };
  buildHeatmap(days: { date: string; totalTokens: number }[], endDate: string): {
    startDate: string;
    endDate: string;
    maxTokens: number;
    weeks: { weekIndex: number; days: { date: string; level: number; totalTokens: number }[] }[];
  };
  buildMonthLabels(weeks: unknown[]): { month: string; span: number }[];
  buildChart(
    points: { date: string; modelId: string; totalTokens: number }[],
    topN?: number,
  ): { dates: string[]; series: { modelId: string; values: number[] }[]; maxTokens: number };
  shouldShowAxisLabel(index: number, total: number): boolean;
  buildColumns(weeks: unknown[], mode: string): { value: number | null; cells: unknown[] }[];
  utcWeekday(dayIndex: number): number;
  dayIndexOf(dateKey: string): number;
}

interface ModelMod {
  parseLedgerDays(resp: unknown): {
    ok: boolean;
    days?: { date: string; totalTokens: number }[];
    cost?: { total: number | null; currency: string; unpricedModels: string[] };
    reason?: string;
  };
  parseLedgerModels(resp: unknown): { date: string; modelId: string; totalTokens: number }[];
  parseDayModel(resp: unknown): { date: string; modelId: string; totalTokens: number }[];
  longestSessionMs(resp: unknown): number | null;
  failureOf(error: unknown): string;
  isDateKey(v: unknown): boolean;
  numOrNull(v: unknown): number | null;
}

let stats: StatsMod;
let model: ModelMod;

async function load(): Promise<void> {
  if (!stats) stats = (await import(/* @vite-ignore */ at('ui/usage/stats.ts'))) as StatsMod;
  if (!model) model = (await import(/* @vite-ignore */ at('ui/usage/model.ts'))) as ModelMod;
}

const day = (date: string, totalTokens: number): { date: string; totalTokens: number } => ({
  date,
  totalTokens,
});

/**
 * 分组 1：分档 / 连续天数 / 热力图网格 / 月份标签（几何与档位口径）。
 * 分成两个 describe 是因为本仓 eslint 对 tests/** 的单函数上限是 150 行
 * （eslint.config.js 的 arch/size-tests），一个 describe 装不下全部断言。
 */
describe('W9103 · 使用统计纯函数（几何与档位）', () => {
  it('levelFor：分档边界（>0.75→4 / >0.5→3 / >0.25→2 / 否则 1；0 与 max<=0 恒 0）', async () => {
    await load();
    const { levelFor } = stats;
    // 边界是**严格大于**：正好落在 0.75 的算 3 档，不是 4。
    expect(levelFor(76, 100)).toBe(4);
    expect(levelFor(75, 100)).toBe(3);
    expect(levelFor(51, 100)).toBe(3);
    expect(levelFor(50, 100)).toBe(2);
    expect(levelFor(26, 100)).toBe(2);
    expect(levelFor(25, 100)).toBe(1);
    expect(levelFor(1, 100)).toBe(1);
    // 0 用量恒 0 档（不画「有活动」的假格子）；max<=0 同理（全零数据不该整片亮）。
    expect(levelFor(0, 100)).toBe(0);
    expect(levelFor(-5, 100)).toBe(0);
    expect(levelFor(5, 0)).toBe(0);
    expect(levelFor(0, 0)).toBe(0);
  });

  it('buildSummary：累计/峰值/当前连续/最长连续（含「今天为 0 但昨天有」）', async () => {
    await load();
    // 今天（09-26）为 0，09-25 / 09-24 有：当前连续 = 0，最长连续 = 2。
    const s = stats.buildSummary(
      [day('2026-09-24', 10), day('2026-09-25', 20), day('2026-09-26', 0)],
      '2026-09-26',
    );
    expect(s.totalTokens).toBe(30);
    expect(s.peakDayTokens).toBe(20);
    expect(s.activeDays).toBe(2);
    expect(s.currentStreakDays, '今天为 0 ⇒ 当前连续断在今天').toBe(0);
    expect(s.longestStreakDays, '历史最长记录不被今天的断点抹掉').toBe(2);
    // 数据源不提供时长 ⇒ null（不是 0）。
    expect(s.longestSessionMs).toBeNull();
  });

  it('buildSummary：全 0 数据与空数据（不抛错、不产生假连续）', async () => {
    await load();
    const allZero = stats.buildSummary([day('2026-09-26', 0)], '2026-09-26');
    expect(allZero.totalTokens).toBe(0);
    expect(allZero.activeDays).toBe(0);
    expect(allZero.currentStreakDays).toBe(0);
    expect(allZero.longestStreakDays).toBe(0);
    const empty = stats.buildSummary([], '2026-09-26');
    expect(empty.totalTokens).toBe(0);
    expect(empty.peakDayTokens).toBe(0);
    expect(empty.longestStreakDays).toBe(0);
  });

  it('buildSummary：连续 3 天（今天也在内）⇒ 当前连续 = 最长连续 = 3', async () => {
    await load();
    const s = stats.buildSummary(
      [day('2026-09-24', 1), day('2026-09-25', 1), day('2026-09-26', 1)],
      '2026-09-26',
    );
    expect(s.currentStreakDays).toBe(3);
    expect(s.longestStreakDays).toBe(3);
    expect(s.activeDays).toBe(3);
  });

  it('buildHeatmap：52 周 × 7 天，最后一行是本周，level 相对峰值', async () => {
    await load();
    const map = stats.buildHeatmap(
      [day('2026-09-19', 100), day('2026-09-26', 25)],
      '2026-09-26',
    );
    expect(map.weeks).toHaveLength(52);
    for (const w of map.weeks) expect(w.days).toHaveLength(7);
    expect(map.maxTokens).toBe(100);
    // 每一列的第一行是周日（列对齐口径）。
    for (const w of map.weeks) {
      const first = w.days[0];
      if (first) expect(stats.utcWeekday(stats.dayIndexOf(first.date))).toBe(0);
    }
    // 峰值 100 → 4 档；25/100 = 0.25 → 不是 >0.25，故 1 档。
    const flat = map.weeks.flatMap((w) => w.days);
    const peak = flat.find((c) => c.date === '2026-09-19');
    const quarter = flat.find((c) => c.date === '2026-09-26');
    expect(peak?.level).toBe(4);
    expect(quarter?.level).toBe(1);
    // 数据窗口外的日期补 0 格（不是「有活动」）。
    const outside = flat.find((c) => c.date === '2026-01-01');
    expect(outside?.level).toBe(0);
    expect(outside?.totalTokens).toBe(0);
  });

  it('buildHeatmap：全零数据时每一格都是 0 档（不整片亮起）', async () => {
    await load();
    const map = stats.buildHeatmap([day('2026-09-26', 0)], '2026-09-26');
    expect(map.maxTokens).toBe(0);
    for (const w of map.weeks) for (const c of w.days) expect(c.level).toBe(0);
  });
});

/** 分组 2：月份标签 / 图表数据 / 轴刻度 / 三档模式。 */
describe('W9103 · 使用统计纯函数（标签与图表）', () => {
  it('buildMonthLabels：相邻同月合并 span，最多显示最近 12 个月', async () => {
    await load();
    const map = stats.buildHeatmap([], '2026-09-26');
    const labels = stats.buildMonthLabels(map.weeks);
    // ★ 合并本身要被钉住：52 列若各成一条标签，长度就是 52（那等于没合并）。
    //   52 周横跨的自然月只有 12~13 个，因此标签数必须远小于列数。
    expect(labels.length, '相邻同月必须合并（否则 52 列 = 52 条标签）').toBeLessThanOrEqual(13);
    expect(labels.length, '12 个月是下限（52 周不可能只有 11 个月）').toBeGreaterThanOrEqual(12);
    // span 合计恒等于列数（合并只改分组，不丢列）。
    const total = labels.reduce((s, l) => s + l.span, 0);
    expect(total).toBe(52);
    // 每个标签的 span 就是该月的列数，且没有任何一个 span 为 0。
    expect(labels.every((l) => l.span > 0)).toBe(true);
    // 文字被清空的只可能是**最前面**那几个（保留 span 以对齐列）。
    const blank = labels.map((l) => l.month === '');
    const firstShown = blank.indexOf(false);
    expect(blank.slice(0, firstShown).every(Boolean), '清空文字只发生在开头').toBe(true);
    const shown = labels.filter((l) => l.month !== '');
    expect(shown.length, '底部最多显示 12 个月').toBeLessThanOrEqual(12);
    // 月份 key 单调递增（按列顺序走），且不含重复月份。
    const months = shown.map((l) => l.month);
    expect([...months].sort(), '月份按列顺序出现，不重排').toEqual(months);
  });

  it('buildChart：只画 top N、日期升序、缺日补 0、Y 轴跟随可见序列单点峰值', async () => {
    await load();
    const points = [
      { date: '2026-09-01', modelId: 'a', totalTokens: 100 },
      { date: '2026-09-01', modelId: 'b', totalTokens: 900 },
      { date: '2026-09-02', modelId: 'a', totalTokens: 50 },
      // 同一天同模型多行要相加（不覆盖）。
      { date: '2026-09-02', modelId: 'b', totalTokens: 10 },
      { date: '2026-09-02', modelId: 'b', totalTokens: 5 },
      // 第 3 个模型（topN=2 时应被截掉，且不参与 Y 轴与日期轴）。
      { date: '2026-09-01', modelId: 'c', totalTokens: 5 },
      // 只有被截掉的模型在用的一天：不该在图上留一个全 0 的假低谷。
      { date: '2026-09-03', modelId: 'c', totalTokens: 3 },
    ];
    const chart = stats.buildChart(points, 2);
    expect(chart.dates, '日期轴只含可见序列出现过的日期').toEqual(['2026-09-01', '2026-09-02']);
    expect(chart.series.map((s) => s.modelId), '按总量降序取前 2').toEqual(['b', 'a']);
    expect(chart.series[0]?.values).toEqual([900, 15]);
    expect(chart.series[1]?.values).toEqual([100, 50]);
    // Y 轴 = 可见序列的单点峰值（900），**不是**每日总量（915 含两模型之和）。
    expect(chart.maxTokens).toBe(900);
  });

  it('buildChart：缺的日期补 0（折线连续，不跳点）', async () => {
    await load();
    const chart = stats.buildChart([
      { date: '2026-09-01', modelId: 'a', totalTokens: 10 },
      { date: '2026-09-03', modelId: 'a', totalTokens: 30 },
    ]);
    expect(chart.dates).toEqual(['2026-09-01', '2026-09-03']);
    expect(chart.series[0]?.values, '09-02 无点 ⇒ 0，序列长度仍与日期轴等长').toEqual([10, 30]);
  });

  it('buildChart：空数据 ⇒ 空序列、maxTokens 0（由调用方显示空态）', async () => {
    await load();
    const chart = stats.buildChart([]);
    expect(chart.dates).toEqual([]);
    expect(chart.series).toEqual([]);
    expect(chart.maxTokens).toBe(0);
    // 只有 0 用量的点同样不产生序列（0 没有可见趋势点）。
    const zero = stats.buildChart([{ date: '2026-09-01', modelId: 'a', totalTokens: 0 }]);
    expect(zero.series).toEqual([]);
    expect(zero.maxTokens).toBe(0);
  });

  it('shouldShowAxisLabel：≤14 全画；>14 按 5 或 7 抽稀且首尾恒画', async () => {
    await load();
    for (let i = 0; i < 14; i++) expect(stats.shouldShowAxisLabel(i, 14)).toBe(true);
    // 15..45 → step 5；首尾恒画。
    expect(stats.shouldShowAxisLabel(0, 30)).toBe(true);
    expect(stats.shouldShowAxisLabel(5, 30)).toBe(true);
    expect(stats.shouldShowAxisLabel(29, 30)).toBe(true);
    expect(stats.shouldShowAxisLabel(3, 30)).toBe(false);
    // >45 → step 7。
    expect(stats.shouldShowAxisLabel(7, 52)).toBe(true);
    expect(stats.shouldShowAxisLabel(51, 52)).toBe(true);
    expect(stats.shouldShowAxisLabel(3, 52)).toBe(false);
  });

  it('buildColumns：weekly/cumulative 自下往上填、档位相对本模式最大值', async () => {
    await load();
    const map = stats.buildHeatmap(
      [day('2026-09-26', 100), day('2026-09-25', 100)],
      '2026-09-26',
    );
    const daily = stats.buildColumns(map.weeks, 'daily');
    expect(daily[51]?.value, 'daily 模式每格各画各的，列不设汇总值').toBeNull();
    const weekly = stats.buildColumns(map.weeks, 'weekly');
    expect(weekly[51]?.value, '最后一周含 09-26 与 09-25').toBe(200);
    const cumulative = stats.buildColumns(map.weeks, 'cumulative');
    expect(cumulative[51]?.value).toBe(200);
    // 累计模式下最后一列 = 最大值 ⇒ 4 档；且自下往上填满 7 格。
    const lastCells = cumulative[51]?.cells ?? [];
    expect(lastCells).toHaveLength(7);
    expect((lastCells[6] as { level: number }).level).toBe(4);
    // 更早的周（无用量）全 0 档。
    const firstCells = cumulative[0]?.cells ?? [];
    for (const c of firstCells) expect((c as { level: number }).level).toBe(0);
  });
});

/** 分组 2：账本响应体的解析（诚实降级 / cost null / 非法行丢弃）。 */
describe('W9103 · 账本响应体解析', () => {
  it('parseLedgerDays：ok:false 如实回报原因，不伪造空数组', async () => {
    await load();
    const disabled = model.parseLedgerDays({ ok: false, error: 'usage ledger disabled' });
    expect(disabled.ok).toBe(false);
    expect(disabled.reason).toBe('disabled');
    expect(disabled.days, '降级时不得给出「空数据」').toBeUndefined();
    expect(model.parseLedgerDays({ ok: false, error: 'usage ledger unavailable' }).reason).toBe(
      'unavailable',
    );
    // 未知错误归入「读不出来」。
    expect(model.parseLedgerDays({ ok: false, error: 'boom' }).reason).toBe('unreadable');
    expect(model.failureOf(undefined)).toBe('unreadable');
  });

  it('parseLedgerDays：升序、丢弃非法日期、同日相加', async () => {
    await load();
    const read = model.parseLedgerDays({
      ok: true,
      currency: 'CNY',
      rows: [
        { key: '2026-09-19', tokens: { total_tokens: 100 } },
        { key: '2026-09-01', tokens: { total_tokens: 7 } },
        { key: 'not-a-date', tokens: { total_tokens: 999 } },
        { key: '2026-13-45', tokens: { total_tokens: 999 } },
        { key: '2026-09-19', tokens: { total_tokens: 5 } },
      ],
    });
    expect(read.ok).toBe(true);
    expect(read.days?.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-19']);
    expect(read.days?.[1]?.totalTokens, '同日多行相加').toBe(105);
    expect(model.isDateKey('2026-13-45')).toBe(false);
    expect(model.isDateKey('2026-02-30')).toBe(false);
    expect(model.isDateKey('2026-02-28')).toBe(true);
  });

  it('parseLedgerDays：cost 为 null ⇒ 保持 null（未定价不是 0）', async () => {
    await load();
    const read = model.parseLedgerDays({
      ok: true,
      currency: 'CNY',
      rows: [{ key: '2026-09-19', tokens: { total_tokens: 10 }, cost: null }],
      unpriced_models: ['deepseek-flash'],
    });
    expect(read.cost?.total, '未知价格必须保持 null，绝不 `?? 0`').toBeNull();
    expect(read.cost?.currency).toBe('CNY');
    expect(read.cost?.unpricedModels).toEqual(['deepseek-flash']);
    // 有价时正常读出。
    const priced = model.parseLedgerDays({
      ok: true,
      currency: 'CNY',
      totals: { cost: 1.25 },
      rows: [{ key: '2026-09-19', tokens: { total_tokens: 10 }, cost: 1.25 }],
    });
    expect(priced.cost?.total).toBe(1.25);
    // 缺 totals 时回落成逐行相加（仍保持 null 语义）。
    const summed = model.parseLedgerDays({
      ok: true,
      rows: [
        { key: '2026-09-19', cost: 1 },
        { key: '2026-09-20', cost: 2 },
      ],
    });
    expect(summed.cost?.total).toBe(3);
    const nonePriced = model.parseLedgerDays({
      ok: true,
      rows: [{ key: '2026-09-19', cost: null }],
    });
    expect(nonePriced.cost?.total, '一行都没定价 ⇒ null，不是 0').toBeNull();
    expect(model.numOrNull(undefined)).toBeNull();
    expect(model.numOrNull(0)).toBe(0);
  });

  it('parseLedgerModels：丢掉 0 用量、空 key 走未知模型占位', async () => {
    await load();
    const rows = model.parseLedgerModels({
      ok: true,
      rows: [
        { key: 'deepseek-flash', tokens: { total_tokens: 482801 } },
        { key: 'zero-model', tokens: { total_tokens: 0 } },
        { key: '   ', tokens: { total_tokens: 5 } },
      ],
    });
    expect(rows.map((r) => r.modelId)).toEqual(['deepseek-flash', '(unknown model)']);
    expect(rows.every((r) => r.totalTokens > 0)).toBe(true);
    expect(model.parseLedgerModels({ ok: false })).toEqual([]);
  });

  it('parseDayModel：按 "|" 切出日期与模型（一次请求拿全区间）', async () => {
    await load();
    const rows = model.parseDayModel({
      ok: true,
      rows: [
        { key: '2026-09-19|deepseek-flash', tokens: { total_tokens: 482801 } },
        { key: '2026-09-19|(unknown model)', tokens: { total_tokens: 7 } },
        // 非法日期 / 缺分隔符 / 0 用量：全部丢弃（宁可少一点，也不画垃圾）。
        { key: 'not-a-date|m', tokens: { total_tokens: 9 } },
        { key: 'no-separator', tokens: { total_tokens: 9 } },
        { key: '2026-09-20|m', tokens: { total_tokens: 0 } },
        // 模型名本身含 "|"：只按**第一个**分隔符切，名字原样保留。
        { key: '2026-09-20|weird|name', tokens: { total_tokens: 3 } },
      ],
    });
    expect(rows).toEqual([
      { date: '2026-09-19', modelId: 'deepseek-flash', totalTokens: 482801 },
      { date: '2026-09-19', modelId: '(unknown model)', totalTokens: 7 },
      { date: '2026-09-20', modelId: 'weird|name', totalTokens: 3 },
    ]);
    expect(model.parseDayModel({ ok: false })).toEqual([]);
  });

  it('longestSessionMs：取 last_ts-first_ts 的最大值（毫秒）；答不了时 null', async () => {
    await load();
    // 两行：一行跨 1789828262-1789799886 = 28376 秒，另一行跨 10 秒 ⇒ 取大的那个。
    expect(
      model.longestSessionMs({
        ok: true,
        rows: [
          { key: 'a', first_ts: 1789799886, last_ts: 1789828262 },
          { key: 'b', first_ts: 100, last_ts: 110 },
        ],
      }),
    ).toBe(28376000);
    // 没有 first_ts/last_ts（老服务）⇒ null，不编 0。
    expect(model.longestSessionMs({ ok: true, rows: [{ key: 'a' }] })).toBeNull();
    expect(model.longestSessionMs({ ok: true, rows: [] })).toBeNull();
    expect(model.longestSessionMs({ ok: false, error: 'usage ledger disabled' })).toBeNull();
    // 单行（跨度 0）是合法值：0 表示「确实没有跨度」，不是未知。
    expect(model.longestSessionMs({ ok: true, rows: [{ first_ts: 5, last_ts: 5 }] })).toBe(0);
    // 只有一半时间戳的行跳过（不能拿半个跨度当答案）。
    expect(model.longestSessionMs({ ok: true, rows: [{ first_ts: 5 }] })).toBeNull();
  });

  it('buildSummary：最长聊天时长由调用方传入（缺省 null ⇒ 显示 —）', async () => {
    await load();
    const withSpan = stats.buildSummary([day('2026-09-26', 5)], '2026-09-26', 28502000);
    expect(withSpan.longestSessionMs).toBe(28502000);
    const withoutSpan = stats.buildSummary([day('2026-09-26', 5)], '2026-09-26');
    expect(withoutSpan.longestSessionMs, '缺省 = 数据源答不了').toBeNull();
  });
});
