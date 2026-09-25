// ============================================================================
// ui/taskpanel/wire.ts — W1533 任务面板的**装配与接线**（唯一对外入口）。
// ----------------------------------------------------------------------------
//   installTaskPanel();               // 装配（一次）
//   mountTaskPanel(pane);             // 某个会话容器的面板就位（切会话/建容器）
//   noteTaskCall(paneId, name, args); // live：tool 帧（结果未到时先用 args 画）
//   noteTaskResult(paneId, name, v);  // live：tool_result 帧（权威清单）
//   noteTaskHistory(paneId, msg);     // 恢复：历史里的 tool 行
//
// 为什么自建一条 SSE 订阅而不是改 chat.ts：chat.ts 是**登记在案**的超大文件
// （棘轮只许降不许升），而本特性不该长在它身上 —— 与 ui/question/sse.ts、
// ui/workbench/terminal-pty.ts 同一条既有先例：总线本来就支持多订阅者，代价
// 明确且很小（多一条 EventSource，只监听 tool / tool_result 两个事件名）。
// 端点是既有的 GET /api/events —— **不新开端点、不新开轮询**。
//
// 位置：面板是该会话 .sess-pane 的**第一个子节点**（消息流之上、随会话切换）。
// 见 panel.ts 头注的四条理由。
//
// ★ 与历史恢复的协作（重要）：restoreSessionHistory 收尾会 `ctx.el.replaceChildren(...)`
//   —— 那会把面板节点一起换掉。所以本模块**订阅 onTasksChange 之后重新挂载**，
//   而不是假设「挂过一次就永远在」。remount 是 insertBefore 一次，成本可忽略；
//   面板句柄与 store 都不重建（列表 DOM 与折叠态原样保留）。
// ============================================================================

import type { HistoryMsg, ToolPayload, ToolResultPayload } from '../../types';
import { SseClient } from '../../sse';
import { adoptLocalIfUnbound, allPanes, onPaneChange, paneOf, type SessionPane } from '../viewctx';
import { onLocaleChange } from '../../i18n';
import { buildPanel, hidePanel, relabelPanel, renderPanel, setCollapsed, type TaskPanelRef } from './panel';
import { dropTasks, onTasksChange, pruneTasks, setTasks, tasksOf } from './store';
import { readTasks } from './model';

/** 容器 → 面板句柄（一个会话一块，切会话零重建）。 */
const panels = new Map<SessionPane, TaskPanelRef>();
/** 折叠偏好（本次会话内记忆；默认展开 —— 用户要看的就是清单）。 */
let collapsedDefault = false;
let installed = false;
let sse: SseClient | null = null;

/**
 * 把面板放到该容器的**最前面**（幂等）。消息容器可能在历史恢复时被
 * replaceChildren 换掉，所以这里每次都确认位置，而不是只在第一次做。
 */
function place(pane: SessionPane, ref: TaskPanelRef): void {
  if (ref.root.parentElement !== pane.el || pane.el.firstChild !== ref.root) {
    pane.el.insertBefore(ref.root, pane.el.firstChild);
  }
}

/** 让某个会话容器的面板就位（幂等；句柄与列表 DOM 复用）。 */
export function mountTaskPanel(pane: SessionPane): TaskPanelRef {
  const existing = panels.get(pane);
  if (existing !== undefined) {
    place(pane, existing);
    return existing;
  }
  const ref = buildPanel();
  setCollapsed(ref, collapsedDefault);
  ref.head.addEventListener('click', () => setCollapsed(ref, !ref.collapsed));
  place(pane, ref);
  panels.set(pane, ref);
  const snap = tasksOf(pane);
  if (snap === null) hidePanel(ref);
  else renderPanel(ref, snap);
  return ref;
}

/** 某个容器的面板句柄（未挂载 ⇒ undefined；诊断/测试用）。 */
export function taskPanelOf(pane: SessionPane): TaskPanelRef | undefined {
  return panels.get(pane);
}

/** 该容器此刻是否已挂上面板（诊断/测试用）。 */
export function panelMounted(pane: SessionPane): boolean {
  return panels.has(pane);
}

/** 会话被丢弃时把面板一并作废（容器已 remove，这里只清状态）。 */
export function dropTaskPanel(pane: SessionPane): void {
  panels.delete(pane);
  dropTasks(pane);
}

/**
 * 帧 → 会话容器：与 chat.ts 的 ctxFor 同一条路由规则（信封 session 优先，
 * 无 session 的旧服务回落到当前聚焦容器）。只认**已有/可认领**的容器，
 * 绝不因为一条帧就凭空造出会话容器（那是 chat.ts 的职责）。
 */
function paneForFrame(session: unknown): SessionPane | null {
  const id = typeof session === 'string' && session !== '' ? session : null;
  if (id === null) {
    const panes = allPanes();
    for (const p of panes) if (!p.el.hidden) return p;
    return panes[0] ?? null;
  }
  return paneOf(id) ?? adoptLocalIfUnbound(id) ?? null;
}

/** 写入 store 并把面板画出来（面板不在就只写 store，挂载时补画）。 */
function applyTasks(pane: SessionPane, tasks: ReturnType<typeof readTasks>): void {
  if (tasks === null) return;
  mountTaskPanel(pane);
  // store 是唯一写入点：它判定「逐行相同」时不通知订阅者，重放帧因此零重画。
  setTasks(pane, tasks);
}

/** live：一次 update_tasks 的**调用**帧（先用 args.tasks 画，不必等结果）。 */
export function noteTaskCall(pane: SessionPane, name: string, args: unknown): void {
  if (name !== 'update_tasks') return;
  applyTasks(pane, readTasks(args));
}

/** live：一次 update_tasks 的**结果**帧（权威清单：工具已规范化并计数）。 */
export function noteTaskResult(pane: SessionPane, name: string, value: unknown): void {
  if (name !== 'update_tasks') return;
  applyTasks(pane, readTasks(value));
}

/**
 * 恢复：历史里的一条 tool 行。
 *
 * ★ 结果行**不带 tool_name**（Studio 投影的 tool_result 行只有 tool_call_id +
 *   tool_value，见 packages/session/src/messages.ts），所以不能只按名字筛：
 *   这里记住「哪些 tool_call_id 是 update_tasks」，结果行靠它认领 —— 与 live 的
 *   nameById 是同一条思路，只是历史行的 id 来自行本身而不是 SSE 帧。
 *   权威值是**结果行**的 value（工具已规范化并 trim），调用行的 args 只在结果
 *   还没出现时先用着。
 */
export function noteTaskHistory(pane: SessionPane, msg: HistoryMsg): void {
  if (msg.role !== 'tool') return;
  const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
  if (msg.kind === 'call') {
    if (msg.tool_name !== 'update_tasks') return;
    if (id !== '') {
      histCallIds.add(id);
      // 有界：恢复一次最多渲染 MAX_RESTORE(200) 条，但同一次会话里可能反复恢复
      // （切会话 / compact）。不设上限就是一个随会话长度单调增长的 Set —— 与
      // nameById 同一条纪律（那里也按帧量级自然有界）。
      if (histCallIds.size > HIST_ID_CAP) histCallIds.delete(histCallIds.values().next().value as string);
    }
    applyTasks(pane, readTasks(msg.tool_args));
    return;
  }
  if (msg.kind !== 'result' || id === '' || !histCallIds.has(id)) return;
  applyTasks(pane, readTasks(msg.tool_value));
}

/** 历史里见过的 update_tasks 调用 id（结果行靠它认领；超出上限按插入序淘汰）。 */
const histCallIds = new Set<string>();
/** 上限：一次历史恢复最多 200 条，留 4 倍余量足够覆盖反复恢复。 */
const HIST_ID_CAP = 800;

/** 按 id 记住 tool 帧的名字（结果帧不带 name，靠它回查）。 */
const nameById = new Map<string, string>();

function onToolFrame(p: ToolPayload): void {
  const pane = paneForFrame(p.session);
  const name = String(p.name ?? '');
  if (pane === null || name === '') return;
  nameById.set(String(p.id), name);
  noteTaskCall(pane, name, p.args);
}

function onToolResultFrame(p: ToolResultPayload): void {
  const pane = paneForFrame(p.session);
  if (pane === null) return;
  const name = nameById.get(String(p.id)) ?? '';
  if (name === '') return; // 没见过的调用（刷新后重放）→ 交给历史恢复那条路
  noteTaskResult(pane, name, p.value);
}

/** 装配（幂等）：store 订阅 + 容器订阅 + SSE 订阅 + 已有容器补挂。 */
export function installTaskPanel(): void {
  if (installed) return;
  installed = true;
  onTasksChange((pane, snap) => {
    const ref = panels.get(pane);
    if (ref === undefined) return;
    // 历史恢复的 replaceChildren 可能把面板换掉了 → 先归位，再更新内容。
    place(pane, ref);
    if (snap === null) hidePanel(ref);
    else renderPanel(ref, snap);
  });
  onPaneChange((pane) => {
    pruneTasks();
    mountTaskPanel(pane);
  });
  onLocaleChange(() => {
    for (const [pane, ref] of panels) relabelPanel(ref, tasksOf(pane));
  });
  for (const pane of allPanes()) mountTaskPanel(pane);
  connectLive();
}

/**
 * 接上 live 帧源（幂等）。
 *
 * ★ 为什么必须容错：装配点是 initSessionBar，而 jsdom（本仓的 DOM 测试环境）与
 *   某些受限宿主**没有 EventSource** —— 让它抛出去会把整个装配点打断（实测：
 *   一次未捕获的 ReferenceError 会让 20 个既有 DOM 测试全红）。
 *   这里如实降级：live 帧不可用时面板仍由**历史恢复**那条路填满（刷新/切会话都会
 *   走到 restore-tool），只是少了「结果到达当帧」的即时性。绝不静默假装接上了。
 */
function connectLive(): void {
  if (typeof EventSource === 'undefined') {
    console.warn('[taskpanel] EventSource unavailable: the panel will fill from history only');
    return;
  }
  sse = new SseClient();
  sse.on('tool', (p) => {
    try {
      onToolFrame(p);
    } catch (err) {
      console.warn('SSE tool (taskpanel)', err);
    }
  });
  sse.on('tool_result', (p) => {
    try {
      onToolResultFrame(p);
    } catch (err) {
      console.warn('SSE tool_result (taskpanel)', err);
    }
  });
  sse.connect();
}

/** live 帧源是否已接上（诊断/测试用）。 */
export function liveConnected(): boolean {
  return sse !== null;
}

/** 帧源注入（测试用；null = 断开自建的那条）。 */
export function setTaskFrameSource(source: SseClient | null): void {
  if (sse !== null && source !== sse) sse.close();
  sse = source;
}

/** 折叠全部面板（用户偏好 / 测试用）。 */
export function setTasksCollapsed(collapsed: boolean): void {
  collapsedDefault = collapsed;
  for (const ref of panels.values()) setCollapsed(ref, collapsed);
}

/** 测试用：丢弃模块级句柄（不动 DOM）。 */
export function resetTaskPanelWiring(): void {
  panels.clear();
  nameById.clear();
  histCallIds.clear();
  installed = false;
  if (sse !== null) sse.close();
  sse = null;
}
