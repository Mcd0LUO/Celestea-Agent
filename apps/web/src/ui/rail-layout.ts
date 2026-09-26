// ============================================================================
// ui/rail-layout.ts — 灵动选择条的**布局引擎**（W9204 从 ui/rail.ts 拆出）
// ----------------------------------------------------------------------------
// 为什么单独成模块：ui/rail.ts 受模块体积棘轮约束（登记上限只许降不许升），
// 而 W9204 要给布局加「先读后写 + 脏检查 + 整帧早退」三条纪律与相应注释。
// 拆出的这一段本来就是**自洽**的：布局几何的状态（railTop/railH/railX/railW/
// pitch/modeAll）只有 layout() 写，rail.ts 只读；宿主依赖（#main / 消息区 / 轨道）
// 与长条记账经 RailLayoutHost 注入，方向仍是单向的（本模块不 import rail.ts）。
//
// ★ W9204（P1-1）—— 布局性能的三条纪律，缺一条就会退回 O(N²)：
//   ① **先读后写**：三个 getBoundingClientRect 必须在任何 style 写之前完成。
//      CSSOM 规定「写之后再读」要同步 flush 待处理样式，而本函数每调一次都可能
//      面对上一帧留下的 O(N) 个脏元素 —— 原实现里 gutterWidth() 自己又读一次
//      #main 的 rect，就是那次多余的 O(N) 强制布局。
//   ② **脏检查**：只写真的变了的条。原先对全部 N 根条无条件写 display/top/--barh，
//      于是每次调用都制造 O(N) 个脏元素 —— 与 railAdd 的「每列一次 layout」相乘
//      就是 O(N²)（W9111 实测：1 200 列 21.9s、3 000 列 92.5s）。
//   ③ **整帧早退**：几何与可见集都没变就直接返回，连 style 都不碰（切会话后的
//      ResizeObserver 回调、railSync 的重复 rAF 都会走到这里）。
//   第 ④ 条在 rail.ts 侧：railAdd 末尾从同步 layout() 改成 queueSync()，
//   N 列建列因此合并成每帧一次布局（原先 N 次）。
//
// 坐标口径（与拆分前逐字一致）：轨道绝对定位在 #main 内，top/height 严格对齐当前
// 聚焦会话的**消息区视口**；left 固定 #main 左缘内侧，宽度按留白带宽分档。
// ============================================================================
import { setHint } from './hint/card';
import { t } from '../i18n';
import {
  RAIL_PAD_Y, RAIL_PITCH_NATURAL, railBarHeight, railFitsAll, railGutterWidth, railLane, railPitch,
} from './rail-geom';
import { viewWindow } from './rail-doc';
import { paintCenter } from './rail-center-view';
import { allItems, bindItem, type RailItem, type RailState } from './rail-state';

/** 超过这么多轮就把更早的轮折成一根折叠条。 */
export const MAX_ROWS = 20;

/** 宿主接线：布局只认这三件事，不 import rail.ts（避免成环）。 */
export interface RailLayoutHost {
  /** 当前聚焦会话的长条记账（null = 没有可布局的会话）。 */
  state(): RailState | null;
  /** #main 与消息区（任一缺失即不布局）。 */
  elements(): { main: HTMLElement; msgs: HTMLElement } | null;
  /** 轨道元素（懒建；null = 尚未装配）。 */
  track(): HTMLElement | null;
}

// ---- 布局几何状态（只有本模块写；rail.ts 经下面的 getter 读） ----
let railTop = 0;
let railH = 0;
let railX = 8;
let railW = 66; // 缺省 = rail-geom 的 RAIL_MAX_W
let pitch = RAIL_PITCH_NATURAL;
let modeAll = true;
// ---- W9204（P1-1）：上一帧布局的读数（整帧早退用；只与「上一帧写了什么」比较） ----
let railHidden = false;
let railThin = false;
let laidOutN = -1;
let laidOutFold = -1;
/** W9204：上一帧的滚动位 —— 窗口分支（modeAll=false）靠它决定「哪些条在窗口内」。 */
let laidOutScroll = Number.NaN;

export function railTopY(): number { return railTop; }
export function railHeight(): number { return railH; }
export function railLeftX(): number { return railX; }
export function railWidth(): number { return railW; }
export function railPitchNow(): number { return pitch; }
export function railShowsAll(): boolean { return modeAll; }

/**
 * W9204：丢弃整帧早退的缓存。轨道被重建 / 整批搬家 / 记账被清空时必须调 ——
 * 否则「新一批长条恰好与上一批同样多」会让早退命中，新条永远不会被写位置。
 */
export function resetRailLayoutCache(): void {
  laidOutN = -1;
  laidOutFold = -1;
  laidOutScroll = Number.NaN;
}

/**
 * 留白带宽：.mcol 左缘 − #main 左缘（算式在 ./rail-geom.ts，这里只取 rect）。
 * W9204（P1-1）：#main 的 rect 由调用方**在写任何样式之前**量好传进来。
 */
function gutterWidth(msgs: HTMLElement, m: DOMRect): number {
  const col = msgs.querySelector<HTMLElement>('.mcol');
  return railGutterWidth(m.left, m.width, col ? col.getBoundingClientRect().left : null);
}

/** 全量重排：横向档位 + 纵向节距 + 条组居中（railSync / 滚动 / 尺寸变化）。 */
export function layoutRail(host: RailLayoutHost): void {
  const st = host.state();
  const els = host.elements();
  const track = host.track();
  if (!els || !track || !st) return;
  // ① 读取阶段：三个 rect 全部在任何写之前。
  const m = els.main.getBoundingClientRect();
  const v = els.msgs.getBoundingClientRect();
  const scroll = els.msgs.scrollTop; // 读阶段的一部分（窗口分支据此选可见子集）
  const top = Math.max(0, v.top - m.top);
  const h = v.height;
  const lane = railLane(gutterWidth(els.msgs, m));
  const usable = Math.max(0, h - 2 * RAIL_PAD_Y);
  const foldN = st.items.length > MAX_ROWS ? st.items.length - MAX_ROWS : 0;
  const foldBroken = st.foldItem !== null && st.foldItem.el.parentNode !== track;
  // ③ 整帧早退：与上一帧逐项相同 ⇒ 连 style 都不写（脏集为空）。
  if (
    top === railTop && h === railH && lane.left === railX && lane.width === railW &&
    lane.hidden === railHidden && lane.thin === railThin &&
    track.style.left === lane.left + 'px' && track.style.top === top + 'px' &&
    track.style.height === h + 'px' &&
    st.items.length === laidOutN && foldN === laidOutFold && !foldBroken &&
    // W9204：滚动位必须进早退判据 —— 窗口分支（modeAll=false）选哪些条**只**由它决定；
    // 少了这一项，滚动后 layout 会被误判成「没变」，条带跟着视口走的语义当场失效。
    scroll === laidOutScroll
  ) return;
  railTop = top;
  railH = h;

  if (lane.hidden) {
    track.style.display = 'none';
    railW = 0;
    railHidden = true;
    laidOutN = st.items.length;
    laidOutFold = foldN;
    laidOutScroll = scroll;
    return;
  }
  track.style.display = '';
  const thin = lane.thin;
  railX = lane.left;
  railW = lane.width;
  railHidden = false;
  railThin = thin;
  track.classList.toggle('railv3-thin', thin);
  track.style.left = railX + 'px';
  track.style.top = railTop + 'px';
  track.style.height = railH + 'px';

  if (st.items.length === 0) {
    if (st.foldItem) {
      st.foldItem.el.remove();
      st.foldItem = null;
    }
    laidOutN = 0;
    laidOutFold = 0;
    laidOutScroll = scroll;
    syncCenter(els.msgs, []); // W872：没有条可判 → 清掉「居中」态
    return;
  }
  if (foldN > 0) {
    const fi = st.foldItem;
    // 折叠条必须挂在 track 上才有效（holder 里的旧折叠条在切换时被搬走）
    if (!fi || fi.el.parentNode !== track) {
      const stale = fi?.el;
      const fresh: RailItem = {
        startCol: st.items[st.items.length - MAX_ROWS]!.startCol,
        cols: [],
        hasReply: false,
        el: document.createElement('div'),
        y: 0,
        visible: false,
        fold: foldN,
        hint: '',
      };
      fresh.el.className = 'railv3-item railv3-fold';
      fresh.el.textContent = '⋯';
      track.appendChild(fresh.el);
      bindItem(fresh.el, fresh);
      st.foldItem = fresh;
      if (stale && stale.parentNode) stale.remove();
    } else {
      fi.fold = foldN;
    }
    if (st.foldItem) {
      st.foldItem.fold = foldN;
      // W9204：折叠条指向的必须是**当前**边界那一轮（最早还看得见的那根）。原先只在创建时
      // 取一次 startCol，之后新轮次不断到来、折叠条却一直指着旧的那一轮（W1546 的用例注释
      // 把这条记为「既有记账问题」）。建列改为 rAF 合并后这个漂移更明显（折叠条可能在
      // 一次帧里对着几十根新条创建），所以就地刷新它 —— 一行，且与「折叠了更早 N 轮」的
      // 文案语义一致。
      st.foldItem.startCol = st.items[st.items.length - MAX_ROWS]!.startCol;
      st.foldItem.hint = t('chat.rail.folded', { n: foldN });
      setHint(st.foldItem.el, st.foldItem.hint);
    }
  } else if (st.foldItem) {
    st.foldItem.el.remove();
    st.foldItem = null;
  }
  const bars = allItems(st);
  const count = bars.length;
  let shown: RailItem[];
  if (railFitsAll(usable, count)) {
    modeAll = true;
    pitch = railPitch(usable, count);
    shown = bars;
  } else {
    modeAll = false;
    shown = viewWindow(els.msgs, h, st.items);
    pitch = railPitch(usable, shown.length);
  }
  const stripTop = RAIL_PAD_Y + Math.max(0, (usable - shown.length * pitch) / 2);
  const barH = railBarHeight(pitch);
  // ② 写阶段：只碰真的变了的条（脏检查）。窗口内 / 窗口外的映射各自只写一次。
  const shownAt = new Map<RailItem, number>();
  for (let i = 0; i < shown.length; i++) shownAt.set(shown[i]!, i);
  for (const it of bars) {
    const i = shownAt.get(it);
    const next = i === undefined ? null : stripTop + i * pitch + pitch / 2;
    if (it.visible === (i !== undefined) && it.y === (next ?? it.y) &&
        it.el.style.display === (i === undefined ? 'none' : '')) continue;
    if (i === undefined) {
      it.visible = false;
      it.el.style.display = 'none';
      continue;
    }
    it.visible = true;
    it.el.style.display = '';
    it.y = next!;
    it.el.style.top = it.y - barH / 2 + 'px';
    it.el.style.setProperty('--barh', barH + 'px');
  }
  laidOutN = st.items.length;
  laidOutFold = foldN;
  laidOutScroll = scroll;
  syncCenter(els.msgs, shown); // W872：同帧刷新「居中」态（一个类 + 文案，不重建 DOM）
}

/** W9106：判定与呈现分别在 ./rail-center.ts / ./rail-center-view.ts（这里只转一次）。 */
function syncCenter(msgs: HTMLElement, shown: RailItem[]): void {
  paintCenter(msgs, railH, railW, shown);
}

/** 供 rail.ts 的 queueMid 复用（条带几何不变时只刷中间判定）。 */
export function syncCenterNow(msgs: HTMLElement, shown: RailItem[]): void {
  syncCenter(msgs, shown);
}
