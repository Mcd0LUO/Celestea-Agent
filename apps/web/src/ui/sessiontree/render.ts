// ============================================================================
// ui/sessions/render.ts — 工具行 + 工作区/会话树 + 批量操作条（W243/W514/W515）
//   （W748 从 ui/sessions.ts 拆出；纯搬运，DOM 结构/类名/文案/事件逐字未改。）
//   树渲染主流程（含离屏构建与折叠恢复）仍在编排入口 ui/sessions.ts。
// ============================================================================
import type { SessionInfo } from '../../types';
import { el } from '../../utils/dom';
import { S } from '../../state';
import { grantMarkOf } from '../grants';
import { paneBusy } from '../viewctx';
import {
  archiveSession,
  batchDelete,
  branchSession,
  deleteSession,
  deleteWorkspace,
  exitBatch,
  openCtxMenu,
  openSessionRow,
  refreshChecks,
  renameSession,
  renameWorkspace,
} from './actions';
import { svgIcon } from './icons';
import { paintGrantMark } from './live';
import {
  getActiveSession,
  getSearchQuery,
  getSearchTimer,
  getSortMode,
  getWorkersByParent,
  isBatchMode,
  selected,
  setBatchMode,
  setSearchQuery,
  setSearchTimer,
  setSortMode,
} from './store';
import type { TreeHost } from './types';
import { sortSessions, truncateName } from './util';

export function renderToolbar(host: TreeHost, container: HTMLElement): void {
  // 新会话按钮（树顶部）
  const nsBtn = el('button', 'btn btn-soft ws-newsess') as HTMLButtonElement;
  nsBtn.type = 'button';
  nsBtn.appendChild(svgIcon('plus'));
  nsBtn.appendChild(el('span', null, '新会话'));
  nsBtn.addEventListener('click', () => host.newSession());
  container.appendChild(nsBtn);

  // 工具行：搜索 / 排序 / 新建工作区
  const row = el('div', 'ws-toolrow');
  const searchBox = el('div', 'ws-search');
  searchBox.appendChild(svgIcon('search'));
  const input = el('input', 'ws-search-input') as HTMLInputElement;
  input.placeholder = '搜索工作区/会话';
  input.value = getSearchQuery();
  input.addEventListener('input', () => {
    setSearchQuery(input.value.trim().toLowerCase());
    const t = getSearchTimer();
    if (t !== null) window.clearTimeout(t);
    setSearchTimer(window.setTimeout(() => void host.loadTreeInto(container, null), 180));
  });
  searchBox.appendChild(input);
  row.appendChild(searchBox);

  const sortBtn = el('button', 'ws-toolbtn') as HTMLButtonElement;
  sortBtn.type = 'button';
  sortBtn.appendChild(svgIcon('sort'));
  sortBtn.appendChild(el('span', 'ws-toolbtn-label', getSortMode() === 'active' ? '活跃' : '名称'));
  sortBtn.title = '排序：' + (getSortMode() === 'active' ? '最近活跃' : '名称') + ' · 点击切换';
  sortBtn.addEventListener('click', () => {
    setSortMode(getSortMode() === 'active' ? 'name' : 'active');
    void host.loadTreeInto(container, null);
  });
  row.appendChild(sortBtn);

  const wsBtn = el('button', 'ws-toolbtn') as HTMLButtonElement;
  wsBtn.type = 'button';
  wsBtn.title = '新建工作区';
  wsBtn.appendChild(svgIcon('folder-plus'));
  wsBtn.addEventListener('click', () => host.newWorkspace());
  row.appendChild(wsBtn);

  container.appendChild(row);
  container.appendChild(el('div', 'ws-divider'));
}

export function renderLeaf(host: TreeHost, container: HTMLElement, s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const isActive = id === getActiveSession();
  const leaf = el('div', 'sess-leaf' + (isActive ? ' active' : '') + (S.selSession === id ? ' sel' : ''));
  leaf.dataset.id = id;

  if (!isBatchMode()) {
    const dot = el('span', 'sess-dot' + (paneBusy(id) ? ' busy' : ''));
    dot.dataset.dot = id;
    dot.title = paneBusy(id) ? '运行中' : '空闲';
    leaf.appendChild(dot);
  }
  if (isBatchMode()) {
    const cb = el('input', 'sess-check') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.dataset.id = id;
    cb.checked = selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      refreshChecks(container);
    });
    leaf.appendChild(cb);
  }
  leaf.appendChild(svgIcon('file'));
  const displayName = s.title || truncateName(id) || '(未命名)';
  const name = el('span', 'sess-leaf-name', displayName);
  leaf.appendChild(name);
  const kidCount = getWorkersByParent().get(id) ?? 0;
  if (kidCount > 0) {
    const badge = el('span', 'sess-worker-count', 'W' + kidCount);
    badge.title = '该会话下有 ' + kidCount + ' 个 worker 子会话';
    leaf.appendChild(badge);
  }
  const bits: string[] = [];
  if (s.events !== undefined) bits.push(s.events + ' 次事件');
  if (bits.length) leaf.appendChild(el('span', 'sess-leaf-meta', bits.join(' · ')));

  // W701：已放宽权限的会话显示小盾牌（危险能力用红色小盾）。
  // 节点常驻、只切 class/文本/显隐 —— 标记到货时局部更新，不重建整棵树（铁律 6）。
  const grant = el('span', 'sess-leaf-grant hidden');
  grant.dataset.grantMark = id;
  leaf.appendChild(grant);
  paintGrantMark(grant, grantMarkOf(id));

  leaf.title = displayName + '（点击打开）';

  if (!isBatchMode()) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = '会话操作';
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(container, kebab.getBoundingClientRect(), [
        {
          label: isActive ? '当前会话' : '打开',
          disabled: isActive,
          onPick: () =>
            openSessionRow(container, id, { kind: s.kind === 'worker' ? 'worker' : 'session', title: s.title }),
        },
        { label: '重命名', onPick: () => void renameSession(host, container, id, s.title || truncateName(id)) },
        { label: '归档', onPick: () => void archiveSession(host, container, id, displayName) },
        { label: '分支', onPick: () => void branchSession(host, container, id) },
        { label: '删除', danger: true, onPick: () => void deleteSession(host, container, id, displayName) },
      ]);
    });
    leaf.appendChild(kebab);
  }
  leaf.addEventListener('click', () => {
    openSessionRow(container, id, { kind: s.kind === 'worker' ? 'worker' : 'session', title: s.title });
  });
  return leaf;
}

export function renderWorkspaceNode(
  host: TreeHost,
  container: HTMLElement,
  name: string,
  list: SessionInfo[],
): HTMLElement {
  const wrap = el('div', 'ws-node');
  const det = document.createElement('details');
  det.className = 'ws-details';
  det.dataset.ws = name;
  det.open = true;
  const sum = document.createElement('summary');
  sum.className = 'ws-head';
  sum.appendChild(svgIcon('folder'));
  sum.appendChild(el('span', 'ws-name', name));
  sum.appendChild(el('span', 'ws-count', String(list.length)));
  const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
  kebab.type = 'button';
  kebab.title = '工作区操作';
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    openCtxMenu(container, kebab.getBoundingClientRect(), [
      { label: '新建会话', onPick: () => host.newSession(name) },
      { label: '重命名', onPick: () => void renameWorkspace(host, container, name) },
      {
        label: '批量删除会话',
        onPick: () => {
          setBatchMode(true);
          selected.clear();
          void host.loadTreeInto(container, null);
        },
      },
      { label: '删除工作区', danger: true, onPick: () => void deleteWorkspace(host, container, name) },
    ]);
  });
  sum.appendChild(kebab);
  det.appendChild(sum);
  const body = el('div', 'ws-body');
  for (const s of sortSessions(list)) body.appendChild(renderLeaf(host, container, s));
  det.appendChild(body);
  wrap.appendChild(det);
  return wrap;
}

export function renderBatchBar(host: TreeHost, container: HTMLElement): void {
  const bar = el('div', 'sess-batchbar');
  bar.appendChild(el('span', 'sess-batchbar-count', '已选 0 个会话'));
  const del = el('button', 'btn btn-danger btn-mini', '删除选中') as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => void batchDelete(host, container));
  const quit = el('button', 'btn-mini', '取消') as HTMLButtonElement;
  quit.type = 'button';
  quit.addEventListener('click', () => exitBatch(host, container));
  bar.appendChild(del);
  bar.appendChild(quit);
  container.appendChild(bar);
}
