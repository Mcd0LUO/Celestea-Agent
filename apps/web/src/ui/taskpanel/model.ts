// ============================================================================
// ui/taskpanel/model.ts — W1533 任务面板的**纯数据层**（零 DOM，可直测）。
// ----------------------------------------------------------------------------
// 数据来源只有一个：模型调 `update_tasks` 之后落进会话日志的那两行
//   · tool_call   → args.tasks      （结果未到时先用它画，保证「当帧可见」）
//   · tool_result → value.tasks     （权威：规范化 + 计数后的清单）
// 不新开端点、不新开轮询：live 走 SSE 的 tool_result 帧，刷新/切会话走历史恢复
// 的同一条 tool 行（两者字段同名，见 packages/session/src/messages.ts）。
//
// 为什么 REPLACE：工具语义就是「传全量」。增量 patch 会让两个并发更新各改一半，
// 合出来的清单谁都没想要；全量则幂等、顺序明确、前端只需一次 diff。
// ============================================================================

/** 任务状态（与工具契约 TASK_STATUSES 逐字一致）。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** 一条任务（展示只需要这两个字段）。 */
export interface TaskItem {
  content: string;
  status: TaskStatus;
}

/** 三态计数（工具结果里的 counts，camelCase 与线格式一致）。 */
export interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/** 面板渲染需要的一份完整快照。 */
export interface TaskSnapshot {
  tasks: TaskItem[];
  counts: TaskCounts;
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];

/** 字符串是否是三个冻结状态之一（未知值一律不认，绝不猜成 pending）。 */
export function isStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && STATUSES.includes(v);
}

/**
 * 从**任意**来源（工具结果 value / 工具参数 args）里读出任务清单。
 * 形状不对 ⇒ 返回 null（调用方据此保持现状，绝不画半截列表）。
 *
 * 为什么容错读而不抛：这段代码跑在渲染路径上，一条坏帧不能让整轮 UI 崩掉；
 * 工具侧已经 fail-closed（update_tasks: code=... ），到这里的数据已经是干净的，
 * 这里只是防御旧服务/未来字段漂移。
 */
export function readTasks(source: unknown): TaskItem[] | null {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null;
  const raw = (source as { tasks?: unknown }).tasks;
  if (!Array.isArray(raw)) return null;
  const out: TaskItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const rec = item as { content?: unknown; status?: unknown };
    if (typeof rec.content !== 'string' || !isStatus(rec.status)) return null;
    out.push({ content: rec.content, status: rec.status });
  }
  return out;
}

/** 三态计数（前端自己算，不依赖服务端 counts —— 旧帧可能没有这个字段）。 */
export function countOf(tasks: readonly TaskItem[]): TaskCounts {
  const counts: TaskCounts = { pending: 0, inProgress: 0, completed: 0 };
  for (const task of tasks) {
    if (task.status === 'pending') counts.pending += 1;
    else if (task.status === 'in_progress') counts.inProgress += 1;
    else counts.completed += 1;
  }
  return counts;
}

/** 由清单构造快照（counts 一律现算，服务端那份只作对照）。 */
export function snapshotOf(tasks: readonly TaskItem[]): TaskSnapshot {
  return { tasks: [...tasks], counts: countOf(tasks) };
}

/**
 * 行的**身份键**：内容本身。
 *
 * 为什么不用下标：模型重发全量清单时可能插入/删除一行，下标一变整列都会「变」，
 * 局部更新就退化成整表重建。内容相同的行视为同一行（这也正是用户看到的：
 * 「写工具」那一条从 pending 变成 completed，而不是消失又出现）。
 * 重复内容（同一句话两条任务）用出现次序消歧，保证键唯一。
 */
export function rowKeys(tasks: readonly TaskItem[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((task) => {
    const n = (seen.get(task.content) ?? 0) + 1;
    seen.set(task.content, n);
    return task.content + '\u0000' + String(n);
  });
}

/** 一份清单里是否**每一行**都与旧清单逐字段相同（同序同内容同状态）。 */
export function sameTasks(a: readonly TaskItem[], b: readonly TaskItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.content !== y.content || x.status !== y.status) return false;
  }
  return true;
}

/**
 * 新旧清单的**结构差异**（局部更新的判据）：
 *   'same'   逐行相同 → 什么都不用做；
 *   'inplace' 行数与身份键序列完全一致，只有 content/status 变了 → 只改变化的行；
 *   'rebuild' 行集合或顺序变了 → 离屏构建 + 单次替换（铁律 1）。
 */
export type TaskDelta = 'same' | 'inplace' | 'rebuild';

export function deltaOf(prev: readonly TaskItem[], next: readonly TaskItem[]): TaskDelta {
  if (sameTasks(prev, next)) return 'same';
  const a = rowKeys(prev);
  const b = rowKeys(next);
  if (a.length !== b.length) return 'rebuild';
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 'rebuild';
  return 'inplace';
}

/** 发生变化的行下标（inplace 时用；顺序即下标顺序）。 */
export function changedIndexes(prev: readonly TaskItem[], next: readonly TaskItem[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) {
    const x = prev[i];
    const y = next[i];
    if (x === undefined || y === undefined || x.content !== y.content || x.status !== y.status) out.push(i);
  }
  return out;
}

/**
 * 面板的**空态/全完成态**判据（文案由调用方按语言取）。
 *   'empty'  没有任务（含清单被清空）；
 *   'allDone' 至少一条且全部 completed；
 *   'list'   其余（含只有 pending 的情形）。
 */
export type PanelState = 'empty' | 'allDone' | 'list';

export function panelStateOf(tasks: readonly TaskItem[]): PanelState {
  if (tasks.length === 0) return 'empty';
  for (const task of tasks) if (task.status !== 'completed') return 'list';
  return 'allDone';
}
