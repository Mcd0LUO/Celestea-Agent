// ============================================================================
// ui/taskpanel/panel.ts — W1533 任务面板的**渲染层**（可折叠面板 + 打勾）。
// ----------------------------------------------------------------------------
// 位置决策（报告里展开）：挂在会话视图容器 .sess-pane 的**顶部**，作为该会话消息流
// 的第一个子节点。为什么不是工作台面板 / 侧栏：
//   ① 任务清单是**这个会话**的，工作台面板是全局的、可停靠的，两者生命周期不同；
//   ② 侧栏已有「工作区 · 会话」与 worker 谱系，再塞一份会随会话切换而错位；
//   ③ 会话顶部条（#sessionBar）只有一行 11px 灰字，放不下多行清单；
//   ④ .sess-pane 是每会话独立容器、切换零重渲染 —— 清单跟着会话走，天然正确。
// 折叠：只切 class + CSS transition，DOM 不重建（铁律 4）。
// 局部更新：行身份 = 内容（见 model.rowKeys），状态变化只改那一行的勾与类（铁律 2）。
// ============================================================================

import { el } from '../../utils/dom';
import { t } from '../../i18n';
import { changedIndexes, deltaOf, panelStateOf, type TaskItem, type TaskSnapshot } from './model';

/** 面板的 DOM 句柄（一行一个，索引 = 该行在清单里的位置）。 */
interface RowRef {
  root: HTMLElement;
  check: HTMLElement;
  text: HTMLElement;
  /** 状态文案节点（「待办 / 进行中 / 已完成」），随语言与状态就地更新。 */
  statusEl: HTMLElement;
  /** 该行此刻的状态（局部更新的判据之一）。 */
  status: TaskItem['status'];
  content: string;
}

export interface TaskPanelRef {
  root: HTMLElement;
  head: HTMLButtonElement;
  count: HTMLElement;
  body: HTMLElement;
  list: HTMLElement;
  note: HTMLElement;
  rows: RowRef[];
  collapsed: boolean;
  /** 最近一次渲染的清单（局部更新的基准）。 */
  tasks: TaskItem[];
}

/** 勾的形状：三态共用同一个 <span>，只切 class 与字形（不换节点 ⇒ 零重建）。 */
function checkGlyph(status: TaskItem['status']): string {
  if (status === 'completed') return '\u2713';
  if (status === 'in_progress') return '\u25b8';
  return '';
}

/** 一条任务行（离屏构建；调用方负责挂载）。 */
function buildRow(task: TaskItem): RowRef {
  const root = el('li', 'tp-row is-' + task.status);
  const check = el('span', 'tp-check', checkGlyph(task.status));
  check.setAttribute('aria-hidden', 'true');
  const text = el('span', 'tp-text', task.content);
  const statusEl = el('span', 'tp-status', t(statusKey(task.status)));
  root.appendChild(check);
  root.appendChild(text);
  root.appendChild(statusEl);
  return { root, check, text, statusEl, status: task.status, content: task.content };
}

/** 状态 → i18n key（三态各自的**可读**文案，不只靠颜色/字形）。 */
function statusKey(status: TaskItem['status']): 'chat.tasks.status.pending' | 'chat.tasks.status.inProgress' | 'chat.tasks.status.completed' {
  if (status === 'completed') return 'chat.tasks.status.completed';
  if (status === 'in_progress') return 'chat.tasks.status.inProgress';
  return 'chat.tasks.status.pending';
}

/**
 * 就地改写**一行**（局部更新的最小单位）：
 *   · class 只动 is-* 三个状态类；
 *   · 勾的字形与状态文案就地改 textContent；
 *   · **节点引用不变** —— 这正是「只有那一行的 DOM 变化」的可断言证据。
 */
function paintRow(row: RowRef, task: TaskItem): void {
  row.root.classList.remove('is-pending', 'is-in_progress', 'is-completed');
  row.root.classList.add('is-' + task.status);
  row.check.textContent = checkGlyph(task.status);
  row.statusEl.textContent = t(statusKey(task.status));
  if (row.text.textContent !== task.content) row.text.textContent = task.content;
  row.status = task.status;
  row.content = task.content;
}

/** 面板骨架（离屏构建；**只在第一次**建，之后一直复用）。 */
export function buildPanel(): TaskPanelRef {
  const root = el('section', 'tp-panel');
  root.hidden = true;
  root.setAttribute('aria-label', t('chat.tasks.title'));
  const head = el('button', 'tp-head') as HTMLButtonElement;
  head.type = 'button';
  const chev = el('span', 'tp-chev', '\u25b8');
  chev.setAttribute('aria-hidden', 'true');
  const title = el('span', 'tp-title', t('chat.tasks.title'));
  const count = el('span', 'tp-count', '');
  head.appendChild(chev);
  head.appendChild(title);
  head.appendChild(count);
  const body = el('div', 'tp-body');
  const list = el('ul', 'tp-list');
  const note = el('div', 'tp-note', '');
  body.appendChild(list);
  body.appendChild(note);
  root.appendChild(head);
  root.appendChild(body);
  return { root, head, count, body, list, note, rows: [], collapsed: false, tasks: [] };
}

/** 折叠态（只切 class/属性 + CSS transition，绝不删节点）。 */
export function setCollapsed(ref: TaskPanelRef, collapsed: boolean): void {
  ref.collapsed = collapsed;
  ref.root.classList.toggle('collapsed', collapsed);
  ref.head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/** 头部计数与底部说明（空态/全完成态/进度文案）。 */
function paintSummary(ref: TaskPanelRef, snap: TaskSnapshot): void {
  const { completed } = snap.counts;
  const total = snap.tasks.length;
  ref.count.textContent = t('chat.tasks.count', { done: completed, total });
  const state = panelStateOf(snap.tasks);
  if (state === 'allDone') {
    ref.note.textContent = t('chat.tasks.allDone');
    ref.note.className = 'tp-note is-done';
  } else if (state === 'empty') {
    ref.note.textContent = t('chat.tasks.empty');
    ref.note.className = 'tp-note is-empty';
  } else {
    ref.note.textContent = t('chat.tasks.remaining', { n: total - completed });
    ref.note.className = 'tp-note';
  }
}

/**
 * 用一份清单刷新面板。三种路径（model.deltaOf 判定）：
 *   'same'    逐行相同 → 直接返回，**一个节点都不碰**；
 *   'inplace' 行集合/顺序未变，只有个别行变了 → 只重画那几行（局部更新）；
 *   'rebuild' 行集合或顺序变了 → 离屏构建整表 + 单次 replaceChildren（铁律 1）。
 * 返回本次实际走的路径（测试/报告要引用它作为证据）。
 */
export function renderPanel(ref: TaskPanelRef, snap: TaskSnapshot): 'same' | 'inplace' | 'rebuild' {
  const delta = deltaOf(ref.tasks, snap.tasks);
  if (delta === 'inplace') {
    for (const i of changedIndexes(ref.tasks, snap.tasks)) {
      const row = ref.rows[i];
      const task = snap.tasks[i];
      if (row !== undefined && task !== undefined) paintRow(row, task);
    }
  } else if (delta === 'rebuild') {
    const rows: RowRef[] = [];
    const off = document.createDocumentFragment();
    for (const task of snap.tasks) {
      const row = buildRow(task);
      rows.push(row);
      off.appendChild(row.root);
    }
    ref.list.replaceChildren(off);
    ref.rows = rows;
  }
  ref.tasks = snap.tasks.map((x) => ({ content: x.content, status: x.status }));
  ref.count.dataset['total'] = String(snap.tasks.length);
  ref.count.dataset['completed'] = String(snap.counts.completed);
  ref.root.dataset['state'] = panelStateOf(snap.tasks);
  ref.root.hidden = false;
  paintSummary(ref, snap);
  return delta;
}

/** 面板隐藏（该会话还没见过 update_tasks）：只改 hidden，DOM 留着复用。 */
export function hidePanel(ref: TaskPanelRef): void {
  ref.root.hidden = true;
}

/** 语言切换后就地重画文案（不重建 DOM）。 */
export function relabelPanel(ref: TaskPanelRef, snap: TaskSnapshot | null): void {
  const title = ref.head.querySelector('.tp-title');
  if (title !== null) title.textContent = t('chat.tasks.title');
  ref.root.setAttribute('aria-label', t('chat.tasks.title'));
  if (snap === null) return;
  // 每一行的状态文案按**该行自己的状态**重取（只改 textContent，不碰节点）。
  for (const row of ref.rows) row.statusEl.textContent = t(statusKey(row.status));
  paintSummary(ref, snap);
}

