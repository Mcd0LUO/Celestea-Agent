// ============================================================================
// ui/sessions/actions.ts — 会话/工作区操作与「⋯」菜单浮层
//   （W748 从 ui/sessions.ts 拆出；纯搬运，确认文案/端点调用/提示语逐字未改。）
//   刷新动作经 TreeHost 回调编排入口（ui/sessions.ts），避免循环 import。
// ============================================================================
import { api, ApiError } from '../../api';
import { S } from '../../state';
import { el } from '../../utils/dom';
import { refreshArchivePane } from '../archive/panel';
import { batchFailedIds, batchFailureText } from '../batchresult';
import { confirmDialog } from '../confirm';
import { removeRowOptimistic, type RowUndo } from '../optimistic';
import { forgetSession, forgetSessions } from '../sessiongone';
import { openSession } from '../restore';
import { updateActiveHighlight, updateBusyDots, note } from './live';
import { getSessions, setActiveSession, setBatchMode, setSessions, selected } from './store';
import type { TreeHost } from './types';

/** 退出批量勾选模式（清空选择并重绘）。 */
export function exitBatch(host: TreeHost, container: HTMLElement): void {
  setBatchMode(false);
  selected.clear();
  // W5：就地退出勾选模式 —— 基于已更新的本地 getSessions() 重绘，**不** fetch/整树重载。
  // 旧实现走 host.loadTreeInto：删除成功后它会重新 GET /api/sessions，若服务端列表还没
  // 反映删除（或返回旧列表），刚乐观移除的行会被重新画回来。宿主未提供就地重绘时才回退重载。
  if (host.renderTreeInto) host.renderTreeInto(container, null);
  else void host.loadTreeInto(container, null);
}

/** 勾选框/底栏计数与既有 DOM 同步（只改属性与文本）。 */
export function refreshChecks(container: HTMLElement): void {
  for (const cb of container.querySelectorAll<HTMLInputElement>('.sess-check')) {
    cb.checked = cb.dataset.id !== undefined && selected.has(cb.dataset.id);
  }
  const bar = container.querySelector<HTMLElement>('.sess-batchbar');
  if (!bar) return;
  bar.querySelector('.sess-batchbar-count')!.textContent = '已选 ' + selected.size + ' 个会话';
  bar.classList.toggle('active', selected.size > 0);
}

export async function batchDelete(host: TreeHost, container: HTMLElement): Promise<void> {
  const ids = Array.from(selected);
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: '批量删除',
    message: '将批量删除 ' + ids.length + ' 个会话。删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  // 乐观更新（W792）：确认后**立即**把选中行从树里拿掉 —— 没有「删除中…」占位、
  // 不阻塞；请求在后台发。`selected` 先留着，失败时按失败的 id 精确回滚。
  const undos = new Map<string, RowUndo>();
  for (const id of ids) {
    const u = removeRowOptimistic({ container, id, rowSel: '.sess-leaf' });
    if (u) undos.set(id, u);
  }
  const before = getSessions();
  setSessions(before.filter((s) => !ids.includes(s.id ?? '')));
  try {
    const resp = await api.batchDeleteSessions(ids);
    // 端点**永远 HTTP 200**：失败只在 {ok:true,deleted:N,failed:[{id,error}]} 里，
    // catch 不会触发 —— 不看响应体就会「点了删除，界面既没报错也没变化」。
    const fail = batchFailureText('删除', resp);
    if (fail === '') {
      forgetSessions(ids); // 收尾：选中态/高亮/视图容器（含其中若有当前聚焦会话）
      exitBatch(host, container); // 成功：静默收工（树已就地更新，不做整树重载）
      note('已删除 ' + ids.length + ' 个会话');
    } else {
      const keep = batchFailedIds(resp);
      forgetSessions(ids.filter((id) => !keep.includes(id))); // 只收尾真的删掉的那些
      for (const id of keep) undos.get(id)?.restore(); // 只把**失败项**插回原位
      setSessions(before);
      selected.clear();
      for (const id of keep) selected.add(id); // 失败项保持勾选，便于修正后重试
      refreshChecks(container);
      note(fail);
    }
    refreshArchivePane(); // 归档集合可能跟着变（后台静默刷新）
  } catch (err) {
    for (const u of undos.values()) u.restore();
    setSessions(before);
    refreshChecks(container);
    note('批量删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---- 菜单浮层（锚定触发按钮右下） ----------------------------------------------------

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onPick: () => void;
}

export function openCtxMenu(container: HTMLElement, anchor: DOMRect, items: MenuItem[]): void {
  closeCtxMenu();
  const cr = container.getBoundingClientRect();
  const m = el('div', 'sess-menu');
  for (const it of items) {
    const b = el('button', 'sess-menu-item' + (it.danger ? ' danger' : ''), it.label) as HTMLButtonElement;
    b.type = 'button';
    if (it.disabled) {
      b.disabled = true;
      b.classList.add('disabled');
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeCtxMenu();
      it.onPick();
    });
    m.appendChild(b);
  }
  container.appendChild(m);
  const x = Math.max(0, Math.min(anchor.right - cr.left - 8, container.clientWidth - 180));
  const y = Math.max(0, Math.min(anchor.bottom - cr.top + 2, container.clientHeight - 60));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
}

export function closeCtxMenu(): void {
  for (const n of document.querySelectorAll('.sess-menu')) n.remove();
}

// ---- 会话 / 工作区操作 -----------------------------------------------------------------

/**
 * 打开会话视图（W514）：
 *   - **立即**切换容器（hidden 切换 / 零重渲染）：别的会话正在跑也照样切，
 *     不等任何网络请求（旧行为：await activate，409 时无法切换）；
 *   - 随后后台 POST /api/sessions/{id}/activate（运行中的目标会话旧后端会 409，
 *     此时视图仍是可看的实时流 —— 只提示，不影响已打开的视图）；
 *   - 高亮/运行态点只切 class（不重建树）。
 */
export function openSessionRow(
  container: HTMLElement,
  id: string,
  meta?: { kind?: string; title?: string },
): void {
  openSession(id, meta); // 立即开容器（未恢复过历史 → 离屏双缓冲恢复）
  setActiveSession(id);
  S.selSession = id;
  updateActiveHighlight(container);
  updateBusyDots(container);
  note(meta?.title ? '已切换到会话：' + meta.title : '已切换会话');
  void api
    .activateSession(id)
    .then((r) => {
      if (r.ok === false) note('视图已打开 · 未能激活');
    })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        note('该会话运行中（视图已打开 · 实时流可见）');
      } else {
        note('视图已打开 · 未能激活');
      }
    });
}

export async function archiveSession(_host: TreeHost, container: HTMLElement, id: string, label: string): Promise<void> {
  const ok = await confirmDialog({ title: '归档会话', message: '确认归档会话「' + label + '」？', okLabel: '归档' });
  if (!ok) return;
  // 同删除口径（W792）：确认后立即从树里拿掉，请求后台发；失败再插回原位。
  const undo = removeRowOptimistic({ container, id, rowSel: '.sess-leaf' });
  const before = getSessions();
  setSessions(before.filter((s) => s.id !== id));
  try {
    const resp = await api.archiveSession(id);
    // 单条归档失败走非 2xx（ApiError）→ catch；响应体里的 failed[] 一并兜住，口径统一。
    const fail = batchFailureText('归档', resp);
    if (fail !== '') {
      undo?.restore();
      setSessions(before);
      note(fail);
    } else {
      forgetSession(id); // 归档后它已不在当前会话集合里：焦点回 LOCAL 空态，不自动切会话
      note('已归档会话：' + label);
    }
    refreshArchivePane(); // 归档跑到设置页的归档 pane 里去了，在场就静默刷新
  } catch (err) {
    undo?.restore();
    setSessions(before);
    note('归档失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

export async function deleteSession(_host: TreeHost, container: HTMLElement, id: string, label: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除会话「' + label + '」',
    message: '删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  // 1) 立即生效（乐观）：行马上消失，无进度文案、不阻塞输入。
  const undo = removeRowOptimistic({ container, id, rowSel: '.sess-leaf' });
  const before = getSessions();
  setSessions(before.filter((s) => s.id !== id));
  try {
    // 2) 后台发请求；3) 成功静默（不重载整棵树）。
    const resp = await api.batchDeleteSessions([id]);
    // 端点**永远 HTTP 200**：失败（不存在的会话 / 删不掉的会话）只在
    // {ok:true,deleted:0,failed:[{id,error}]} 里 —— 不看响应体就会「点了删除，
    // 界面既没报错也没变化」的静默失败。
    const fail = batchFailureText('删除', resp);
    if (fail !== '') {
      undo?.restore(); // 4) 失败：把行插回原位，并说明原因
      setSessions(before);
      note(fail);
    } else {
      forgetSession(id); // 收尾：S.selSession / 高亮 / 视图容器都不许再指着它
      note('已删除会话：' + label);
    }
    refreshArchivePane();
  } catch (err) {
    undo?.restore();
    setSessions(before);
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

export async function renameSession(host: TreeHost, container: HTMLElement, id: string, current: string): Promise<void> {
  const name = window.prompt('重命名会话（新标题）', current);
  if (name === null) return;
  const t = name.trim();
  if (t === '' || t === current) return;
  try {
    await api.renameSession(id, t);
    void host.loadTreeInto(container, null);
  } catch (err) {
    note('重命名失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

export async function branchSession(host: TreeHost, container: HTMLElement, id: string): Promise<void> {
  const t = window.prompt('分支会话（新分支标题，可留空）', '');
  if (t === null) return;
  try {
    const r = await api.branchSession(id, t.trim() === '' ? undefined : t.trim());
    if (r.ok === false) {
      note('分支失败，请稍后重试');
      return;
    }
    const newId = r.id ?? r.branch;
    if (newId) S.selSession = newId; // 高亮新分支
    note('已创建分支');
    void host.loadTreeInto(container, null);
  } catch (err) {
    note('分支失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

export async function deleteWorkspace(host: TreeHost, container: HTMLElement, name: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除工作区「' + name + '」',
    message: '删除后可在回收目录恢复，确认？',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteWorkspace(name);
    note('工作区已删除：' + name);
    void host.loadTreeInto(container, null);
  } catch (err) {
    note('删除失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

export async function renameWorkspace(host: TreeHost, container: HTMLElement, name: string): Promise<void> {
  const n = window.prompt('重命名工作区', name);
  if (n === null) return;
  const t = n.trim();
  if (t === '' || t === name) return;
  try {
    await api.renameWorkspace(name, t);
    void host.loadTreeInto(container, null);
  } catch (err) {
    note('重命名失败：' + (err instanceof Error ? err.message : String(err)));
  }
}
