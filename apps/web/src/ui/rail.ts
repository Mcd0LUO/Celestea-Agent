// ============================================================================
// ui/rail.ts — 「灵动消息选择条」v3（W238 删旧重做；W514 多会话化）
// ----------------------------------------------------------------------------
// ★ 锚定策略：轨道以 position:absolute 固定在聊天主区 #main 内，几何上与
//   「当前聚焦会话容器 .sess-pane」的视口严格重合（top/height 实时同步），
//   left 固定在 #main 左缘内侧 8px。
// ★ 交互：鼠标进入条带 → 最近长条吸附（fisheye 变长 + 微亮）；hover 停留
//   弹预览卡（取自已渲染消息 DOM，零网络请求）；点击 → 平滑定位到对应轮。
// ★ W514 多会话：长条按「会话视图容器」分别保存（WeakMap<SessionPane, RailState>）。
//   切换会话只做一次指针交换 + 元素搬家（appendChild 移动节点，不重建）：
//   各会话的长条集合/折叠条随容器一起保存，切回立即可见，零重排重建。
//   后台会话新增消息只写进它自己的 holder（离线容器），不触碰当前轨道。
// ============================================================================
import { el } from '../utils/dom';
import { activePane, type SessionPane } from './viewctx';

// ---- 紧凑几何（细条 —— 自然高 5px、间隙 4px） ----
const GAP = 4;
const PITCH_NATURAL = 5 + GAP; // 9px
const PITCH_MIN = 4;
const PAD_Y = 8;
const BASE_W = 7;
const MAX_W = 110;
const GUTTER_NORMAL = 64;
const GUTTER_HIDE = 24;
const RANGE = 80;
const HIT_BOOST = 6;
const BASE_OPACITY = 0.3;
const PREVIEW_MS = 150;
const PREVIEW_CHARS = 40;
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
}

/** 单个会话容器的长条集合（会话切换时整组保活）。 */
interface RailState {
  items: RailItem[];
  foldItem: RailItem | null;
  /** 非当前会话的离屏存放点（当前会话的长条常驻 track） */
  holder: HTMLElement;
}

const rails = new WeakMap<SessionPane, RailState>();

let mainEl: HTMLElement | null = null;
/** 轨道当前绑定的会话容器（= 视觉上正在显示的那个）。 */
let cur: SessionPane | null = null;
let msgsEl: HTMLElement | null = null;
let track: HTMLElement | null = null;
let card: HTMLElement | null = null;
let hoverItem: RailItem | null = null;
let hoverTimer: number | null = null;
let syncQueued = false;
let moveQueued = false;
let moveX = -1;
let moveY = -1;

let railX = 8;
let railTop = 0;
let railH = 0;
let railW = MAX_W;
let pitch = PITCH_NATURAL;
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

/** 留白带宽：.mcol 左缘 − #main 左缘（mcol 居中富余 + 容器内边距）。 */
function gutterWidth(): number {
  if (!mainEl || !msgsEl) return 0;
  const col = msgsEl.querySelector<HTMLElement>('.mcol');
  const m = mainEl.getBoundingClientRect();
  if (!col) return Math.max(0, m.width - 24);
  return Math.max(0, col.getBoundingClientRect().left - m.left);
}

/** 全量重排：横向档位 + 纵向节距 + 条组居中（railSync / 滚动 / 尺寸变化）。 */
function layout(): void {
  const st = curState();
  if (!mainEl || !msgsEl || !track || !st) return;
  const m = mainEl.getBoundingClientRect();
  const v = msgsEl.getBoundingClientRect();
  railTop = Math.max(0, v.top - m.top);
  railH = v.height;

  const gw = gutterWidth();
  if (gw < GUTTER_HIDE) {
    track.style.display = 'none';
    railW = 0;
    syncCard();
    return;
  }
  track.style.display = '';
  const thin = gw < GUTTER_NORMAL;
  railX = 8;
  railW = thin ? Math.max(6, gw - 24) : Math.min(MAX_W, gw - 26);
  track.classList.toggle('railv3-thin', thin);
  track.style.left = railX + 'px';
  track.style.top = railTop + 'px';
  track.style.height = railH + 'px';

  const usable = Math.max(0, railH - 2 * PAD_Y);
  if (st.items.length === 0) {
    if (st.foldItem) {
      st.foldItem.el.remove();
      st.foldItem = null;
    }
    syncCard();
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
      };
      fresh.el.className = 'railv3-item railv3-fold';
      fresh.el.textContent = '⋯';
      fresh.el.title = '更早的 ' + foldN + ' 轮已折叠';
      track.appendChild(fresh.el);
      st.foldItem = fresh;
      if (stale && stale.parentNode) stale.remove();
    } else {
      fi.fold = foldN;
    }
    if (st.foldItem) {
      st.foldItem.fold = foldN;
      st.foldItem.el.title = '更早的 ' + foldN + ' 轮已折叠';
    }
  } else if (st.foldItem) {
    st.foldItem.el.remove();
    st.foldItem = null;
  }
  const bars = allItems(st);
  const count = bars.length;
  let shown: RailItem[];
  if (count * PITCH_MIN <= usable) {
    modeAll = true;
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / count));
    shown = bars;
  } else {
    modeAll = false;
    shown = viewWindow(st);
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_NATURAL, usable / Math.max(1, shown.length)));
  }
  const stripTop = PAD_Y + Math.max(0, (usable - shown.length * pitch) / 2);
  const barH = Math.max(2, pitch - GAP);
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
  syncCard();
}

/** 消息列中心在滚动内容里的 Y（rect 法，不依赖 offsetParent）。 */
function docCenterY(it: RailItem): number {
  const v = msgsEl!.getBoundingClientRect();
  const c = it.startCol.getBoundingClientRect();
  return c.top - v.top + msgsEl!.scrollTop + c.height / 2;
}

/** 超长会话：只渲染视口上下各 ~0.2 屏范围内的条目（跟随可见区域）。 */
function viewWindow(st: RailState): RailItem[] {
  const st0 = msgsEl!.scrollTop;
  const lo = st0 - railH * 0.2;
  const hi = st0 + railH * 1.2;
  return st.items.filter((it) => {
    const y = docCenterY(it);
    return y >= lo && y <= hi;
  });
}

// ---- 预览卡片（数据取自 DOM，零请求） -------------------------------------------

function removeCard(): void {
  if (card) {
    card.remove();
    card = null;
  }
}

function firstLine(col: HTMLElement): string {
  const c = col.querySelector('.content');
  const raw = (c?.textContent ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!raw) return '';
  const line =
    raw
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? '';
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) + '…' : line;
}

function replyLine(it: RailItem): string {
  for (const col of it.cols) {
    if (col.querySelector('.msg.assistant')) return firstLine(col);
  }
  return '';
}

function showCard(it: RailItem): void {
  if (!mainEl || !it.visible) return;
  removeCard();
  card = el('div', 'railv3-card');
  if (it.fold > 0) {
    const ql = el('div', 'railv3-card-q');
    ql.appendChild(el('span', 'railv3-card-tag', '⋯'));
    ql.appendChild(el('span', null, '更早的 ' + it.fold + ' 轮已折叠'));
    card.appendChild(ql);
  } else {
    const q = firstLine(it.startCol);
    if (q) {
      const ql = el('div', 'railv3-card-q');
      ql.appendChild(el('span', 'railv3-card-tag', 'Q'));
      ql.appendChild(el('span', null, q));
      card.appendChild(ql);
    }
    if (it.hasReply) {
      const a = replyLine(it);
      if (a) {
        card.appendChild(el('div', 'railv3-card-sep'));
        const al = el('div', 'railv3-card-a');
        al.appendChild(el('span', 'railv3-card-tag', 'A'));
        al.appendChild(el('span', null, a));
        card.appendChild(al);
      }
    } else {
      card.appendChild(el('div', 'railv3-card-sep'));
      const al = el('div', 'railv3-card-a railv3-card-noa');
      al.appendChild(el('span', 'railv3-card-tag', 'A'));
      al.appendChild(el('span', null, '（无回复）'));
      card.appendChild(al);
    }
  }
  mainEl.appendChild(card);
  positionCard(it);
}

function positionCard(it: RailItem): void {
  if (!card || !mainEl) return;
  const m = mainEl.getBoundingClientRect();
  const r = it.el.getBoundingClientRect();
  const ch = card.offsetHeight;
  let top = r.top - m.top;
  top = Math.max(railTop + 4, Math.min(top, railTop + railH - ch - 4));
  const left = Math.min(r.right - m.left + 8, m.width - 288);
  card.style.top = top + 'px';
  card.style.left = Math.max(railX + 4, left) + 'px';
}

function syncCard(): void {
  if (!card) return;
  if (!hoverItem || !hoverItem.visible) {
    removeCard();
    return;
  }
  positionCard(hoverItem);
}

// ---- 交互（fisheye + hover 停留预览 + 点击定位） --------------------------------

function setGrow(it: RailItem, g: number): void {
  const k = Math.max(0, Math.min(1, g));
  const w = BASE_W + k * Math.max(0, railW - BASE_W) + (k >= 1 ? HIT_BOOST : 0);
  it.el.style.width = w.toFixed(1) + 'px';
  it.el.style.opacity = (BASE_OPACITY + (0.7 - BASE_OPACITY) * k).toFixed(3);
}

function clearHover(): void {
  if (hoverTimer !== null) {
    window.clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoverItem = null;
  removeCard();
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
  const hitR = Math.max(pitch / 2, 8);
  let best: RailItem | null = null;
  let bestD = Infinity;
  for (const it of allItems(st)) {
    if (!it.visible) continue;
    const d = Math.abs(y - (railTop + it.y));
    setGrow(it, 1 - d / RANGE);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  const hit = best !== null && bestD <= hitR ? best : null;
  if (hit) {
    setGrow(hit, 1);
    if (hoverItem !== hit) {
      if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      removeCard();
      hoverItem = hit;
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        if (hoverItem) showCard(hoverItem);
      }, PREVIEW_MS);
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
  if (Math.abs(y - (railTop + hoverItem.y)) > Math.max(pitch / 2, 8)) return;
  e.preventDefault();
  hoverItem.startCol.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onScroll(): void {
  if (modeAll) return;
  queueSync();
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
 * 注册一根轮条（addUserMessage / ensureAssistant 调用；一问一答合并）。
 * role='user' → 新轮起点；'assistant' → 合并进最近一轮并标记已有回复；
 * 'interject' → 运行中插话：并入当前轮（不新起长条）。
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
    st.items.push({
      startCol: col,
      cols: [col],
      hasReply: role === 'assistant',
      el: bar,
      y: 0,
      visible: false,
      fold: 0,
    });
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
    if (track) track.textContent = '';
  }
}

/** 消息区重渲染后同步（流式钩子：重排 + 新增长条计数，rAF 节流）。 */
export function railSync(ctx: SessionPane): void {
  if (ctx !== cur) return; // 后台会话：只登记，不参与当前轨道布局
  queueSync();
}

/**
 * 会话切换：把旧会话的长条搬回它自己的 holder，再把新会话的长条搬进轨道。
 * 只做节点搬家（零重建）；几何由 layout() 依据新容器重算。
 */
export function railActivate(ctx: SessionPane): void {
  if (cur === ctx) {
    queueSync();
    return;
  }
  if (cur && track) {
    const prev = stateOf(cur);
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
