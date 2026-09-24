// ============================================================================
// ui/rail-state.ts — 灵动选择条的**记账**（W1485 从 ui/rail.ts 拆出）
// ----------------------------------------------------------------------------
// 为什么单独成模块：ui/rail.ts 已顶到模块体积棘轮上限（514 行），而本轮要给它加
// 「列被 DOM 裁剪时同步摘长条」的能力。这里只搬**数据结构与查询**，一行几何/交互
// 都没动 —— rail.ts 仍独占轨道 DOM、布局与命中判定。
//
// 条目语义（与拆分前逐字一致）：
//   · 一根长条 = 一轮（一问一答合并）；role='user' 起新条，'assistant'/'interject'
//     并入最近一轮；
//   · 每个会话容器一份集合（会话切换时整组保活，节点在 track 与 holder 之间搬家）；
//   · itemByEl 让悬停提示提供者从长条元素反查内容（WeakMap，随节点回收）。
// ============================================================================
import type { SessionPane } from './viewctx';

/** 一根长条 = 一轮（一问一答合并）。 */
export interface RailItem {
  startCol: HTMLElement;
  cols: HTMLElement[];
  hasReply: boolean;
  el: HTMLElement;
  y: number;
  visible: boolean;
  fold: number;
  /** W886：本条常驻的提示文案（切走「居中」态时复位用）。 */
  hint: string;
}

/** 单个会话容器的长条集合（会话切换时整组保活）。 */
export interface RailState {
  items: RailItem[];
  foldItem: RailItem | null;
  /** 非当前会话的离屏存放点（当前会话的长条常驻 track） */
  holder: HTMLElement;
}

const rails = new WeakMap<SessionPane, RailState>();
/** W790：长条元素 → 条目（提示提供者拿元素反查内容；WeakMap 随节点回收）。 */
const itemByEl = new WeakMap<HTMLElement, RailItem>();

/** 取（必要时创建）某会话容器的长条记账。 */
export function stateOf(ctx: SessionPane): RailState {
  let st = rails.get(ctx);
  if (!st) {
    const holder = document.createElement('div');
    holder.className = 'railv3-holder';
    st = { items: [], foldItem: null, holder };
    rails.set(ctx, st);
  }
  return st;
}

/** 只读查询（未登记时返回 null，不产生副作用）。 */
export function stateOfOnly(ctx: SessionPane): RailState | null {
  return rails.get(ctx) ?? null;
}

/** W1485：某会话当前登记的长条数（诊断/门禁用只读口径；不触发任何布局）。 */
export function barCountOf(ctx: SessionPane): number {
  return rails.get(ctx)?.items.length ?? 0;
}

/** 登记「长条元素 → 条目」（提示提供者反查用）。 */
export function bindItem(el: HTMLElement, it: RailItem): void {
  itemByEl.set(el, it);
}

/** 长条元素 → 条目（提示提供者用）。 */
export function itemOf(el: HTMLElement): RailItem | undefined {
  return itemByEl.get(el);
}

/** 参与布局/交互的全部条目（含折叠条）。 */
export function allItems(st: RailState): RailItem[] {
  return st.foldItem ? [st.foldItem, ...st.items] : st.items;
}

/**
 * W1485：把若干**已被回收**的消息列从长条记账里摘掉（纯数据手术，不动 DOM 交互态）。
 *
 * 为什么必须摘：长条是「一轮的定位入口」，它按 `startCol` 反查该列的文档坐标
 * （rail-doc.ts 的 docCenterY）。列被裁剪后 rect 恒为 0，长条会缩到轨道顶端并
 * 集体重叠 —— 那不是「少了几根条」，而是一个骗人的界面。
 * 返回摘掉的条数（调用方仅用于诊断/断言）。
 */
export function dropColsInState(st: RailState, cols: readonly HTMLElement[]): number {
  if (cols.length === 0) return 0;
  const gone = new Set<HTMLElement>(cols);
  const keep: RailItem[] = [];
  let dropped = 0;
  for (const it of st.items) {
    const kept = it.cols.filter((c) => !gone.has(c));
    if (kept.length === 0) {
      it.el.remove();
      dropped += 1;
      continue;
    }
    it.cols = kept;
    if (gone.has(it.startCol)) it.startCol = kept[0]!;
    keep.push(it);
  }
  st.items = keep;
  return dropped;
}
