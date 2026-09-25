// ============================================================================
// ui/taskpanel/store.ts — W1533 任务面板的**每会话状态层**（零 DOM、零请求）。
// ----------------------------------------------------------------------------
// 一份清单属于一个**会话视图容器**（SessionPane 对象），不是全局：切到别的会话就
// 该看到那个会话的清单。
//
// ★ 为什么键是**容器对象**而不是会话 id 字符串：`viewctx.adoptPane` 会把 LOCAL
//   容器**就地改名**（`local.id = id`，对象不变）。用字符串做键时，认领那一刻键就
//   与容器脱钩，清单会挂在旧 id 上再也画不出来。容器对象在认领/切会话/重建 DOM
//   的全过程中身份不变，用它做键天然免疫这一类改名 bug。
//
// 状态只由两条路写进来（都在 ./wire.ts）：
//   · live  —— SSE 的 tool_result 帧（update_tasks 的结果）；
//   · 恢复  —— 历史恢复时同一条 tool 行。
// 没有轮询、没有端点：清单是「已经发生过的事实」，不是需要反复问服务端的状态。
// ============================================================================

import type { SessionPane } from '../viewctx';
import { allPanes } from '../viewctx';
import { deltaOf, readTasks, sameTasks, snapshotOf, type TaskDelta, type TaskItem, type TaskSnapshot } from './model';

/** 容器 → 清单（null 值不存：没有条目就是「还没见过 update_tasks」）。 */
const byPane = new Map<SessionPane, TaskSnapshot>();
/** 订阅者（渲染层）：状态变了就重画，自己决定局部还是重建。 */
const listeners = new Set<(pane: SessionPane, snap: TaskSnapshot | null) => void>();

/** 订阅（返回取消订阅）。 */
export function onTasksChange(cb: (pane: SessionPane, snap: TaskSnapshot | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 该会话容器的清单快照（null = 没有）。 */
export function tasksOf(pane: SessionPane): TaskSnapshot | null {
  return byPane.get(pane) ?? null;
}

/** 有清单的容器数（诊断/测试用）。 */
export function taskPaneCount(): number {
  return byPane.size;
}

/**
 * 丢掉**已经不在视图容器表里**的条目。
 * 容器被淘汰（evictIfNeeded）或会话被删除（dropPane）后，它的清单没有意义；
 * Map 持有强引用，不清理就会让被淘汰的容器永远无法回收（长会话下的堆泄漏）。
 * 每次容器变化/写入时跑一次，表最多 12 项，成本可忽略。
 */
export function pruneTasks(): number {
  const live = new Set(allPanes());
  let dropped = 0;
  for (const pane of [...byPane.keys()]) {
    if (live.has(pane)) continue;
    byPane.delete(pane);
    dropped += 1;
  }
  return dropped;
}

function emit(pane: SessionPane, snap: TaskSnapshot | null): void {
  for (const cb of [...listeners]) {
    try {
      cb(pane, snap);
    } catch (err) {
      console.warn('[taskpanel] listener failed', err);
    }
  }
}

/**
 * 写入一份清单（REPLACE 语义：传进来的是**全量**，不是补丁）。
 *
 * 返回本次的**结构差异**，渲染层据此选局部更新还是离屏重建（铁律 1/2）。
 * 与当前快照逐行相同 ⇒ 'same' 且**不通知订阅者** —— 重放的同一帧不该引起任何重画。
 */
export function setTasks(pane: SessionPane, tasks: readonly TaskItem[]): TaskDelta {
  const prev = byPane.get(pane)?.tasks ?? [];
  const delta = deltaOf(prev, tasks);
  if (delta === 'same') return 'same';
  byPane.set(pane, snapshotOf(tasks));
  emit(pane, byPane.get(pane) ?? null);
  return delta;
}

/**
 * 从一条工具结果/工具参数的原始载荷里收下清单。
 * 形状不对（不是 update_tasks / 没有 tasks）⇒ 什么都不做，返回 false。
 */
export function noteTasksFrom(pane: SessionPane, payload: unknown): boolean {
  const tasks = readTasks(payload);
  if (tasks === null) return false;
  setTasks(pane, tasks);
  return true;
}

/** 清空一个容器的清单（会话被删除/容器被淘汰时调用）。 */
export function dropTasks(pane: SessionPane): void {
  if (!byPane.delete(pane)) return;
  emit(pane, null);
}

/** 全部清空（测试/诊断）。 */
export function resetTasks(): void {
  const panes = [...byPane.keys()];
  byPane.clear();
  for (const pane of panes) emit(pane, null);
}

/** 该容器此刻是否已经有清单（面板据此决定显隐，避免空态闪一下）。 */
export function hasTasks(pane: SessionPane): boolean {
  return byPane.has(pane);
}

/** 清单是否与给定的一份逐行相同（恢复路径的幂等判据，诊断用）。 */
export function isSameAs(pane: SessionPane, tasks: readonly TaskItem[]): boolean {
  return sameTasks(byPane.get(pane)?.tasks ?? [], tasks);
}
