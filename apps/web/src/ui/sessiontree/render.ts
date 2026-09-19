// ============================================================================
// ui/sessions/render.ts — 工具行 + 工作区/会话树 + 批量操作条（W243/W514/W515）
//   （W748 从 ui/sessions.ts 拆出；纯搬运，DOM 结构/类名/文案/事件逐字未改。）
//   树渲染主流程（含离屏构建与折叠恢复）仍在编排入口 ui/sessions.ts。
// ============================================================================
import type { SessionInfo } from '../../types';
import { el } from '../../utils/dom';
import { setHint } from '../hint'; // W790：提示统一走注册缝（不再写原生 title）
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
import { t } from '../../i18n';

export function renderToolbar(host: TreeHost, container: HTMLElement, mount: HTMLElement = container): void {
  // 新会话按钮（树顶部）
  const nsBtn = el('button', 'btn btn-soft ws-newsess') as HTMLButtonElement;
  nsBtn.type = 'button';
  nsBtn.appendChild(svgIcon('plus'));
  nsBtn.appendChild(el('span', null, t('shell.tree.newSession')));
  nsBtn.addEventListener('click', () => host.newSession());
  mount.appendChild(nsBtn);

  // 工具行：搜索 / 排序 / 新建工作区
  const row = el('div', 'ws-toolrow');
  const searchBox = el('div', 'ws-search');
  searchBox.appendChild(svgIcon('search'));
  const input = el('input', 'ws-search-input') as HTMLInputElement;
  input.placeholder = t('shell.tree.searchPlaceholder');
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
  sortBtn.appendChild(el('span', 'ws-toolbtn-label', getSortMode() === 'active' ? t('settings.tag.active') : t('settings.field.name')));
  sortBtn.title = t('shell.tree.sortTitle', { label: getSortMode() === 'active' ? t('shell.tree.sortRecent') : t('settings.field.name') });
  sortBtn.addEventListener('click', () => {
    setSortMode(getSortMode() === 'active' ? 'name' : 'active');
    void host.loadTreeInto(container, null);
  });
  row.appendChild(sortBtn);

  const wsBtn = el('button', 'ws-toolbtn') as HTMLButtonElement;
  wsBtn.type = 'button';
  wsBtn.title = t('shell.tree.newWorkspace');
  wsBtn.appendChild(svgIcon('folder-plus'));
  wsBtn.addEventListener('click', () => host.newWorkspace());
  row.appendChild(wsBtn);

  mount.appendChild(row);
  mount.appendChild(el('div', 'ws-divider'));
}

export function renderLeaf(host: TreeHost, container: HTMLElement, s: SessionInfo): HTMLElement {
  const id = s.id ?? '';
  const batch = isBatchMode();
  const isActive = id === getActiveSession();
  const leaf = el('div', 'sess-leaf' + (isActive ? ' active' : '') + (S.selSession === id ? ' sel' : ''));
  leaf.dataset.id = id;

  if (!batch) {
    const dot = el('span', 'sess-dot' + (paneBusy(id) ? ' busy' : ''));
    dot.dataset.dot = id;
    setHint(dot, paneBusy(id) ? t('shell.tree.running') : t('shell.tree.idle'));
    leaf.appendChild(dot);
  }
  let cb: HTMLInputElement | null = null;
  if (batch) {
    const checkbox = el('input', 'sess-check') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.dataset.id = id;
    checkbox.checked = selected.has(id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
      refreshChecks(container);
    });
    leaf.appendChild(checkbox);
    cb = checkbox;
  }
  leaf.appendChild(svgIcon('file'));
  const displayName = s.title || truncateName(id) || t('shell.tree.unnamed');
  const name = el('span', 'sess-leaf-name', displayName);
  leaf.appendChild(name);
  const kidCount = getWorkersByParent().get(id) ?? 0;
  if (kidCount > 0) {
    const badge = el('span', 'sess-worker-count', 'W' + kidCount);
    badge.title = t('shell.tree.workerBadgeTitle', { n: kidCount });
    leaf.appendChild(badge);
  }
  const bits: string[] = [];
  if (s.events !== undefined) bits.push(t('shell.tree.events', { n: s.events }));
  if (bits.length) leaf.appendChild(el('span', 'sess-leaf-meta', bits.join(' · ')));

  // W701：已放宽权限的会话显示小盾牌（危险能力用红色小盾）。
  // 节点常驻、只切 class/文本/显隐 —— 标记到货时局部更新，不重建整棵树（铁律 6）。
  const grant = el('span', 'sess-leaf-grant hidden');
  grant.dataset.grantMark = id;
  leaf.appendChild(grant);
  paintGrantMark(grant, grantMarkOf(id));

  setHint(leaf, displayName + (batch ? t('shell.tree.clickCheck') : t('shell.tree.clickOpen')));

  if (!batch) {
    const kebab = el('button', 'sess-kebab', '⋯') as HTMLButtonElement;
    kebab.type = 'button';
    kebab.title = t('shell.tree.sessionOps');
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(container, kebab.getBoundingClientRect(), [
        {
          label: isActive ? t('shell.tree.currentSession') : t('shell.tree.open'),
          disabled: isActive,
          onPick: () =>
            openSessionRow(container, id, { kind: s.kind === 'worker' ? 'worker' : 'session', title: s.title }),
        },
        { label: t('shell.tree.rename'), onPick: () => void renameSession(host, container, id, s.title || truncateName(id)) },
        { label: t('shell.tree.archiveOk'), onPick: () => void archiveSession(host, container, id, displayName) },
        { label: t('shell.tree.branch'), onPick: () => void branchSession(host, container, id) },
        { label: t('settings.action.delete'), danger: true, onPick: () => void deleteSession(host, container, id, displayName) },
      ]);
    });
    leaf.appendChild(kebab);
  }
  leaf.addEventListener('click', (e) => {
    // W5：批量模式点行 = 只切换勾选，**绝不打开会话**；点复选框本身交给它的 change，
    // 这里不再切一次（否则双触发：change 一次 + 这里一次 = 白点）。
    if (isBatchMode()) {
      if (cb === null || e.target === cb) return;
      cb.checked = !cb.checked;
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      refreshChecks(container);
      return;
    }
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
  kebab.title = t('shell.tree.workspaceOps');
  kebab.addEventListener('click', (e) => {
    e.stopPropagation();
    openCtxMenu(container, kebab.getBoundingClientRect(), [
      { label: t('shell.tree.newSession'), onPick: () => host.newSession(name) },
      { label: t('shell.tree.rename'), onPick: () => void renameWorkspace(host, container, name) },
      {
        label: t('shell.tree.batchDeleteSessions'),
        onPick: () => {
          setBatchMode(true);
          selected.clear();
          void host.loadTreeInto(container, null);
        },
      },
      { label: t('shell.tree.deleteWorkspace'), danger: true, onPick: () => void deleteWorkspace(host, container, name) },
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

export function renderBatchBar(host: TreeHost, container: HTMLElement, mount: HTMLElement = container): void {
  const bar = el('div', 'sess-batchbar');
  bar.appendChild(el('span', 'sess-batchbar-count', t('shell.tree.selectedZero')));
  const del = el('button', 'btn btn-danger btn-mini', t('shell.tree.deleteSelected')) as HTMLButtonElement;
  del.type = 'button';
  del.addEventListener('click', () => void batchDelete(host, container));
  const quit = el('button', 'btn-mini', t('settings.action.cancel')) as HTMLButtonElement;
  quit.type = 'button';
  quit.addEventListener('click', () => exitBatch(host, container));
  bar.appendChild(del);
  bar.appendChild(quit);
  mount.appendChild(bar);
}
