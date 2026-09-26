// ============================================================================
// ui/usage/heatmap.ts — Token 活动热力图（手写 DOM，无图表库）。
// ----------------------------------------------------------------------------
//   为什么不用 <svg>：格子是 52×7 = 364 个**可独立悬停/上色**的方块，用 CSS Grid
//   铺 <div> 比 SVG 更省事（无需算坐标），且天然随容器等分（52 列在窄屏也不会
//   溢出 —— 参考实现正是为此把列宽从固定 14px 改成可收缩的 1fr）。
//   本仓的 SVG 先例（ring.ts / icons.ts）画的是**少量**路径，与这里形状不同。
//
//   三档模式（每日 / 每周 / 累计）只重画格子，不重建容器 —— 铁律 4「切换只切 class」
//   的同类：这里是「切换只重画格子内容」，外层结构与月份标签不动。
// ============================================================================
import { el } from '../../utils/dom';
import { getLocale, t } from '../../i18n';
import { formatFullDay, formatMonth, formatTokens } from './format';
import {
  buildColumns,
  buildMonthLabels,
  type HeatCell,
  type HeatColumn,
  type Heatmap,
  type HeatMode,
} from './stats';

/** 三档模式的按钮顺序（与字典 key 一一对应）。 */
const MODES: readonly HeatMode[] = ['daily', 'weekly', 'cumulative'];

function modeLabel(mode: HeatMode): string {
  if (mode === 'daily') return t('usage.heatmap.mode.daily');
  if (mode === 'weekly') return t('usage.heatmap.mode.weekly');
  return t('usage.heatmap.mode.cumulative');
}

/**
 * 每格/每列的悬停说明：基础句（日期 + tokens）+ 可选片段。
 *   轮数与工具次数账本不提供 ⇒ **整段省略**，不写 0（0 会被读成「确实没有」）。
 *   拼装而非整句列举，是为了 2 个可选维度不炸成 4 条字典 key × 3 档模式。
 */
function tooltipFor(mode: HeatMode, column: HeatColumn, cell: HeatCell): string {
  const locale = getLocale();
  const date = formatFullDay(locale, cell.date);
  const tokens = formatTokens(locale, mode === 'daily' ? cell.totalTokens : (column.value ?? 0));
  const baseKey =
    mode === 'daily'
      ? 'usage.heatmap.cellBase'
      : mode === 'weekly'
        ? 'usage.heatmap.weekBase'
        : 'usage.heatmap.cumulativeBase';
  const parts = [t(baseKey, { date, tokens })];
  const turns = cell.turnCount;
  const tools = cell.toolCallCount;
  if (turns !== undefined) parts.push(t('usage.heatmap.partTurns', { turns }));
  if (tools !== undefined) parts.push(t('usage.heatmap.partTools', { tools }));
  return parts.join(' · ');
}

/** 一列（一周）：7 个方块纵排。 */
function columnNode(mode: HeatMode, column: HeatColumn): HTMLElement {
  const wrap = el('div', 'usage-heat-col');
  for (const cell of column.cells) {
    const box = el('div', 'usage-heat-cell lv' + String(cell.level));
    box.title = tooltipFor(mode, column, cell);
    wrap.appendChild(box);
  }
  return wrap;
}

/** 图例（少 → 多），让 0–4 档有可读的语义。 */
function legendNode(): HTMLElement {
  const wrap = el('div', 'usage-heat-legend');
  wrap.appendChild(el('span', 'usage-heat-legend-label', t('usage.heatmap.less')));
  for (let lv = 0; lv <= 4; lv++) wrap.appendChild(el('span', 'usage-heat-cell lv' + String(lv)));
  wrap.appendChild(el('span', 'usage-heat-legend-label', t('usage.heatmap.more')));
  return wrap;
}

/** 月份标签行：`grid-column: span N` 与上面的格子列一一对齐。 */
function monthRow(weeks: Heatmap['weeks']): HTMLElement {
  const row = el('div', 'usage-heat-months');
  const locale = getLocale();
  for (const label of buildMonthLabels(weeks)) {
    // 被隐藏文字的月份保留 span（否则底部标签与列错位），只清空文字。
    const text = label.month === '' ? '' : formatMonth(locale, label.month + '-01');
    const node = el('div', 'usage-heat-month', text);
    node.style.gridColumn = 'span ' + String(label.span);
    row.appendChild(node);
  }
  return row;
}

/**
 * 挂载/更新热力图。
 *   首次调用建结构（标题行 + 网格 + 月份行 + 图例）；模式切换与刷新只重画
 *   **网格的列**（单次 replaceChildren），标题/月份/图例不重建 —— 铁律 1/4。
 *   返回一个 setMode，供 tab 点击调用。
 *
 *   注意：网格节点必须**在调用时**从 host 取，不能在函数开头取一次 —— 首次
 *   挂载时结构还不存在，提前取到的会是 null，paint 就永远早退（列画不出来）。
 *   这个坑由 tests/w9103-usage-panel-dom.test.ts 的「52 周」断言抓住。
 */
export function mountHeatmap(host: HTMLElement, map: Heatmap): (mode: HeatMode) => void {
  const paint = (mode: HeatMode): void => {
    const grid = host.querySelector('.usage-heat-grid');
    if (!grid) return;
    const off = document.createElement('div');
    for (const column of buildColumns(map.weeks, mode)) off.appendChild(columnNode(mode, column));
    grid.replaceChildren(...off.childNodes);
    // 月份标签只在建结构时画；模式切换不改变列归属，无需重画。
  };

  // 已有结构（同一 pane 被重复挂载）：复用，只按当前 map 重画格子。
  if (host.querySelector('.usage-heat-grid')) {
    paint('daily');
    return paint;
  }

  const head = el('div', 'usage-heat-head');
  head.appendChild(el('h5', 'usage-sec-title', t('usage.heatmap.title')));
  const tabs = el('div', 'usage-tabs');
  const buttons = new Map<HeatMode, HTMLButtonElement>();
  for (const mode of MODES) {
    const b = el('button', 'usage-tab', modeLabel(mode)) as HTMLButtonElement;
    b.type = 'button';
    b.dataset['mode'] = mode;
    buttons.set(mode, b);
    tabs.appendChild(b);
  }
  head.appendChild(tabs);

  const body = el('div', 'usage-heat-body');
  const gridNode = el('div', 'usage-heat-grid');
  body.appendChild(gridNode);
  body.appendChild(monthRow(map.weeks));

  const foot = el('div', 'usage-heat-foot');
  foot.appendChild(legendNode());

  const off = document.createElement('div');
  off.appendChild(head);
  off.appendChild(body);
  off.appendChild(foot);
  host.replaceChildren(...off.childNodes);

  const setMode = (mode: HeatMode): void => {
    for (const [m, b] of buttons) {
      b.classList.toggle('active', m === mode);
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
    paint(mode);
  };
  for (const [mode, b] of buttons) b.addEventListener('click', () => setMode(mode));
  setMode('daily');
  return setMode;
}
