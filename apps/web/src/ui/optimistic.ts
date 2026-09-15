// ============================================================================
// ui/optimistic.ts — 列表行的**乐观移除 + 回滚**（W792）。
//   删除/归档的交互口径：用户一确认，该行**立即**从界面消失（不做「删除中…」占位、
//   不阻塞），请求在后台发；**失败才把行插回原位**并说明原因。
//   本模块只碰 DOM（零网络、零状态存储）：调用方负责发请求与文案，
//   会话树/归档面板两处共用同一份「移除—回滚」实现。
//
//   行定位口径：`<rowSel>[data-id="<id>"]`；顺带把所属分组的计数徽标与（可选的）
//   顶层计数一起增减，避免「行没了、数字还挂着」。
// ============================================================================

/** 分组容器 → 计数徽标选择器（会话树 / 归档面板）。 */
const GROUP_COUNT: ReadonlyArray<readonly [string, string]> = [
  ['.ws-details', '.ws-count'],
  ['.arc-ws', '.arc-ws-count'],
];

/** data-id 属性选择器（id 里可能有引号/反斜杠，先转义）。 */
function attrSel(id: string): string {
  return '[data-id="' + id.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
}

/** 数字文本 ±delta；非数字（`—` / `…`）原样不动。 */
function bumpText(node: Element | null, delta: number): void {
  if (!node) return;
  const n = Number.parseInt(node.textContent ?? '', 10);
  if (!Number.isFinite(n)) return;
  node.textContent = String(Math.max(0, n + delta));
}

function bumpGroupCounts(row: Element, delta: number): void {
  for (const [groupSel, countSel] of GROUP_COUNT) {
    const group = row.closest(groupSel);
    if (group) bumpText(group.querySelector(countSel), delta);
  }
}

/** 回滚句柄：把行插回原位置、计数补回。 */
export interface RowUndo {
  restore(): void;
}

/** 乐观移除的入参。 */
export interface OptimisticRowOpts {
  /** 行所在容器（会话树的容器 / 归档面板容器）。 */
  container: HTMLElement;
  /** 目标行 id（`data-id` 的值）。 */
  id: string;
  /** 行选择器：会话树 `.sess-leaf`、归档面板 `.arc-row`。 */
  rowSel: string;
  /** 顶层计数元素（归档面板传 #settingsArchiveCount；不需要就省略）。 */
  countEl?: HTMLElement | null;
}

/**
 * 立即把一行从界面移除；返回**回滚句柄**（行不在场时返回 null）。
 *   回滚把行插回**原位置**（锚点已失效时退化为追加），并把计数补回。
 */
export function removeRowOptimistic(opts: OptimisticRowOpts): RowUndo | null {
  const row = opts.container.querySelector(opts.rowSel + attrSel(opts.id));
  if (!row) return null;
  const parent = row.parentElement;
  if (!parent) return null;
  const anchor = row.nextElementSibling;
  bumpGroupCounts(row, -1);
  bumpText(opts.countEl ?? null, -1);
  row.remove();

  let live = true;
  return {
    restore(): void {
      if (!live) return;
      live = false;
      const at = anchor && anchor.parentElement === parent ? anchor : null;
      parent.insertBefore(row, at);
      bumpGroupCounts(row, 1);
      bumpText(opts.countEl ?? null, 1);
    },
  };
}
