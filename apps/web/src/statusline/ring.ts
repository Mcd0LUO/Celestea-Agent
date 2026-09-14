// ============================================================================
// statusline/ring.ts — W758 从 src/statusline.ts 拆出（纯搬运，无行为变更）：
//   第 1 行上下文占用环（W726 可点击 / W755 缺容量不画假比率）+ 第 2 行缓存
//   命中率（W263）+「图标 + 模型名」单元格（W750）。
//   三个函数都只写调用方传入的元素（改文本/属性/class，不重建 DOM、不重渲染
//   背景）——铁律 1/2/5；模块自身零状态（模型单元格的短路状态由调用方经
//   ModelCellState 持有）。
// ============================================================================
import { fmtCompact } from '../utils/dom';
import { modelIconFor } from '../utils/model-icon';
import type { ContextUsage, UsageSnapshot } from '../types';
import { clamp01, iconNode } from './icons';

const RING_R = 5.2;
/** 环周长（构造时写进 strokeDasharray，渲染时按占用比算 dashoffset）。 */
export const RING_C = 2 * Math.PI * RING_R;
/** context ring turns warning color at/above this ratio */
const WARN_RATIO = 0.9;

/**
 * 上下文占用：环 + 「used/window」文本 + 标题。
 * 窗口未声明（usage 存在但 window <= 0）不画假比率（对齐 DSH 缺容量即不显示环）；
 * 完全没有 usage → 占位符。只改文本/属性，不重建 DOM。
 */
export function renderContextCell(
  ctxEl: HTMLElement,
  ring: HTMLElement,
  usage: ContextUsage | undefined,
): void {
  if (usage && usage.window > 0) {
    const ratio = clamp01(usage.ratio);
    ctxEl.textContent = fmtCompact(usage.used) + '/' + fmtCompact(usage.window);
    ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
    ring.classList.toggle('warn', ratio >= WARN_RATIO);
    ring.title = '上下文占用 ' + Math.round(ratio * 1000) / 10 + '%' +
      ' · ' + fmtCompact(usage.used) + '/' + fmtCompact(usage.window) +
      '（点击查看完整上下文）';
  } else if (usage) {
    // W755：窗口未声明时不画假比率（对齐 DSH 缺容量即不显示环）。
    ctxEl.textContent = '占用未知';
    ring.style.strokeDashoffset = String(RING_C);
    ring.classList.remove('warn');
    ring.title = '上下文占用未知 · 点击查看完整上下文';
  } else {
    ctxEl.textContent = '—/—';
    ring.style.strokeDashoffset = String(RING_C);
    ring.classList.remove('warn');
    ring.title = '上下文占用（点击查看完整上下文）';
  }
}

/**
 * W750：状态栏的「图标 + 模型名」——同一行一起替换（单次 replaceChildren，
 * 不留空白帧）；名字与图标键都没变时一个字节都不动（轮询每 2 秒一次）。
 * 短路状态由调用方持有（ModelCellState），模块自身零状态。
 */
export interface ModelCellState {
  label: string;
  iconKey: string | null;
}

export function renderModelCell(cellEl: HTMLElement, name: string, st: ModelCellState): void {
  const label = name || '—';
  const spec = modelIconFor(name);
  const key = spec === null ? null : spec.key;
  if (key === st.iconKey && label === st.label) return;
  st.iconKey = key;
  st.label = label;
  const kids: Node[] = [];
  if (spec !== null) kids.push(iconNode(spec));
  kids.push(document.createTextNode(label));
  cellEl.replaceChildren(...kids);
}

/**
 * W263: `缓存 78%` = the LATEST LLM stream's cache_read / prompt_tokens.
 * `缓存 —` when the engine has reported no usage yet. The title spells out
 * the exact numbers and the cumulative ratio (tracker.total()).
 * W263 缓存命中率：只改文本（铁律 1/2/5——不重建 DOM，不重渲染背景）。
 */
export function renderCacheCell(cacheEl: HTMLElement, u: UsageSnapshot | undefined): void {
  if (!u || !(u.prompt_tokens > 0)) {
    cacheEl.textContent = '缓存 —';
    cacheEl.title = '暂无缓存命中数据';
    return;
  }
  const pct = Math.round(clamp01(u.cache_hit_ratio) * 100);
  cacheEl.textContent = '缓存 ' + pct + '%';
  const t = u.total;
  cacheEl.title =
    '最近一次请求：命中 ' +
    u.cache_read +
    ' / 输入 ' +
    u.prompt_tokens +
    ' tokens' +
    (t
      ? '（累计 ' + (clamp01(t.cache_hit_ratio) * 100).toFixed(1) + '%，命中 ' + t.cache_read + ' / 输入 ' + t.prompt_tokens + ' tokens）'
      : '');
}
