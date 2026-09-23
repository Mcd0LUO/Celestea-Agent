// ============================================================================
// ui/worker-strip.ts — W866：会话页左上角的「本会话 worker 快捷条」。
//
// 为什么另立一条（与侧栏 Worker 组的分工）：
//   · 侧栏 sessiontree/workers.ts 的组是**全局谱系视图**（父会话 → 子 worker，
//     5s 轮询），回答「这台机器上有哪些 worker」；
//   · 本模块是**当前聚焦会话**的快捷条，常驻会话页（#main 左上角），回答
//     「我正看着的这个会话派了哪些 worker、现在在跑哪个」，点一下聚焦过去。
//     两者数据同源（GET /api/sessions 的 kind='worker' 行），落点不同、互不遮挡：
//     侧栏是窄栏里的谱系列表，本条是正文列**左侧空白带**里的竖排 chip ——
//     正文列 clamp(680,64%,920) 居中且 .mcol 最大 660px，宽屏下这块留白是空的；
//     带宽不足（≤1024px）时整条隐藏，绝不压到正文上。
//
// 即时性（W866 需求 3）：模型调 spawn_worker 后，前端在**工具结果到达当帧**就把该
//   worker 行插进本条（noteWorkerSpawn，不等 5s 轮询）；随后对账走已有列表刷新
//   （loadTreeInto / refreshWorkers / busy 变化），轮询只是补充，不是出现的必要条件。
//
// 几何契约：绝对定位于 #main（rail.css 已给 #main position:relative），钉在正文列
//   左侧的空白带里竖排；pointer-events 只落在 chip 自身上（空白处穿透），
//   z-index 低于 rail 的悬停卡；左侧留白不足以容纳 chip 时整条隐藏（正文优先）。
//
// W1472：**聚焦某个 worker 时，本条换形态**（用户原话：「不应该一样放在左上角吗」）。
//   用户是从这条 chip 点进 worker 的，回程就该长在同一个入口处 —— 于是聚焦 worker 时
//   本条不再列「本会话派出的 worker」（那时它是 worker 自己，归属判定必然落空 ⇒ 旧兜底
//   会把**别的会话**的 worker 全摊开，与左侧栏谱系重复），而是回答两件事：
//     ① 我在哪：这个 worker 自己的 wid / 短名 / 状态（带上一代徽标）；
//     ② 怎么回去：一条「← 返回 <父会话>」入口（三态诚实降级见 ui/worker-lineage.ts）。
//   行未知（列表还没对账到这个 worker）⇒ **什么都不画**，绝不猜成「没有父会话」。
//   贴底会话条上的同一入口保留为 **≤1024px 的兜底**：本条在该断点整条隐藏（几何契约
//   不变），窄屏上它是唯一的回程；views.css 用 min-width:1025px 让两者**互斥**，
//   任何时候页面上只有一个回程入口可见（见 .sess-bar-lineage 的规则注释）。
// ============================================================================
import type { SessionInfo } from '../types';
import { el } from '../utils/dom';
import { t } from '../i18n';
import { openSession } from './restore';
import { lineageOf, noteSessionList, type LineageLink } from './worker-lineage'; // W1471/W1472：谱系事实的唯一真源
import { activePane, paneBusy, type SessionPane } from './viewctx';

/** 一行「本会话的 worker」（由列表行折算；只保留渲染需要的字段）。 */
interface StripRow {
  id: string;
  wid: string;
  title: string;
  model: string;
  /** 注册表状态（RUNNING / DONE / FAILED …）；缺省空串。 */
  status: string;
  /** W1470b：上一代进程留下的行（重启后仍在，当前没有活实例驱动它）。 */
  inherited: boolean;
}

/**
 * W1472：聚焦形态要画的东西 —— 「我在哪」（worker 自己的标识）+「怎么回去」（谱系）。
 * 只有**列表里有这个 worker 的行**时才会构造出来（见 focusOf）；行未知时本条
 * 走 'unknown' —— 什么都不画，绝不猜成「没有父会话」。
 */
interface FocusView {
  id: string;
  wid: string;
  title: string;
  status: string;
  inherited: boolean;
  lineage: LineageLink;
}

/**
 * W1472：本条该画什么（三态，互斥）。
 *   'list'    —— 常规 chip 列表（非 worker 容器 / 未解析的 LOCAL）；
 *   'focus'   —— 聚焦某个 worker 且列表里有它的行：画「我在哪 / 怎么回去」；
 *   'unknown' —— 聚焦某个 worker 但列表里**没有**它的行：什么都不画。
 *               绝不退回 'list' 的兜底 —— 那会把**别的会话**的 worker 摊开
 *               （旧 rowsForSession 的归属兜底），而用户此刻问的是「我在哪」。
 */
type StripMode = 'list' | 'focus' | 'unknown';

let box: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let leadEl: HTMLElement | null = null;
/** 最近一次列表真值（会话切换时据此重算归属，零请求）。 */
let lastList: SessionInfo[] = [];
/** 当前快捷条显示的 worker 行。 */
let rows: StripRow[] = [];
let currentSession = '';
/** W1472：本条当前形态（见 StripMode）。 */
let mode: StripMode = 'list';
/** W1472：mode==='focus' 时要画的东西。 */
let focus: FocusView | null = null;
/** W1472：聚焦形态的内容签名（不变则不重建，铁律 6）。 */
let lastFocusKey = '\u0000';

/** 标题前缀的 wid（`W866·短名`）；缺省回落后端给的 wid / id 末段。 */
export function widOf(w: SessionInfo): string {
  const explicit = (w.wid ?? '').trim();
  if (explicit !== '') return explicit;
  const t = (w.title ?? '').trim();
  const m = /^(W\d+)/.exec(t);
  if (m && m[1]) return m[1];
  const id = w.id ?? '';
  const i = id.lastIndexOf('-');
  return i >= 0 ? id.slice(i + 1) : id;
}

function titleOf(w: SessionInfo): string {
  const t = (w.title ?? '').trim().replace(/^W\d+\s*[·:：-]\s*/, '');
  return t || widOf(w);
}

function toRow(w: SessionInfo): StripRow {
  return {
    id: w.id ?? '',
    wid: widOf(w),
    title: titleOf(w),
    model: String(w.model ?? ''),
    status: String(w.status ?? ''),
    inherited: w.inherited === true,
  };
}

/** W515/W866：worker 行归属的父会话 id（三种写法兼容）。 */
function parentOf(w: SessionInfo): string | null {
  const v = w.parentSessionId ?? w.parent_session ?? w.parent;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function isWorkerRow(w: SessionInfo): boolean {
  return w.kind === 'worker' || (w.id ?? '').startsWith('worker:');
}

/**
 * 只取「当前聚焦会话的 worker」。
 *
 * 归属判定按优先级：行上的 parent 字段 → `worker:<hostSid>-session-<n>` 的 id
 * 前缀（W513 的 registry 前缀就是宿主会话 id）→ 无法归属时**列全部**。最后那条
 * 兜底是刻意的：后端两个字段都没有时，「刚派出去的 worker 看不见」比「多显示几行」
 * 危险得多。老后端因此退化成全局快捷条（本条的降级形态）。
 */
export function rowsForSession(list: SessionInfo[], sessionId: string): StripRow[] {
  const workers = list.filter(isWorkerRow);
  if (sessionId === '') return workers.map(toRow);
  const mine = workers.filter((w) => {
    const p = parentOf(w);
    if (p !== null) return p === sessionId;
    const id = w.id ?? '';
    const inner = id.startsWith('worker:') ? id.slice('worker:'.length) : id;
    return inner.startsWith(sessionId + '-');
  });
  return (mine.length > 0 ? mine : workers).map(toRow);
}

/** 状态位文字：注册表状态优先，缺省按本页运行态回落（chip 与聚焦形态共用）。 */
function metaText(r: StripRow, busy: boolean): string {
  return r.status === '' ? (busy ? t('shell.tree.running') : t('shell.tree.idle')) : r.status;
}

/** chip 的悬停提示（同上，两种形态共用同一口径）。 */
function rowHint(r: StripRow): string {
  return r.wid + ' · ' + r.title + (r.model ? ' · ' + r.model : '') + t(r.inherited ? 'shell.worker.inheritedHint' : 'shell.worker.stripHint');
}

/** worker 的标识（状态点 + wid + 短名 + 上一代徽标）—— 聚焦形态与 chip 同族。 */
function identityEl(r: StripRow, busy: boolean): HTMLElement {
  const head = el('span', 'ws-strip-self');
  head.appendChild(el('span', 'sess-dot' + (busy ? ' busy' : '')));
  head.appendChild(el('span', 'ws-strip-wid', r.wid));
  head.appendChild(el('span', 'ws-strip-title', r.title));
  // W1470b：上一代行加一个徽标，与「本代运行中」的 chip 一眼可分。
  if (r.inherited) head.appendChild(el('span', 'ws-strip-badge', t('shell.worker.inherited')));
  head.appendChild(el('span', 'ws-strip-meta', metaText(r, busy)));
  return head;
}

/**
 * W1473：聚焦形态的「我在哪」—— 把标识**拆成两个兄弟行盒**。
 *   · 第一层 .ws-strip-id   —— 状态点 + wid：**身份**，任何宽度都必须完整；
 *   · 第二层 .ws-strip-facts —— 短名（省略号截断）+ 上一代徽标 + 状态位。
 *
 * 为什么必须拆（我第一版只把回程挪到第二行，不够）：左上角这条只有正文列左侧留白
 * 那么宽（真机 1440px 实测 181px）。wid 与标题同处一条 inline-flex 时，标题是唯一的
 * flex:0 1 auto 收缩项 —— 即使回程已经独占一行，标题仍只拿到 36px（需要 66px），
 * 真机实测 titleClipped=true，显示成「calc-1…」。拆开后标题拿剩余全宽（105px ≥ 66px），
 * 完整显示不截断。
 */
function focusIdentity(r: StripRow, busy: boolean): HTMLElement {
  const wrap = el('div', 'ws-strip-idrow');
  const id = el('span', 'ws-strip-id');
  id.appendChild(el('span', 'sess-dot' + (busy ? ' busy' : '')));
  id.appendChild(el('span', 'ws-strip-wid', r.wid));
  const facts = el('span', 'ws-strip-facts');
  facts.appendChild(el('span', 'ws-strip-title', r.title));
  // W1470b：上一代行加一个徽标，与「本代运行中」的 chip 一眼可分。
  if (r.inherited) facts.appendChild(el('span', 'ws-strip-badge', t('shell.worker.inherited')));
  facts.appendChild(el('span', 'ws-strip-meta', metaText(r, busy)));
  wrap.appendChild(id);
  wrap.appendChild(facts);
  return wrap;
}

function rowEl(r: StripRow): HTMLElement {
  const busy = paneBusy(r.id);
  const settled = r.status !== '' && r.status !== 'RUNNING';
  const row = el('button', 'ws-strip-row' + (busy ? ' running' : '') + (settled ? ' settled' : '') + (r.inherited ? ' inherited' : '')) as HTMLButtonElement;
  row.type = 'button';
  row.dataset.id = r.id;
  row.appendChild(identityEl(r, busy));
  row.title = rowHint(r);
  row.addEventListener('click', () => {
    openSession(r.id, { kind: 'worker', title: r.title });
  });
  return row;
}

/**
 * W1472：聚焦 worker 时的回程入口（与 ui/sessionbar.ts 的 .sess-bar-back 同一口径）。
 *   state='ok' → 可点按钮「← 返回 <父会话>」；
 *   gone/unlinked → **不可点**的说明（沿用既有话术，绝不画死按钮）。
 */
function backEntry(link: LineageLink): HTMLElement {
  if (link.state !== 'ok') {
    const note = el('span', 'ws-strip-unlinked', t(link.state === 'gone' ? 'shell.sessbar.parentGone' : 'shell.worker.unlinked'));
    note.title = link.id === '' ? t('shell.worker.unlinked') : t('shell.sessbar.parentGoneHint', { id: link.id });
    return note;
  }
  const back = el('button', 'ws-strip-back', t('shell.sessbar.backToParent', { name: link.title })) as HTMLButtonElement;
  back.type = 'button';
  back.dataset.parent = link.id;
  back.title = t('shell.worker.parentHint') + ' · ' + link.id;
  back.addEventListener('click', () => {
    openSession(link.id, { kind: 'session' });
  });
  return back;
}

/** 隐藏整条（无内容可画）。 */
function hide(): void {
  if (box === null || listEl === null || countEl === null) return;
  box.classList.add('hidden');
  listEl.replaceChildren();
  countEl.textContent = '';
  lastFocusKey = '\u0000';
}

/**
 * W1472：聚焦 worker 的形态 —— 一条 chip 里回答「我在哪 / 怎么回去」。
 *   调用前 mode 已是 'focus'（行未知走 'unknown' 分支，见 render），
 *   因此这里的 lineage 一定存在。
 *   内容签名不变则不重建（铁律 6：切会话/运行态变化都会调到这里）。
 */
function renderFocus(f: FocusView): void {
  if (listEl === null || countEl === null || box === null || leadEl === null) return;
  const busy = paneBusy(f.id);
  const settled = f.status !== '' && f.status !== 'RUNNING';
  const link = f.lineage;
  const key = [f.id, f.wid, f.title, f.status, f.inherited ? '1' : '0', busy ? '1' : '0', link.state, link.id, link.title].join('\u0001');
  box.classList.remove('hidden');
  box.dataset.mode = 'focus';
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  leadEl.textContent = t('shell.worker.focusTitle');
  countEl.textContent = '';
  // W1473：标识**分层**（见 focusIdentity），回程是 chip 的**兄弟节点**（独占一行）。
  // 纵向 flex 容器里自上而下：身份层 / 短名层 / 回程层，各占一行、互不挤宽。
  // 关键不变量：.ws-strip-id 与 .ws-strip-back 是兄弟节点，几何上不可能重叠。
  const chip = el('div', 'ws-strip-row ws-strip-focus' + (busy ? ' running' : '') + (settled ? ' settled' : '') + (f.inherited ? ' inherited' : ''));
  chip.dataset.id = f.id; // 与列表形态同一把尺子（真机探针/测试都按 data-id 认这一行）
  chip.appendChild(focusIdentity({ id: f.id, wid: f.wid, title: f.title, model: '', status: f.status, inherited: f.inherited }, busy));
  listEl.replaceChildren(chip, backEntry(link));
}

/** 只重画列表内容（切会话 / 列表变化时才调）。 */
function render(): void {
  if (listEl === null || countEl === null || box === null) return;
  // 宿主不在（或只跑在 jsdom 的模块单测里）→ 只更新模块状态，不触碰 DOM。
  if (!box.isConnected) return;
  if (mode === 'unknown') {
    // 聚焦的 worker 行未知：不知道就说不知道（不画聚焦形态，也不退回「列全部」）。
    box.dataset.mode = 'unknown';
    hide();
    return;
  }
  if (mode === 'focus' && focus !== null) {
    renderFocus(focus);
    return;
  }
  box.dataset.mode = 'list';
  lastFocusKey = '\u0000';
  if (rows.length === 0) {
    hide();
    return;
  }
  box.classList.remove('hidden');
  const off = document.createDocumentFragment();
  for (const r of rows) off.appendChild(rowEl(r));
  listEl.replaceChildren(...Array.from(off.childNodes));
  countEl.textContent = String(rows.length);
  const running = rows.filter((r) => paneBusy(r.id)).length;
  if (leadEl !== null) leadEl.textContent = running > 0 ? t('shell.worker.stripTitle', { n: running }) : t('shell.worker.stripTitlePlain');
}

/**
 * 用会话列表真值对账（loadTreeInto / refreshWorkers / busy 变化都会调到这里）。
 * `pane` 省略 = 取当前聚焦容器。
 */
export function updateWorkerStrip(sessions: SessionInfo[] | null | undefined, pane?: SessionPane | null): void {
  if (sessions !== null && sessions !== undefined) lastList = sessions;
  // W1471：同一份列表真值也是「会话条回程入口」的唯一事实源（零额外请求）。
  noteSessionList(lastList);
  const target = pane === undefined ? activePane() : pane;
  // LOCAL（未解析）容器的 id 是空串：此时没有「本会话」，列全部是对用户最有用的降级。
  currentSession = target === null ? '' : target.id;
  focus = focusOf(lastList, target);
  // 聚焦的是 worker 但列表里没有它的行 ⇒ 'unknown'（什么都不画），
  // 绝不落到 rowsForSession 的「归属判定不出来时列全部」兜底。
  mode = target !== null && target.kind === 'worker' ? (focus === null ? 'unknown' : 'focus') : 'list';
  rows = mode === 'list' ? rowsForSession(lastList, currentSession) : [];
  render();
}

/**
 * W866：刚 spawn 出一个 worker（工具结果 / HTTP 响应当帧）→ **立刻**插入一行，
 * 不等下一次轮询。同一 id 已存在则只更新该行（不重复插入）。
 */
export function noteWorkerSpawn(w: SessionInfo): void {
  const id = w.id ?? '';
  if (id === '' || box === null) return;
  const row = toRow(w);
  const at = rows.findIndex((r) => r.id === id);
  if (at >= 0) rows[at] = { ...rows[at], ...row };
  else rows = [...rows, row];
  render();
}

/**
 * W1472：聚焦的正是列表里的某个 worker 时，本条换成「我在哪 / 怎么回去」形态。
 *   非 worker 容器、worker 但行未知（lineageOf → null）、列表里没有这一行 ⇒ null
 *   （维持原来的 chip 形态，行为一字不动）。
 */
function focusOf(list: SessionInfo[], target: SessionPane | null): FocusView | null {
  if (target === null || target.kind !== 'worker') return null;
  const lineage = lineageOf(target);
  if (lineage === null) return null; // 行未知 ⇒ null（updateWorkerStrip 据此走 'unknown'）
  const row = list.find((s) => (s.id ?? '') === target.id);
  if (row === undefined) return null; // 类型收窄：lineageOf 读的是同一份列表，正常到不了这里
  const r = toRow(row);
  return { id: r.id, wid: r.wid, title: r.title, status: r.status, inherited: r.inherited, lineage };
}

/** 装配（幂等）：把快捷条挂进 #main；返回宿主（null = 本页没有 #main）。 */
export function initWorkerStrip(): HTMLElement | null {
  if (box !== null) return box;
  const main = document.getElementById('main');
  if (!main) return null;
  // W866 位置决策：条目挂在 **#main 的左上角**（不在滚动容器 .sess-pane 里，
  // 因此不随消息滚动、也不与正文抢列宽）——正文列 clamp(680,64%,920) 居中且
  // .mcol 最大 660px，宽屏下左侧这块留白是空的；chip 竖排一列，带宽不足时
  // CSS 直接整条隐藏（正文优先）。几何/颜色见 styles/workerstrip.css。
  const built = el('div', 'ws-strip hidden');
  built.id = 'wsStrip';
  const head = el('div', 'ws-strip-head');
  leadEl = el('span', 'ws-strip-lead', t('shell.worker.stripTitlePlain'));
  countEl = el('span', 'ws-strip-count', '');
  listEl = el('div', 'ws-strip-list');
  head.appendChild(leadEl);
  head.appendChild(countEl);
  built.appendChild(head);
  built.appendChild(listEl);
  main.appendChild(built);
  box = built;
  return box;
}

/** 测试/热重载用：丢弃模块级 DOM 句柄（不动 DOM）。 */
export function resetWorkerStrip(): void {
  box = null;
  listEl = null;
  countEl = null;
  leadEl = null;
  rows = [];
  lastList = [];
  currentSession = '';
  mode = 'list';
  focus = null;
  lastFocusKey = '\u0000';
}

/** 测试/诊断用只读视图（当前显示的行）。 */
export function stripRows(): StripRow[] {
  return rows.map((r) => ({ ...r }));
}

export { isWorkerRow };
