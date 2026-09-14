// ============================================================================
// ui/sessions/util.ts — 会话树的纯读取/派生（W748 从 ui/sessions.ts 拆出）。
//   只做搬家：判定/排序/命名的语义与拆分前逐字一致。
// ============================================================================
import type { SessionInfo } from '../../types';
import { paneBusy } from '../viewctx';
import { getSearchQuery, getSortMode } from './store';

/**
 * W515：谱系父会话 id（对齐 DSH 的 parentSessionId）。
 * 兼容 parent / parentSessionId / parent_session 三种写法；缺失 → null（平坦展示）。
 */
export function parentOf(s: SessionInfo): string | null {
  const v = s.parentSessionId ?? s.parent_session ?? s.parent;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** W514：worker 会话只出现在 Worker 组，不再重复列进工作区树。 */
export function isWorkerSession(s: SessionInfo): boolean {
  return s.kind === 'worker' || (s.id ?? '').startsWith('worker:');
}

export function wsNameOf(s: SessionInfo): string {
  const ws = (s.workspace ?? '').trim();
  return ws === '' ? 'root' : ws;
}

export function truncateName(id: string): string {
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

export function matchesQuery(text: string): boolean {
  const q = getSearchQuery();
  return q === '' || text.toLowerCase().includes(q);
}

export function sortSessions(list: SessionInfo[]): SessionInfo[] {
  const arr = [...list];
  if (getSortMode() === 'name') {
    arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
    return arr;
  }
  // 最近活跃：modified 降序，无 modified 排后
  arr.sort((a, b) => {
    const am = typeof a.modified === 'number' ? a.modified : -1;
    const bm = typeof b.modified === 'number' ? b.modified : -1;
    return bm - am;
  });
  return arr;
}

export function workerSessions(list: SessionInfo[]): SessionInfo[] {
  return list.filter((s) => s.kind === 'worker' || (s.id ?? '').startsWith('worker:'));
}

/** wid：标题前缀「W514·短名」优先，否则取 id 末段。 */
export function widOf(w: SessionInfo): string {
  const t = (w.title ?? '').trim();
  const m = /^(W\d+)/.exec(t);
  if (m && m[1]) return m[1];
  const id = w.id ?? '';
  const i = id.lastIndexOf('/');
  return i >= 0 ? id.slice(i + 1) : id;
}

/** 标题：去掉「W514·」前缀后的短名（与 wid 标签分列显示）。 */
export function workerTitleOf(w: SessionInfo): string {
  const t = (w.title ?? '').trim();
  const stripped = t.replace(/^W\d+\s*[·:：-]\s*/, '');
  return stripped || truncateName(w.id ?? '') || (w.id ?? '');
}

/** Worker 组内容签名：不变则不重建（铁律 6：轮询只做局部更新）。 */
export function workerSigOf(workers: SessionInfo[]): string {
  return workers
    .map((w) =>
      [
        w.id ?? '',
        w.title ?? '',
        w.model ?? '',
        paneBusy(w.id ?? '') ? '1' : '0',
        String(w.events ?? ''),
        parentOf(w) ?? '',
      ].join('\u0001'),
    )
    .join('\u0002');
}
