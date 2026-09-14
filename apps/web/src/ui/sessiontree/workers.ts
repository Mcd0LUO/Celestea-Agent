// ============================================================================
// ui/sessions/workers.ts — 引擎 Worker 组（W239/W514/W515）
//   （W748 从 ui/sessions.ts 拆出；纯搬运，DOM/类名/文案/签名语义逐字未改。）
//   铁律 6：5s 轮询只做局部更新 —— 内容签名不变则只切运行态点，不重建组。
// ============================================================================
import { api } from '../../api';
import type { SessionInfo } from '../../types';
import { el } from '../../utils/dom';
import { openSessionRow } from './actions';
import { updateBusyDots } from './live';
import {
  getSessions,
  getWorkerSig,
  getWorkerTimer,
  setWorkerSig,
  setWorkerTimer,
  WORKER_POLL_MS,
} from './store';
import { parentOf, truncateName, widOf, workerSessions, workerSigOf, workerTitleOf } from './util';
import { paneBusy, activeSessionId } from '../viewctx';

/** 渲染一条 Worker 行（child=true 时缩进到父会话之下）。每行：运行态点 · wid · 标题 · 状态 · 模型。 */
function renderWorkerRow(host: HTMLElement, w: SessionInfo, child: boolean): HTMLElement {
  const id = w.id ?? '';
  const busy = paneBusy(id);
  const row = el('div', 'ws-worker-row' + (child ? ' child' : '') + (activeSessionId() === id ? ' active' : ''));
  row.dataset.id = id;
  row.appendChild(el('span', 'sess-dot' + (busy ? ' busy' : '')));
  row.appendChild(el('span', 'ws-worker-wid', widOf(w)));
  row.appendChild(el('span', 'ws-worker-title', workerTitleOf(w)));
  const st = el('span', 'ws-worker-state' + (busy ? ' busy' : ''), busy ? '运行中' : '空闲');
  row.appendChild(st);
  const bits: string[] = [];
  if (w.model) bits.push(String(w.model));
  if (w.events !== undefined) bits.push(w.events + ' 次事件');
  if (bits.length) row.appendChild(el('span', 'ws-worker-meta', bits.join(' · ')));
  row.title = workerTitleOf(w) + (w.model ? ' · ' + w.model : '') + '（点击打开该 worker 会话视图：只读）';
  row.addEventListener('click', () => {
    const hostEl = document.getElementById('sessionTree') ?? host;
    openSessionRow(hostEl, id, { kind: 'worker', title: w.title || id });
  });
  return row;
}

/**
 * 渲染 Worker 组（可展开 details）。
 * W515 谱系：后端给出 parentSessionId（含 parent/parent_session 兼容）时，
 * 按「父会话 → 其 worker 子行（缩进）」展示；父会话行可点击打开该父会话视图。
 * 无任何 parent 字段（旧后端）→ 与现状一致的平坦列表（降级）。
 */
export function renderWorkerGroup(host: HTMLElement, workers: SessionInfo[], open: boolean): void {
  const det = document.createElement('details');
  det.className = 'ws-worker-details';
  det.open = open;
  const sum = document.createElement('summary');
  sum.className = 'ws-worker-summary';
  sum.appendChild(el('span', null, '后台任务'));
  sum.appendChild(el('span', 'ws-worker-count', String(workers.length)));
  det.appendChild(sum);

  const byParent = new Map<string, SessionInfo[]>();
  const orphans: SessionInfo[] = [];
  for (const w of workers) {
    const p = parentOf(w);
    if (!p) {
      orphans.push(w);
      continue;
    }
    const list = byParent.get(p);
    if (list) list.push(w);
    else byParent.set(p, [w]);
  }
  // 父会话顺序 = 会话列表顺序（稳定）；未关联的 worker 排在最后
  const ordered = new Set<string>();
  for (const s of getSessions()) {
    const id = s.id ?? '';
    if (id && byParent.has(id)) ordered.add(id);
  }
  for (const p of byParent.keys()) ordered.add(p);

  if (ordered.size === 0) {
    for (const w of orphans) det.appendChild(renderWorkerRow(host, w, false));
  } else {
    for (const parentId of ordered) {
      const kids = byParent.get(parentId) ?? [];
      const parentSession = getSessions().find((s) => s.id === parentId);
      const head = el('div', 'ws-worker-parent');
      head.appendChild(el('span', 'ws-lineage-mark', '└'));
      const pname = el('span', 'ws-worker-parent-name', parentSession?.title || truncateName(parentId));
      head.appendChild(pname);
      head.appendChild(el('span', 'ws-worker-count', String(kids.length)));
      head.title = '点击打开父会话视图';
      head.addEventListener('click', () => {
        const hostEl = document.getElementById('sessionTree') ?? host;
        openSessionRow(hostEl, parentId, { kind: 'session', title: parentSession?.title });
      });
      det.appendChild(head);
      for (const w of kids) det.appendChild(renderWorkerRow(host, w, true));
    }
    if (orphans.length) {
      const head = el('div', 'ws-worker-parent');
      head.appendChild(el('span', 'ws-lineage-mark', '·'));
      head.appendChild(el('span', 'ws-worker-parent-name', '未关联父会话'));
      det.appendChild(head);
      for (const w of orphans) det.appendChild(renderWorkerRow(host, w, true));
    }
  }
  host.replaceChildren(det);
}

export async function refreshWorkers(container: HTMLElement): Promise<void> {
  if (!container.isConnected) return;
  let list: SessionInfo[];
  try {
    const d = await api.sessions();
    list = d.sessions ?? [];
  } catch {
    return;
  }
  const workers = workerSessions(list);
  const host = container.querySelector<HTMLElement>('.ws-worker-host');
  if (!host) return;
  const sig = workerSigOf(workers);
  if (sig === getWorkerSig()) {
    updateBusyDots(container); // 只切点，不重建组
    return;
  }
  const prevOpen = host.querySelector<HTMLDetailsElement>('.ws-worker-details')?.open ?? true;
  setWorkerSig(sig);
  if (workers.length) renderWorkerGroup(host, workers, prevOpen);
  else host.replaceChildren();
}

export function ensureWorkerPoll(container: HTMLElement): void {
  if (getWorkerTimer() !== null) return;
  setWorkerTimer(
    window.setInterval(() => {
      void refreshWorkers(container);
    }, WORKER_POLL_MS),
  );
}

export function stopWorkerPoll(): void {
  const t = getWorkerTimer();
  if (t !== null) {
    window.clearInterval(t);
    setWorkerTimer(null);
  }
}
