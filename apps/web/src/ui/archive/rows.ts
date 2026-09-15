// ============================================================================
// ui/archive/rows.ts — 「归档会话管理」的**纯派生逻辑**（W786）：
//   过滤 / 排序 / 按工作区分组 / 标题与计数文案 / 二次确认措辞。
//   零 DOM、零网络、零模块级状态 ⇒ 可在 node（vitest）里直接跑真实生产代码。
//
//   语义（已核实）：归档 = 会话目录被移到 `<ws>/.celestea-archived/<name>`，
//   id 稳定且**可恢复**；恢复 = 把该行重新列回会话列表；永久删除走批量删除端点。
//   `GET /api/sessions` 的每一行带 `archived` 布尔位（types.ts 的 SessionInfo）。
// ============================================================================
import type { SessionInfo } from '../../types';

export interface ArchiveGroup {
  /** 工作区名；工作区为空的行归入 root（与侧栏同一口径）。 */
  workspace: string;
  rows: SessionInfo[];
}

/** id 末段（`ws/name` → `name`）。 */
export function tailOf(id: string | undefined | null): string {
  const v = (id ?? '').trim();
  if (v === '') return '';
  const i = v.lastIndexOf('/');
  return i >= 0 ? v.slice(i + 1) : v;
}

/** 行标题：标题优先，缺失回退 id 末段（与侧栏命名口径一致）。 */
export function rowLabel(s: SessionInfo): string {
  const t = (s.title ?? '').trim();
  return t !== '' ? t : tailOf(s.id);
}

/** 行所属工作区；空工作区 → root。 */
export function workspaceOf(s: SessionInfo): string {
  const ws = (s.workspace ?? '').trim();
  return ws === '' ? 'root' : ws;
}

/** 最近活跃：modified 降序（缺失排后），同值按标题升序稳定收敛。 */
function byRecency(a: SessionInfo, b: SessionInfo): number {
  const am = typeof a.modified === 'number' ? a.modified : -1;
  const bm = typeof b.modified === 'number' ? b.modified : -1;
  if (bm !== am) return bm - am;
  return rowLabel(a).localeCompare(rowLabel(b), 'zh');
}

/** 归档行：只保留 `archived === true` 的行（未归档/字段缺失一律排除）。 */
export function archivedRows(sessions: readonly SessionInfo[] | undefined | null): SessionInfo[] {
  const arr = Array.isArray(sessions) ? sessions : [];
  return arr.filter((s) => s.archived === true).sort(byRecency);
}

/** 按工作区分组：组名升序，组内沿用最近活跃序。 */
export function groupArchived(rows: readonly SessionInfo[]): ArchiveGroup[] {
  const map = new Map<string, SessionInfo[]>();
  for (const s of rows) {
    const key = workspaceOf(s);
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return [...map.entries()]
    .map(([workspace, list]) => ({ workspace, rows: list }))
    .sort((a, b) => a.workspace.localeCompare(b.workspace, 'zh'));
}

/** 计数文案：0 个归档 = `—`（不留「0」噪音）；其余为纯数字（与其它 pane 同款）。 */
export function archiveCountText(n: number): string {
  return n > 0 ? String(n) : '—';
}

/** 空态判定：没有任何归档会话。 */
export function isEmptyArchive(rows: readonly SessionInfo[]): boolean {
  return rows.length === 0;
}

/** 空态文案（无归档会话时）。 */
export function archiveEmptyText(): string {
  return '暂无归档会话';
}

/** 恢复二次确认正文。 */
export function restoreConfirmText(label: string): string {
  return '将「' + label + '」恢复到会话列表？';
}

/** 删除二次确认正文（沿用既有删除措辞：可从回收目录恢复）。 */
export function archiveDeleteConfirmText(label: string): string {
  return '将删除归档会话「' + label + '」。删除后可在回收目录恢复，确认？';
}
