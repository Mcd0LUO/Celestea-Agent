// ============================================================================
// ui/viewctx.ts — W514 多会话视图容器（单一职责）：
//   每个会话（含 engine worker 会话）一个独立的滚动容器 .sess-pane，
//   切换 = hidden 属性切换（零重渲染）：各自的流/工具卡/思考段/滚动位/
//   输入草稿都留在自己的容器里，后台会话照常接收 SSE 增量但不影响当前视图。
//
//   本模块只负责「容器 + 激活 + 运行态 + 草稿 + 事件」，不渲染消息内容
//   （消息渲染在 ui/messages.ts，历史在 ui/restore.ts）。chrome（状态栏 /
//   statusline / 输入框 / 侧栏高亮 / rail）通过订阅 onPaneChange / onBusyChange
//   被动同步，避免任何「切换时重建 DOM」。
//
//   优雅降级：后端未返回 session/kind/busy 时，只有一个 LOCAL 容器
//   （id=''），行为与单会话现状一致——不空白、不报错。
// ============================================================================
import { S } from '../state';
import { el } from '../utils/dom';
import type { StatusSnapshot } from '../types';
import type { AssistantView, DedupState, ThinkSeg, ToolCardRef } from './view';

/** 未解析/无会话 id 时的占位容器（旧后端的单会话行为）。 */
export const LOCAL_ID = '';

/** 同时保留的视图容器上限（超出后淘汰最久未用的非运行中容器，重开时按历史恢复）。 */
export const MAX_PANES = 12;

export interface SessionPane {
  id: string;
  /** 'session' | 'worker' | ''（后端未提供 kind 时为空串） */
  kind: string;
  title: string;
  model?: string;
  workspace?: string;
  /** 滚动容器（.sess-pane；hidden 切换，DOM 永不重建） */
  el: HTMLElement;
  /** 空态提示（容器内首屏元素） */
  hint: HTMLElement;
  /** 当前流式文本段（null = 无进行中的段） */
  assistant: AssistantView | null;
  /** 当前思考段（每轮结束清除，DOM 保留） */
  thinkSeg: ThinkSeg | null;
  /** 同轮最近文本段（thinking 重排锚点） */
  lastTextCol: HTMLElement | null;
  /** 文本段节拍渲染定时器（每容器独立） */
  renderTimer: number | null;
  renderDeadline: number;
  /** 工具卡索引（tool_call_id → 卡片） */
  ops: Map<string, ToolCardRef>;
  /** 本轮工具步数 */
  step: number;
  turn: number | null;
  streaming: boolean;
  /** 本轮开始时刻（底部耗时计时，按容器保存） */
  t0: number;
  /** 最近一次阶段文案（切回时恢复状态栏文本） */
  phase: string;
  /** 输入草稿（切换会话时保存/恢复） */
  draft: string;
  /** 滚动位（隐藏时保存，显示时恢复） */
  scrollTop: number;
  /** 隐藏时是否贴底（贴底者切回后仍贴底） */
  stickBottom: boolean;
  /** 是否已从后端恢复过历史 */
  restored: boolean;
  /** 历史恢复的竞态序号（晚到的旧请求结果一律丢弃） */
  restoreSeq: number;
  /** live 增量与历史尾部的衔接去重状态 */
  dedup: DedupState;
  /** 历史恢复的工具步数/索引 */
  histToolStep: number;
  restoreOps: Map<string, ToolCardRef>;
  /** GET /api/status?session= 的最近快照（切回即时显示） */
  status: StatusSnapshot | null;
  /** 运行中插话的轻提示元素 */
  interjectNote: HTMLElement | null;
  /** LRU 时间戳 */
  usedAt: number;
}

type PaneChangeCb = (pane: SessionPane, prev: SessionPane | null) => void;
type BusyCb = (id: string, busy: boolean) => void;

const panes = new Map<string, SessionPane>();
const busyById = new Map<string, boolean>();
const changeCbs = new Set<PaneChangeCb>();
const busyCbs = new Set<BusyCb>();

let active: SessionPane | null = null;
let host: HTMLElement | null = null;
let initialized = false;

// ---- 空态（与 index.html 原始结构一致；每个容器自带一份） -------------------------

function buildEmptyHint(): HTMLElement {
  const hint = el('div', 'empty-hint');
  hint.appendChild(el('div', 'empty-mark', '◇'));
  hint.appendChild(el('div', 'empty-title', 'Celestea Studio'));
  hint.appendChild(
    el('div', 'empty-sub', '在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行'),
  );
  return hint;
}

/** 新建一个会话视图容器（离屏构建 → 单次挂载；不触碰其它容器）。 */
function buildPane(id: string, kind: string, title: string): SessionPane {
  const paneEl = el('div', 'sess-pane');
  paneEl.dataset.session = id;
  paneEl.tabIndex = -1;
  if (kind === 'worker') paneEl.classList.add('is-worker');
  const hint = buildEmptyHint();
  paneEl.appendChild(hint);
  return {
    id,
    kind,
    title,
    el: paneEl,
    hint,
    assistant: null,
    thinkSeg: null,
    lastTextCol: null,
    renderTimer: null,
    renderDeadline: 0,
    ops: new Map(),
    step: 0,
    turn: null,
    streaming: false,
    t0: 0,
    phase: '',
    draft: '',
    scrollTop: 0,
    stickBottom: true,
    restored: false,
    restoreSeq: 0,
    dedup: { tail: null, guardActive: false, guardBuf: '', guardAll: false },
    histToolStep: 0,
    restoreOps: new Map(),
    status: null,
    interjectNote: null,
    usedAt: Date.now(),
  };
}

// ---- 容器注册表 -----------------------------------------------------------------

export function paneOf(id: string): SessionPane | undefined {
  return panes.get(id);
}

export function allPanes(): SessionPane[] {
  return Array.from(panes.values());
}

/** 取容器（不存在则创建 + 挂载）。kind/title 为后端元数据（可缺失）。 */
export function ensurePane(id: string, kind?: string, title?: string): SessionPane {
  const found = panes.get(id);
  if (found) {
    if (kind) found.kind = kind;
    if (title) found.title = title;
    return found;
  }
  const pane = buildPane(id, kind ?? '', title ?? '');
  panes.set(id, pane);
  if (host) host.appendChild(pane.el);
  evictIfNeeded(pane);
  return pane;
}

/** 后端元数据回填（侧栏刷新时调用；只改字段，不动 DOM）。 */
export function setPaneMeta(
  id: string,
  meta: { kind?: string; title?: string; model?: string; workspace?: string },
): void {
  const pane = panes.get(id);
  if (!pane) return;
  if (meta.kind) pane.kind = meta.kind;
  if (meta.title) pane.title = meta.title;
  if (meta.model !== undefined) pane.model = meta.model;
  if (meta.workspace !== undefined) pane.workspace = meta.workspace;
}

/** 容器淘汰：超过上限时移除最久未用的非当前、非运行中容器（重开按历史恢复）。 */
function evictIfNeeded(keep: SessionPane): void {
  while (panes.size > MAX_PANES) {
    let victim: SessionPane | null = null;
    for (const p of panes.values()) {
      if (p === keep || p === active || p.streaming) continue;
      if (!victim || p.usedAt < victim.usedAt) victim = p;
    }
    if (!victim) return;
    victim.el.remove();
    panes.delete(victim.id);
  }
}

// ---- 激活 / 切换 ----------------------------------------------------------------

function readInputValue(): string {
  const input = document.querySelector<HTMLTextAreaElement>('#input');
  return input ? input.value : '';
}

function writeInputValue(v: string): void {
  const input = document.querySelector<HTMLTextAreaElement>('#input');
  if (!input) return;
  input.value = v;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 240) + 'px';
}

/**
 * 是否「贴底」：仅当真的在底部（4px 容差）才标记为贴底 —— 切回时贴底者
 * 继续贴底（跟随最新），否则原样恢复用户自己的滚动位置（滚动位保留）。
 */
function atBottom(paneEl: HTMLElement): boolean {
  return paneEl.scrollTop + paneEl.clientHeight >= paneEl.scrollHeight - 4;
}

/** 当前聚焦容器（init 前为 null）。 */
export function activePane(): SessionPane | null {
  return active;
}

/** 当前聚焦会话 id（未解析时为 LOCAL_ID=''）。 */
export function activeSessionId(): string {
  return active ? active.id : LOCAL_ID;
}

export function isActivePane(pane: SessionPane): boolean {
  return pane === active;
}

/**
 * 激活（或新建）会话视图：
 *   1) 保存旧容器的滚动位与输入草稿（DOM 完全不动，仅写 hidden）；
 *   2) 显示目标容器（hidden 切换 = 零重渲染：流/工具卡/滚动位都在）；
 *   3) 恢复目标容器的滚动位与草稿；
 *   4) 广播 onPaneChange（rail / statusline / 状态栏 / 输入框 / 侧栏被动同步）。
 */
export function activatePane(id: string, kind?: string, title?: string): SessionPane {
  const pane = ensurePane(id, kind, title);
  const prev = active;
  if (prev === pane) return pane;

  if (prev) {
    prev.draft = readInputValue();
    prev.scrollTop = prev.el.scrollTop;
    prev.stickBottom = atBottom(prev.el);
    prev.el.hidden = true;
    prev.el.classList.remove('is-active');
  }
  active = pane;
  pane.usedAt = Date.now();
  pane.el.hidden = false;
  pane.el.classList.add('is-active');
  const target = pane.stickBottom ? pane.el.scrollHeight : pane.scrollTop;
  pane.el.scrollTop = target;
  requestAnimationFrame(() => {
    if (active === pane) pane.el.scrollTop = target;
  });
  writeInputValue(pane.draft);

  // S 镜像：S 表达「当前聚焦容器」的状态（statusline/状态栏/发送路径共用）
  S.turn = pane.turn;
  S.streaming = pane.streaming;
  S.assistant = pane.assistant;
  S.t0 = pane.t0;
  S.selSession = pane.id === LOCAL_ID ? null : pane.id;

  for (const cb of changeCbs) {
    try {
      cb(pane, prev);
    } catch (err) {
      console.warn('[viewctx] pane change listener failed', err);
    }
  }
  return pane;
}

/**
 * 把 LOCAL 容器「认领」为真实会话 id（启动恢复活跃会话时调用）：
 *   - 真实容器已存在 → 切到它并丢弃尚未使用的 LOCAL 容器；
 *   - 否则就地改名（容器对象不变 → rail 等 WeakMap 状态与已渲染 DOM 全部保留）。
 */
export function adoptPane(id: string): SessionPane {
  if (id === LOCAL_ID) return activatePane(LOCAL_ID);
  const existing = panes.get(id);
  if (existing) {
    const local = panes.get(LOCAL_ID);
    if (local && local !== existing) {
      const empty = local.el.querySelector('.mcol') === null;
      if (empty && local.dedup.tail === null) panes.delete(LOCAL_ID);
      if (local.el.isConnected) local.el.remove();
    }
    return activatePane(id);
  }
  const local = panes.get(LOCAL_ID);
  if (!local) return activatePane(id);
  panes.delete(LOCAL_ID);
  local.id = id;
  local.el.dataset.session = id;
  panes.set(id, local);
  if (active === local) {
    S.selSession = id;
    for (const cb of changeCbs) {
      try {
        cb(local, null);
      } catch {
        /* ignore listener errors */
      }
    }
  }
  return local;
}

/**
 * 旧后端兼容（W514）：SSE 首次带来 session id 时，把「已经有内容/正在跑」的
 * LOCAL 容器就地认领为该会话 —— 避免同一轮的增量被拆到两个容器里。
 * 无 LOCAL 活动 → 返回 null（调用方按 id 新建容器）。
 */
export function adoptLocalIfUnbound(id: string): SessionPane | null {
  if (id === LOCAL_ID) return panes.get(LOCAL_ID) ?? null;
  const existing = panes.get(id);
  if (existing) return existing;
  const local = panes.get(LOCAL_ID);
  if (!local) return null;
  const hasActivity = local.streaming || local.el.querySelector('.mcol') !== null;
  if (!hasActivity) return null;
  return adoptPane(id);
}

// ---- 运行态（busy） --------------------------------------------------------------

/** 该会话是否有轮次在跑（本地 turn 或后端 busy 字段）。 */
export function paneBusy(id: string): boolean {
  return busyById.get(id) === true;
}

export function busyIds(): string[] {
  return Array.from(busyById.entries())
    .filter(([, b]) => b)
    .map(([id]) => id);
}

function emitBusy(id: string, busy: boolean): void {
  for (const cb of busyCbs) {
    try {
      cb(id, busy);
    } catch (err) {
      console.warn('[viewctx] busy listener failed', err);
    }
  }
}

export function setBusy(id: string, busy: boolean): void {
  if ((busyById.get(id) === true) === busy) return;
  busyById.set(id, busy);
  emitBusy(id, busy);
}

/** 本地 turn 生命周期 / SSE 驱动的运行态（真源）。 */
export function setPaneStreaming(pane: SessionPane, on: boolean): void {
  pane.streaming = on;
  if (on) pane.usedAt = Date.now();
  setBusy(pane.id === LOCAL_ID ? LOCAL_ID : pane.id, on);
  if (pane === active) S.streaming = on;
}

/**
 * 后端 /api/sessions 的 busy 字段（多会话状态显示）：
 * 只做「补充」——本地正在跑的会话不被远端旧值熄火。
 */
export function setRemoteBusy(id: string, busy: boolean): void {
  if (!busy) {
    const pane = panes.get(id);
    if (pane?.streaming) return;
  }
  setBusy(id, busy);
}

// ---- 订阅 ----------------------------------------------------------------------

export function onPaneChange(cb: PaneChangeCb): void {
  changeCbs.add(cb);
}

export function onBusyChange(cb: BusyCb): void {
  busyCbs.add(cb);
  for (const [id, busy] of busyById) {
    if (busy) cb(id, true);
  }
}

// ---- 生命周期 ------------------------------------------------------------------

/** 装配（幂等）：宿主 #messages 内建 LOCAL 容器 + 草稿实时保存。 */
export function initViewCtx(): SessionPane {
  if (initialized && active) return active;
  host = document.getElementById('messages');
  if (!host) throw new Error('missing element: #messages');
  initialized = true;
  const pane = activatePane(LOCAL_ID);
  const input = document.querySelector<HTMLTextAreaElement>('#input');
  if (input) {
    input.addEventListener('input', () => {
      if (active) active.draft = input.value;
    });
  }
  return pane;
}
