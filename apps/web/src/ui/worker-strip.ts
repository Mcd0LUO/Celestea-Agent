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
// ============================================================================
import type { SessionInfo } from '../types';
import { el } from '../utils/dom';
import { t } from '../i18n';
import { openSession } from './restore';
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

let box: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let leadEl: HTMLElement | null = null;
/** 最近一次列表真值（会话切换时据此重算归属，零请求）。 */
let lastList: SessionInfo[] = [];
/** 当前快捷条显示的 worker 行。 */
let rows: StripRow[] = [];
let currentSession = '';

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

function rowEl(r: StripRow): HTMLElement {
  const busy = paneBusy(r.id);
  const settled = r.status !== '' && r.status !== 'RUNNING';
  const row = el('button', 'ws-strip-row' + (busy ? ' running' : '') + (settled ? ' settled' : '') + (r.inherited ? ' inherited' : '')) as HTMLButtonElement;
  row.type = 'button';
  row.dataset.id = r.id;
  row.appendChild(el('span', 'sess-dot' + (busy ? ' busy' : '')));
  row.appendChild(el('span', 'ws-strip-wid', r.wid));
  row.appendChild(el('span', 'ws-strip-title', r.title));
  // W1470b：上一代行加一个徽标，与「本代运行中」的 chip 一眼可分。
  if (r.inherited) row.appendChild(el('span', 'ws-strip-badge', t('shell.worker.inherited')));
  row.appendChild(el('span', 'ws-strip-meta', r.status === '' ? (busy ? t('shell.tree.running') : t('shell.tree.idle')) : r.status));
  row.title =
    r.wid + ' · ' + r.title + (r.model ? ' · ' + r.model : '') + t(r.inherited ? 'shell.worker.inheritedHint' : 'shell.worker.stripHint');
  row.addEventListener('click', () => {
    openSession(r.id, { kind: 'worker', title: r.title });
  });
  return row;
}

/** 只重画列表内容（切会话 / 列表变化时才调）。 */
function render(): void {
  if (listEl === null || countEl === null || box === null) return;
  // 宿主不在（或只跑在 jsdom 的模块单测里）→ 只更新模块状态，不触碰 DOM。
  if (!box.isConnected) return;
  if (rows.length === 0) {
    box.classList.add('hidden');
    listEl.replaceChildren();
    countEl.textContent = '';
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
  const target = pane === undefined ? activePane() : pane;
  // LOCAL（未解析）容器的 id 是空串：此时没有「本会话」，列全部是对用户最有用的降级。
  currentSession = target === null ? '' : target.id;
  rows = rowsForSession(lastList, currentSession);
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
}

/** 测试/诊断用只读视图（当前显示的行）。 */
export function stripRows(): StripRow[] {
  return rows.map((r) => ({ ...r }));
}

export { isWorkerRow };
