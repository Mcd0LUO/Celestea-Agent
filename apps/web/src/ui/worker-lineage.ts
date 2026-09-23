// ============================================================================
// ui/worker-lineage.ts — W1471：聚焦会话的**谱系事实**（只读派生，不碰 DOM）。
//
// 用户报障：「这个返回主 leader 的按钮在哪呢？」—— 从会话页左上角的 worker 快捷条
// 点进 worker 会话之后，**没有任何回程入口**。本模块提供那条入口需要的**唯一事实**：
// 「我现在看的这个 worker，是哪个会话派出来的、那个会话还在不在」。
//
// 为什么单独一个模块（而不是塞进 sessionbar.ts 或 worker-strip.ts）：
//   · 事实的来源是 GET /api/sessions 的列表行（worker 行的 parentSessionId / parent /
//     parent_session，兼容写法收在 sessiontree/util.parentOf 一处）；
//   · 列表真源由 worker-strip 的 updateWorkerStrip 每次对账时喂进来（noteSessionList），
//     会话条只**读**它 —— 两个 chrome 模块之间不产生 import 边，也没有先后依赖；
//   · 判定是纯函数（lineageOf），jsdom 可直接断言，不必造 DOM。
//
// 诚实降级（简报硬要求：诚实降级 > 静默放行）：
//   · 行**未知**（列表里还没有这个 worker 的行，例如刚 spawn 完尚未对账）→ 返回 null，
//     调用方**什么都不画**。不知道就说不知道，绝不猜成「没有父会话」；
//   · 有父会话字段、但父行不在列表里 → state='gone'：调用方如实说明「父会话已不在」，
//     而不是画一个点了没反应的死按钮；
//   · 没有父会话字段 → state='unlinked'：沿用侧栏既有口径 shell.worker.unlinked。
// ============================================================================
import type { SessionInfo } from '../types';
import { parentOf, truncateName } from './sessiontree/util';

/**
 * 谱系状态：
 *   · ok       —— 父会话就在列表里，入口可点；
 *   · gone     —— 行上有父会话 id，但它已不在列表里（没有可返回的目标）；
 *   · unlinked —— 行上没有父会话字段（后端没给 / 旧后端）。
 */
export type LineageState = 'ok' | 'gone' | 'unlinked';

/** 一条可渲染的谱系（state='ok' 时 id 才是可点的目标）。 */
export interface LineageLink {
  /** 父会话 id；state='unlinked' 时为空串（无目标）。 */
  id: string;
  /** 父会话短名（仅用于展示；'unlinked' 时为空串）。 */
  title: string;
  state: LineageState;
}

/** 最近一次会话列表真值（由 worker-strip 对账时喂入；零额外请求）。 */
let list: SessionInfo[] = [];

/** 喂入列表真值（worker-strip.updateWorkerStrip 的唯一调用点）。 */
export function noteSessionList(sessions: SessionInfo[]): void {
  list = sessions;
}

/** 测试/热重载用：丢弃缓存（不动 DOM）。 */
export function resetWorkerLineage(): void {
  list = [];
}

/**
 * 聚焦容器 → 它属于谁。
 *   非 worker 容器（普通会话 / 未解析的 LOCAL）→ null：普通会话页不新增任何 chrome。
 */
export function lineageOf(pane: { id: string; kind: string } | null): LineageLink | null {
  if (pane === null || pane.kind !== 'worker') return null;
  const row = list.find((s) => (s.id ?? '') === pane.id);
  // 行未知：不猜（见文件头的诚实降级）。下一次对账到达后自然出现入口。
  if (row === undefined) return null;
  const parent = parentOf(row);
  if (parent === null || parent === pane.id) return { id: '', title: '', state: 'unlinked' };
  const host = list.find((s) => (s.id ?? '') === parent);
  if (host === undefined) return { id: parent, title: truncateName(parent), state: 'gone' };
  const title = (host.title ?? '').trim();
  return { id: parent, title: title === '' ? truncateName(parent) : title, state: 'ok' };
}
