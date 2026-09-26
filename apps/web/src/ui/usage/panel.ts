// ============================================================================
// ui/usage/panel.ts — 设置页「使用统计」pane 的装配（骨架照参考实现的顺序）：
//   ① 摘要条（5 格：累计 / 峰值 / 最长聊天时长 / 当前连续 / 最长连续）
//   ② Token 活动热力图（52 周 × 7 天，每日 / 每周 / 累计三档）
//   ③ 时间范围 tab（近 7 日 / 近 30 日）
//   ④ 每日 Token 趋势图（按模型分序列）
//   ⑤ 刷新按钮
//
//   渲染纪律（apps/web/FRONTEND-RULES.md）：
//     · 铁律 1：离屏构建 + 单次 replaceChildren（旧内容保持可见到新内容就绪）；
//     · 铁律 3：取数带 `seq` 竞态守卫（快速切 7/30 日时晚到的旧结果一律丢弃）；
//     · 铁律 6：刷新只重画本 pane 的区域，不触发任何背景视图重建。
//
//   诚实降级：`ok:false`（账本关闭 / 本部署没有账本）与网络失败**分开说**，
//   且都不伪造空图 —— 三句话分别对应三种原因（见 ui/usage/model.ts）。
// ============================================================================
import { el, need } from '../../utils/dom';
import { getLocale, t } from '../../i18n';
import { loadUsage, todayUtc, type UsageData } from './fetch';
import { buildHeatmap, buildSummary, type UsageSummary } from './stats';
import { formatDays, formatDuration, formatTokenCount } from './format';
import { mountHeatmap } from './heatmap';
import { mountTrend } from './trend';
import type { CostView, LedgerFailure } from './model';

/** 两个时间范围（近 7 日 / 近 30 日）—— 与字典 key 一一对应。 */
const RANGES = [7, 30] as const;
type RangeDays = (typeof RANGES)[number];

/** 竞态守卫：每次取数递增，返回时校验仍是当前代。 */
let seq = 0;
let currentRange: RangeDays = 7;
/** 已取到的数据（切范围时先按旧数据重画，避免整块闪空）。 */
let lastData: UsageData | null = null;

const pane = (): HTMLElement => need<HTMLElement>('#settingsUsage');

/** 五格摘要条。`longestSessionMs` 为 null（数据源答不了）时显示 `—`，不编 0。 */
function summaryStrip(summary: UsageSummary): HTMLElement {
  const strip = el('div', 'usage-summary');
  const locale = getLocale();
  const items: [string, string][] = [
    [t('usage.summary.totalTokens'), formatTokenCount(locale, summary.totalTokens)],
    [t('usage.summary.peakTokens'), formatTokenCount(locale, summary.peakDayTokens)],
    [t('usage.summary.longestSession'), formatDuration(locale, summary.longestSessionMs)],
    [t('usage.summary.currentStreak'), formatDays(locale, summary.currentStreakDays)],
    [t('usage.summary.longestStreak'), formatDays(locale, summary.longestStreakDays)],
  ];
  items.forEach(([label, value], i) => {
    if (i > 0) strip.appendChild(el('div', 'usage-summary-sep'));
    const cell = el('div', 'usage-summary-cell');
    const valueNode = el('div', 'usage-summary-value', value);
    // 长值（如「7 小时 52 分钟」）在窄格里会被省略号截断 ⇒ title 给完整值。
    valueNode.title = value;
    cell.appendChild(valueNode);
    cell.appendChild(el('div', 'usage-summary-label', label));
    strip.appendChild(cell);
  });
  return strip;
}

/**
 * 费用行：**未知价格不是 0**。
 *   `total === null` ⇒ 显示「未定价」并说明原因（哪个模型不在价格表内），
 *   绝不显示 ¥0 —— 那是在替价格表编一个它没给的答案。
 *   本机部署实测 `cost:null` + `unpriced_models:["deepseek-flash"]`，走的就是这一支。
 */
function costRow(cost: CostView): HTMLElement {
  const row = el('div', 'usage-cost');
  const label = el('span', 'usage-cost-label', t('usage.summary.cost'));
  row.appendChild(label);
  if (cost.total === null) {
    const value = el('span', 'usage-cost-value unpriced', t('usage.cost.unpriced'));
    value.title =
      cost.unpricedModels.length > 0
        ? t('usage.cost.unpricedHint', { models: cost.unpricedModels.join('、') })
        : t('usage.cost.unsupportedHint');
    row.appendChild(value);
    return row;
  }
  const text = new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency: cost.currency === '' ? 'CNY' : cost.currency,
  }).format(cost.total);
  row.appendChild(el('span', 'usage-cost-value', text));
  return row;
}

/** 空态 / 降级说明（三句不同的话；绝不画假图）。 */
function notice(text: string): HTMLElement {
  const box = el('div', 'usage-notice');
  box.appendChild(el('div', 'usage-notice-text', text));
  return box;
}

function failureText(reason: LedgerFailure): string {
  if (reason === 'disabled') return t('usage.ledger.disabled');
  if (reason === 'unavailable') return t('usage.ledger.unavailable');
  return t('usage.ledger.unreadable');
}

/** 时间范围 tab 行（右侧放刷新按钮，照参考实现的布局语义）。 */
function rangeRow(onRange: (days: RangeDays) => void, onRefresh: () => void): HTMLElement {
  const row = el('div', 'usage-range-row');
  row.appendChild(el('span', 'usage-range-title', t('usage.range.title')));
  const tabs = el('div', 'usage-tabs');
  for (const days of RANGES) {
    const b = el('button', 'usage-tab', t(days === 7 ? 'usage.range.7d' : 'usage.range.30d')) as HTMLButtonElement;
    b.type = 'button';
    b.dataset['range'] = String(days);
    b.addEventListener('click', () => onRange(days));
    tabs.appendChild(b);
  }
  row.appendChild(tabs);
  const spacer = el('div', 'usage-spacer');
  row.appendChild(spacer);
  const refresh = el('button', 'btn-mini usage-refresh', t('usage.action.refresh')) as HTMLButtonElement;
  refresh.type = 'button';
  refresh.id = 'usageRefresh';
  refresh.addEventListener('click', onRefresh);
  row.appendChild(refresh);
  return row;
}

/** 把当前数据画进 pane（离屏构建 + 单次替换）。 */
function paint(host: HTMLElement, data: UsageData): void {
  const off = document.createElement('div');
  if (!data.ledger.ok) {
    off.appendChild(notice(failureText(data.ledger.reason)));
    host.replaceChildren(...off.childNodes);
    return;
  }
  const days = data.ledger.days;
  const endDate = todayUtc();
  // 「最长聊天时长」由 group_by=session 的 first_ts/last_ts 派生；取不到 ⇒ null（显示 —）。
  off.appendChild(summaryStrip(buildSummary(days, endDate, data.longestSessionMs)));
  off.appendChild(costRow(data.ledger.cost));
  const heatHost = el('div', 'usage-card');
  off.appendChild(heatHost);
  const trendHost = el('div', 'usage-card');
  off.appendChild(trendHost);
  host.replaceChildren(...off.childNodes);
  // 挂载在替换之后：两个挂载器各自做一次单次替换（不产生空白帧）。
  mountHeatmap(heatHost, buildHeatmap(days, endDate));
  mountTrend(trendHost, data.trend);
}

/** 切范围时把 tab 的选中态对齐（只切 class，不重建）。 */
function markRange(host: HTMLElement, days: RangeDays): void {
  for (const b of host.querySelectorAll<HTMLElement>('.usage-tab[data-range]')) {
    const on = b.dataset['range'] === String(days);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/** 取数 → 画（带竞态守卫；失败按「读不出来」如实说明）。 */
async function refresh(host: HTMLElement): Promise<void> {
  const mine = ++seq;
  try {
    const data = await loadUsage(currentRange);
    if (mine !== seq) return; // 晚到的旧结果：丢弃（铁律 3）
    lastData = data;
    paint(host, data);
  } catch {
    if (mine !== seq) return;
    const off = document.createElement('div');
    off.appendChild(notice(t('usage.ledger.unreadable')));
    host.replaceChildren(...off.childNodes);
  }
}

/**
 * 首次挂载 pane（`loadPane('usage')` 调用一次；切回零重建由 config.ts 保证）。
 *   结构只建一次：摘要/图表区是可替换的宿主，范围行与刷新键常驻。
 */
export function mountUsagePane(): void {
  const host = pane();
  const off = document.createElement('div');
  const body = el('div', 'usage-body');
  const charts = el('div', 'usage-charts');
  body.appendChild(
    rangeRow(
      (days) => {
        if (days === currentRange) return;
        currentRange = days;
        markRange(body, days);
        void refresh(charts);
      },
      () => void refresh(charts),
    ),
  );
  body.appendChild(charts);
  off.appendChild(body);
  host.replaceChildren(...off.childNodes);
  markRange(body, currentRange);
  void refresh(charts);
}

/** 当前已取到的数据（诊断/测试：语言切换后重画用）。 */
export function usageSnapshot(): UsageData | null {
  return lastData;
}
