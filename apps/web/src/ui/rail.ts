// ============================================================================
// ui/rail.ts — 「灵动消息选择条」v3（W238 删旧重做；W514 多会话化）
// ----------------------------------------------------------------------------
// ★ 锚定策略：轨道以 position:absolute 固定在聊天主区 #main 内，几何上与
//   「当前聚焦会话容器 .sess-pane」的视口严格重合（top/height 实时同步），
//   left 固定在 #main 左缘内侧 8px。
// ★ 交互：鼠标进入条带 → 最近长条吸附（fisheye 变长 + 微亮）；hover 停留
//   弹预览卡（取自已渲染消息 DOM，零网络请求）；点击 → 平滑定位到对应轮。
// ★ W790（item 4）：预览卡不再由本模块自建 —— 它是注册进 ui/hint 注册缝的
//   一个提供者（id 'rail-preview'，priority 10），延迟/宿主/撤卡统一归引擎；
//   轨道条带是 pointer-events:none（交互走 #main 级命中判定），所以用 hoverHint()
//   直驱悬停意图。本模块只负责「取内容 + 落位」，与原生 title 那套并存的历史取消。
// ★ W872/W886：轨道的**中间判定**（视口垂直中央落在哪一根长条上）—— 命中条
//   .is-center 态（只变色）+ 该条自身的悬停文案；W886 按用户要求删掉那条视口中间
//   发丝指示线（判定本身保留）。纯函数 ./rail-center.ts，这里只接线。
// ★ W514 多会话：长条按「会话视图容器」分别保存（WeakMap<SessionPane, RailState>）。
//   切换会话只做一次指针交换 + 元素搬家（appendChild 移动节点，不重建）：
//   各会话的长条集合/折叠条随容器一起保存，切回立即可见，零重排重建。
//   后台会话新增消息只写进它自己的 holder（离线容器），不触碰当前轨道。
// ============================================================================
import { hideHint, hoverHint, setHint } from './hint/card';
import type { HintHandle, HintPlugin } from './hint/registry';
import { registerHintPlugin } from '../plugins/register'; // W859：经插件模块记账（注销器保存，可热开关）
import { activePane, type SessionPane } from './viewctx';
import { t } from '../i18n';

// ---- 紧凑几何（细条 —— 自然高 5px、间隙 4px） ----
// W867：几何常量与公式搬到 ./rail-geom.ts（纯搬家，逐字未变：零 DOM、可单测）。
import {
  RAIL_PAD_Y, RAIL_PITCH_NATURAL, railBarHeight, railBarOpacity, railBarWidth,
  railCardPlacement, railFitsAll, railGrow, railGutterWidth, railHitRadius, railLane, railPitch,
} from './rail-geom';
import { railCenterHit, railCenterLabel } from './rail-center';
import { buildRailCard } from './rail-card';
import { docCenterY, viewWindow } from './rail-doc';
// W867：命中半径（hover 命中与点击命中共用同一口径；测试直接断言这个纯函数）。
export { railHitRadius };
/** W790：rail 预览卡在提示注册缝里的提供者身份（priority 10 = 压过内置纯文本卡）。 */
export const RAIL_HINT_ID = 'rail-preview';
const MAX_ROWS = 20;

/** 一根长条 = 一轮（一问一答合并）。 */
interface RailItem {
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
interface RailState {
  items: RailItem[];
  foldItem: RailItem | null;
  /** 非当前会话的离屏存放点（当前会话的长条常驻 track） */
  holder: HTMLElement;
}

const rails = new WeakMap<SessionPane, RailState>();
/** W790：长条元素 → 条目（提示提供者拿元素反查内容；WeakMap 随节点回收）。 */
const itemByEl = new WeakMap<HTMLElement, RailItem>();

let mainEl: HTMLElement | null = null;
/** 轨道当前绑定的会话容器（= 视觉上正在显示的那个）。 */
let cur: SessionPane | null = null;
let msgsEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let hoverItem: RailItem | null = null;
let syncQueued = false;
let midQueued = false;
let moveQueued = false;
/** W872：上一帧命中的条（换条时才动类与文案）。 */
let centerItem: RailItem | null = null;
let moveX = -1;
let moveY = -1;

let railX = 8;
let railTop = 0;
let railH = 0;
let railW = 110; // W867：缺省 = rail-geom 的 RAIL_MAX_W（此处不再单独引常量）
let pitch = RAIL_PITCH_NATURAL;
let modeAll = true;

function stateOf(ctx: SessionPane): RailState {
  let st = rails.get(ctx);
  if (!st) {
    const holder = document.createElement('div');
    holder.className = 'railv3-holder';
    st = { items: [], foldItem: null, holder };
    rails.set(ctx, st);
  }
  return st;
}

function curState(): RailState | null {
  return cur ? stateOf(cur) : null;
}

/** 参与布局/交互的全部条目（含折叠条）。 */
function allItems(st: RailState): RailItem[] {
  return st.foldItem ? [st.foldItem, ...st.items] : st.items;
}

// ---- 轨道与几何 ---------------------------------------------------------------

function ensureTrack(): boolean {
  if (!mainEl) return false;
  if (!track || !track.isConnected) {
    track = document.createElement('div');
    track.className = 'railv3';
    mainEl.appendChild(track);
  }
  return true;
}

function syncCenter(shown: RailItem[]): void {
  // shown 按时间自上而下；端点之外（视口中央在首/末条之外）返回 item = null ⇒ 没有条高亮。
  if (!msgsEl || railW <= 0) return; // 轨道被藏起（留白不足）时不判
  const hit = railCenterHit(shown.map((it) => ({ it, yDoc: docCenterY(msgsEl!, it.startCol) })), msgsEl.scrollTop + railH / 2);
  const item = hit?.item?.it ?? null;
  // 「居中」态 + 悬停文案：只在命中的那一根变化时动 DOM（几何一字不写）
  if (item !== centerItem) {
    if (centerItem) {
      centerItem.el.classList.remove('is-center');
      setHint(centerItem.el, centerItem.hint); // 复位为常驻文案
    }
    if (item && hit) {
      item.el.classList.add('is-center');
      setHint(item.el, railCenterLabel(hit, item.fold));
    }
  }
  centerItem = item;
}

/** 留白带宽：.mcol 左缘 − #main 左缘（算式在 ./rail-geom.ts，这里只取 rect）。 */
function gutterWidth(): number {
  if (!mainEl || !msgsEl) return 0;
  const col = msgsEl.querySelector<HTMLElement>('.mcol');
  const m = mainEl.getBoundingClientRect();
  return railGutterWidth(m.left, m.width, col ? col.getBoundingClientRect().left : null);
}

/** 全量重排：横向档位 + 纵向节距 + 条组居中（railSync / 滚动 / 尺寸变化）。 */
function layout(): void {
  const st = curState();
  if (!mainEl || !msgsEl || !track || !st) return;
  const m = mainEl.getBoundingClientRect();
  const v = msgsEl.getBoundingClientRect();
  railTop = Math.max(0, v.top - m.top);
  railH = v.height;

  const lane = railLane(gutterWidth());
  if (lane.hidden) {
    track.style.display = 'none';
    railW = 0;
    return;
  }
  track.style.display = '';
  const thin = lane.thin;
  railX = lane.left;
  railW = lane.width;
  track.classList.toggle('railv3-thin', thin);
  track.style.left = railX + 'px';
  track.style.top = railTop + 'px';
  track.style.height = railH + 'px';

  const usable = Math.max(0, railH - 2 * RAIL_PAD_Y);
  if (st.items.length === 0) {
    if (st.foldItem) {
      st.foldItem.el.remove();
      st.foldItem = null;
    }
    syncCenter([]); // W872：没有条可判 → 清掉「居中」态
    return;
  }
  const foldN = st.items.length > MAX_ROWS ? st.items.length - MAX_ROWS : 0;
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
      itemByEl.set(fresh.el, fresh);
      st.foldItem = fresh;
      if (stale && stale.parentNode) stale.remove();
    } else {
      fi.fold = foldN;
    }
    if (st.foldItem) {
      st.foldItem.fold = foldN;
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
    shown = viewWindow(msgsEl!, railH, st.items);
    pitch = railPitch(usable, shown.length);
  }
  const stripTop = RAIL_PAD_Y + Math.max(0, (usable - shown.length * pitch) / 2);
  const barH = railBarHeight(pitch);
  for (const it of bars) {
    const i = shown.indexOf(it);
    if (i < 0) {
      it.visible = false;
      it.el.style.display = 'none';
      continue;
    }
    it.visible = true;
    it.el.style.display = '';
    it.y = stripTop + i * pitch + pitch / 2;
    it.el.style.top = it.y - barH / 2 + 'px';
    it.el.style.setProperty('--barh', barH + 'px');
  }
  syncCenter(shown); // W872：同帧刷新「居中」态（一个类 + 文案，不重建 DOM）
}

// ---- 预览卡片 = 提示注册缝的一个提供者（W790；W872 只把「取内容」搬到 ./rail-card.ts） ----

/** 落位：贴长条右侧、纵向夹在轨道内（W871：算式见 ./rail-geom.ts 的 railCardPlacement）。 */
function positionCard(box: HTMLElement, anchor: HTMLElement): void {
  if (!mainEl) return;
  const m = mainEl.getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  const geom = { mainX: m.left, mainY: m.top, mainW: m.width, railTop, railH, railX, anchor: { top: r.top, right: r.right }, cardH: box.offsetHeight };
  const at = railCardPlacement(geom);
  box.style.top = at.top + 'px';
  box.style.left = at.left + 'px';
}

/** W790：预览卡提供者（普通插件，无特权；注销即退回内置纯文本卡）。 */
export function railHintPlugin(): HintPlugin {
  return {
    id: RAIL_HINT_ID,
    priority: 10,
    claim(target: HTMLElement): HintHandle | null {
      const it = itemByEl.get(target);
      if (!it) return null;
      return { build: () => buildRailCard(it), position: (box) => positionCard(box, target) };
    },
  };
}

// ---- 交互（fisheye + hover 停留预览 + 点击定位） --------------------------------

function setGrow(it: RailItem, g: number): void {
  // W867：宽度 / 不透明度算式搬到 ./rail-geom.ts（逐字同式，纯搬家）。
  it.el.style.width = railBarWidth(g, railW).toFixed(1) + 'px';
  it.el.style.opacity = railBarOpacity(g).toFixed(3);
}

function clearHover(): void {
  hoverItem = null;
  hideHint(); // W790：撤卡交给提示引擎（延迟/宿主/落位都不在本模块）
  const st = curState();
  if (st) for (const it of st.items) it.el.classList.remove('is-hover');
}

function collapse(): void {
  clearHover();
  const st = curState();
  if (st) for (const it of allItems(st)) setGrow(it, 0);
}

function onMove(e: PointerEvent): void {
  moveX = e.clientX;
  moveY = e.clientY;
  if (moveQueued) return;
  moveQueued = true;
  requestAnimationFrame(() => {
    moveQueued = false;
    applyMove();
  });
}

function applyMove(): void {
  const st = curState();
  if (!mainEl || !track || !st || !st.items.length) {
    collapse();
    return;
  }
  const m = mainEl.getBoundingClientRect();
  const x = moveX - m.left;
  const y = moveY - m.top;
  const inZone =
    railW > 0 && x >= railX - 6 && x <= railX + railW + 14 && y >= railTop && y <= railTop + railH;
  if (!inZone) {
    collapse();
    return;
  }
  const hitR = railHitRadius(pitch); // W867：命中 = 落在长条上（旧 max(pitch/2, 8) 恒 8px）
  let best: RailItem | null = null;
  let bestD = Infinity;
  for (const it of allItems(st)) {
    if (!it.visible) continue;
    const d = Math.abs(y - (railTop + it.y));
    setGrow(it, railGrow(d)); // W867：增益公式在 ./rail-geom.ts（默认 range = RAIL_FISHEYE_RANGE）
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  const hit = best !== null && bestD <= hitR ? best : null;
  if (hit) {
    setGrow(hit, 1);
    if (hoverItem !== hit) {
      hoverItem = hit;
      hoverHint(hit.el); // W790：停留 150ms → 提示引擎按提供者弹卡
    }
  } else {
    clearHover();
  }
  for (const it of allItems(st)) it.el.classList.toggle('is-hover', it === hit);
}

function onLeave(): void {
  collapse();
}

function onClick(e: MouseEvent): void {
  if (!mainEl || !hoverItem) return;
  const m = mainEl.getBoundingClientRect();
  const x = e.clientX - m.left;
  const y = e.clientY - m.top;
  if (x < railX - 6 || x > railX + railW + 14 || y < railTop || y > railTop + railH) return;
  if (Math.abs(y - (railTop + hoverItem.y)) > railHitRadius(pitch)) return; // W867：与 applyMove 同口径
  e.preventDefault();
  hoverItem.startCol.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onScroll(): void {
  // W872：条带全显示时也要重判「视口中央命中哪一轮」，但不做全量重排（只走一次 rAF）。
  if (modeAll) {
    queueMid();
    return;
  }
  queueSync(); // 超长会话：滚动刷新「跟随可见区域」子集（判定随 layout 一起更新）
}

/** W872：只刷新中间判定（条带几何不变时用），与 queueSync 同一套 rAF 节流口径。 */
function queueMid(): void {
  if (midQueued) return;
  midQueued = true;
  requestAnimationFrame(() => {
    midQueued = false;
    const st = curState();
    if (modeAll && st) syncCenter(allItems(st));
  });
}

// ---- 对外 API（messages.ts / restore.ts / viewctx 接线） -------------------------

function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    layout();
  });
}

/**
 * 注册一根轮条（addUserMessage / ensureAssistant 调用；一问一答合并）。role='user' → 新轮起点；
 * 'assistant' → 合并进最近一轮并标记已有回复；'interject' → 运行中插话：并入当前轮（不新起长条）。
 */
export function railAdd(ctx: SessionPane, col: HTMLElement, role: 'user' | 'assistant' | 'interject'): void {
  if (!mainEl) return;
  const st = stateOf(ctx);
  const live = ctx === cur && track !== null;
  const target = live && track ? track : st.holder;
  const last = st.items[st.items.length - 1];
  if (role === 'user' || !last) {
    const bar = document.createElement('div');
    bar.className = 'railv3-item' + (role === 'assistant' ? ' is-reply' : '');
    target.appendChild(bar);
    const hint = t('chat.rail.barHint', { n: st.items.length + 1 });
    setHint(bar, hint);
    st.items.push({
      startCol: col,
      cols: [col],
      hasReply: role === 'assistant',
      el: bar,
      y: 0,
      visible: false,
      fold: 0,
      hint,
    });
    itemByEl.set(bar, st.items[st.items.length - 1]!);
  } else {
    last.cols.push(col);
    if (role === 'assistant' && !last.hasReply) {
      last.hasReply = true;
      last.el.classList.add('is-reply');
    }
  }
  if (live) layout();
}

/** 清空某会话的长条并复位交互状态（resetMessages / 历史重载时调用）。 */
export function railReset(ctx: SessionPane): void {
  const st = stateOf(ctx);
  st.items = [];
  st.foldItem = null;
  st.holder.textContent = '';
  if (ctx === cur) {
    clearHover();
    hoverItem = null;
    centerItem = null; // W872：命中条即将被清空，判定随之复位
    if (track) track.textContent = '';
  }
}

/** 消息区重渲染后同步（流式钩子：重排 + 新增长条计数，rAF 节流）。 */
export function railSync(ctx: SessionPane): void {
  if (ctx !== cur) return; // 后台会话：只登记，不参与当前轨道布局
  queueSync();
}

/**
 * 会话切换：把旧长条搬回原 holder、把新会话的长条搬进轨道；只做节点搬家（零重建），几何由 layout() 重算。
 */
export function railActivate(ctx: SessionPane): void {
  if (cur === ctx) {
    queueSync();
    return;
  }
  if (cur && track) {
    const prev = stateOf(cur);
    // W872/W886：旧会话的「居中」条即将随整批搬家离开轨道。先把它的高亮摘掉再复位
    // 引用，否则切回该会话时新命中的条会与它同时带着 .is-center（同一轨两条高亮）。
    if (centerItem) centerItem.el.classList.remove('is-center');
    centerItem = null;
    while (track.firstChild) prev.holder.appendChild(track.firstChild);
  }
  clearHover();
  cur = ctx;
  msgsEl = ctx.el;
  if (!ensureTrack() || !track) return;
  const st = stateOf(ctx);
  while (st.holder.firstChild) track.appendChild(st.holder.firstChild);
  layout();
}

/** 装配（幂等；main.ts 在 viewctx 初始化之后调用一次）。 */
export function initRail(): void {
  if (mainEl) return;
  mainEl = document.getElementById('main');
  if (!mainEl) return;
  registerHintPlugin(railHintPlugin()); // W790 注册缝 / W859 经 plugins 记账（可热开关）
  cur = activePane();
  msgsEl = cur ? cur.el : null;
  ensureTrack();
  layout();

  mainEl.addEventListener('pointermove', onMove);
  mainEl.addEventListener('pointerleave', onLeave);
  mainEl.addEventListener('click', onClick);
  window.addEventListener('resize', queueSync);

  const ro = new ResizeObserver(queueSync);
  ro.observe(mainEl);
  bindScroll(cur);
}

/** 当前轨道绑定的容器（诊断/测试用）。 */
export function railBoundPane(): SessionPane | null {
  return cur;
}

/** 滚动监听随激活容器切换（scroll 事件不冒泡，必须绑在滚动元素上）。 */
let scrollBound: HTMLElement | null = null;
let resizeObs: ResizeObserver | null = null;

function bindScroll(ctx: SessionPane | null): void {
  if (scrollBound) scrollBound.removeEventListener('scroll', onScroll);
  scrollBound = ctx ? ctx.el : null;
  if (scrollBound) scrollBound.addEventListener('scroll', onScroll, { passive: true });
  if (!resizeObs) {
    resizeObs = new ResizeObserver(queueSync);
    if (mainEl) resizeObs.observe(mainEl);
  }
  if (ctx) resizeObs.observe(ctx.el);
}

// railActivate 之后由 viewctx 订阅回调统一调用（保持滚动/R 尺寸观察同步）
export function railRebind(ctx: SessionPane): void {
  bindScroll(ctx);
}
