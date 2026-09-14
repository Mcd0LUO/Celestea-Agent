// ============================================================================
// ui/sessions.ts — 左侧工作区/会话树（W243 重构）：
//   结构自上而下：新会话按钮 → 工具行（搜索 / 排序 / 新建工作区）→ 分割线
//   → 会话树（工作区节点可折叠：文件夹图标+名称+「⋯」；会话叶子：文件图标
//    +标题+「⋯」）→ 引擎 Worker 组（W239，未就绪隐藏）。
//   工作区「⋯」菜单（锚定右下）：重命名 / 删除（确认后注销）/ 批量删除会话
//   （进入勾选模式：叶子左侧勾选框 + 底部操作条，走 batch-delete）。
//   会话「⋯」菜单：重命名 / 删除 / 归档 / 分支（成功后刷新并高亮新分支）。
//   搜索过滤工作区与会话；排序切换「最近活跃（modified）/ 名称」。
//   点击会话行 = **立即**打开该会话的视图容器（不因别的会话在跑而阻塞），
//   随后后台 POST activate（409/不可用只提示，视图照常可看）。
//   W514：Worker 组可展开（wid / 标题 / 运行状态 / 模型），点击打开其会话视图；
//         会话行显示运行态点，运行态变化只做局部 class 更新（铁律 6）。
//   图标：内联 SVG（不引图标库）。端点缺失（W243 并行开发）优雅降级。
//
//   W748：按职责拆到 ./sessiontree/*，本文件只保留**编排入口**（树渲染主流程 /
//   载入/装配）并原样再导出对外 API（import 路径与拆分前兼容）。
//   拆分是纯搬家：无行为变更（侧栏与设置页仍共用同一份模块级状态，未动语义）。
//     ./sessiontree/types.ts        TreeHost 契约
//     ./sessiontree/store.ts        模块级状态（batchMode/selected/wsList/sessions/…）
//     ./sessiontree/util.ts         纯读取/派生（谱系判定、排序、签名、命名单段）
//     ./sessiontree/icons.ts        内联 SVG 图标（含侧栏小盾牌）
//     ./sessiontree/live.ts         局部更新（运行态点 / 权限标记 / #sideFoot 提示）
//     ./sessiontree/actions.ts      「⋯」菜单 + 会话/工作区操作 + 批量删除
//     ./sessiontree/workers.ts      引擎 Worker 组（5s 轮询 + 签名短路）
//     ./sessiontree/render.ts       工具行 / 会话叶子 / 工作区节点 / 批量操作条
//     ./sessiontree/newsession.ts   新建会话弹窗 / 新建工作区
// ============================================================================
import { api } from '../api';
import { el, need } from '../utils/dom';
import { activeSessionId, onBusyChange, setPaneMeta, setRemoteBusy } from './viewctx';
import { updateSessionBar } from './sessionbar';
import { ensureGrantMarks, GRANTS_CHANGED_EVENT } from './grants';
import { closeCtxMenu } from './sessiontree/actions';
import { updateBusyDots, updateGrantMarks } from './sessiontree/live';
import { newSessionDialog, newWorkspaceDialog } from './sessiontree/newsession';
import { renderBatchBar, renderToolbar, renderWorkspaceNode } from './sessiontree/render';
import {
  getSearchQuery,
  getSessions,
  getWorkersByParent,
  getWsList,
  isBatchMode,
  setActiveSession,
  setSessions,
  setWorkerSig,
  setWorkersByParent,
  setWsList,
} from './sessiontree/store';
import type { TreeHost } from './sessiontree/types';
import { isWorkerSession, matchesQuery, parentOf, workerSessions, workerSigOf, wsNameOf } from './sessiontree/util';
import {
  ensureWorkerPoll,
  refreshWorkers,
  renderWorkerGroup,
  stopWorkerPoll,
} from './sessiontree/workers';

// ---- 树渲染主流程 ----------------------------------------------------------------------

/** 载入并渲染：新会话按钮 + 工具行 + 工作区/会话树 + Worker 组（侧栏与设置页复用）。 */
export async function loadTreeInto(container: HTMLElement, countEl: HTMLElement | null): Promise<void> {
  closeCtxMenu();
  // 记录折叠状态与搜索框焦点（重建后保持，避免闪动）
  const openMap = new Map<string, boolean>();
  for (const det of container.querySelectorAll<HTMLDetailsElement>('.ws-details')) {
    openMap.set(det.dataset.ws ?? '', det.open);
  }
  const searchFocused = document.activeElement?.classList.contains('ws-search-input') ?? false;
  const off = document.createElement('div'); // 离屏容器：构建期间旧内容保持可见
  if (countEl) countEl.textContent = '…';

  try {
    const w = await api.workspaces();
    setWsList(w.workspaces ?? []);
    if (w.active_session) setActiveSession(w.active_session);
  } catch {
    setWsList([]);
  }

  try {
    const d = await api.sessions();
    setSessions(d.sessions ?? []);
    // W514：容器元数据（kind/标题/模型）+ 远端运行态（busy 字段缺失 → 不覆盖本地）
    for (const s of getSessions()) {
      const id = s.id ?? '';
      if (!id) continue;
      setPaneMeta(id, {
        kind: s.kind === 'worker' ? 'worker' : s.kind === 'session' ? 'session' : undefined,
        title: s.title,
        model: s.model,
        workspace: s.workspace ?? undefined,
      });
      if (typeof s.busy === 'boolean') setRemoteBusy(id, s.busy);
    }
    const act = (d.sessions ?? []).find((s) => s.active === true);
    // 客户端已打开的容器是更强真源：不因后端 active 字段把高亮带偏
    const open = activeSessionId();
    if (open) setActiveSession(open);
    else if (act?.id) setActiveSession(act.id);
  } catch (err) {
    stopWorkerPoll();
    off.appendChild(el('div', 'side-note err', '会话列表暂不可用'));
    off.appendChild(el('div', 'side-note', err instanceof Error ? err.message : String(err)));
    container.replaceChildren(...off.childNodes);
    if (countEl) countEl.textContent = '—';
    return;
  }

  const treeSessions = getSessions().filter((s) => !isWorkerSession(s));
  const wsNames = new Set<string>();
  for (const s of treeSessions) if (!s.archived) wsNames.add(wsNameOf(s));
  for (const n of wsNames) {
    if (!getWsList().some((w) => w.name === n)) getWsList().push({ name: n });
  }
  getWsList().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (countEl) countEl.textContent = String(treeSessions.filter((s) => s.archived !== true).length);

  // W515：父会话 → worker 子会话数（建树前算好，供父会话行徽标使用）
  const workers = workerSessions(getSessions());
  setWorkersByParent(new Map());
  for (const w of workers) {
    const p = parentOf(w);
    if (!p) continue;
    const counts = getWorkersByParent();
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  renderToolbar(HOST, off);

  // 树：按工作区收束（可折叠）
  const tree = el('div', 'ws-tree');
  const wsWith = getWsList().filter(
    (w) =>
      matchesQuery(w.name) ||
      treeSessions.some((s) => !s.archived && wsNameOf(s) === w.name && matchesQuery(s.title ?? s.id ?? '')),
  );
  let rendered = 0;
  for (const w of wsWith) {
    const list = treeSessions.filter(
      (s) => !s.archived && wsNameOf(s) === w.name && matchesQuery(s.title ?? s.id ?? ''),
    );
    if (!matchesQuery(w.name) && !list.length) continue;
    tree.appendChild(renderWorkspaceNode(HOST, container, w.name, list));
    rendered += list.length;
  }
  if (!rendered) {
    tree.appendChild(el('div', 'side-note', getSearchQuery() ? '无匹配结果' : '无会话记录 · 点击「新会话」创建'));
  }
  off.appendChild(tree);

  // 批量勾选模式：底部操作条
  if (isBatchMode()) renderBatchBar(HOST, off);

  // 引擎 Worker 组（W514：常驻 host —— 轮询只替换 host 内容，不重建整棵树）
  const wHost = el('div', 'ws-worker-host');
  off.appendChild(wHost);
  setWorkerSig(workerSigOf(workers));
  if (workers.length) {
    renderWorkerGroup(wHost, workers, true);
    ensureWorkerPoll(container);
  } else {
    stopWorkerPoll();
  }

  // 一次性替换（无空白帧）
  container.replaceChildren(...off.childNodes);

  // 恢复折叠状态
  for (const det of container.querySelectorAll<HTMLDetailsElement>('.ws-details')) {
    const name = det.dataset.ws ?? '';
    if (openMap.has(name)) det.open = openMap.get(name) ?? true;
  }
  // 恢复搜索框焦点（输入过滤时不丢焦点）
  if (searchFocused) {
    const inp = container.querySelector<HTMLInputElement>('.ws-search-input');
    if (inp) inp.focus();
  }
  // W514：元数据（标题/kind）回填后同步会话条与运行态点（只改文本/class）
  updateBusyDots(container);
  updateSessionBar();
  // W701：权限标记只做局部更新；未知项按需查询（能力位未就绪时该调用是空操作）
  updateGrantMarks(container);
  ensureGrantMarks(treeSessions.filter((s) => !s.archived).map((s) => s.id ?? ''));
}

// ---- 装配 ------------------------------------------------------------------------

export function loadSessions(): Promise<void> {
  return loadTreeInto(need<HTMLElement>('#sessionTree'), need<HTMLElement>('#sessionCount'));
}

/** 新建会话弹窗（W748：实现见 ./sessiontree/newsession.ts）。 */
export function newSession(presetWs?: string): void {
  newSessionDialog(HOST, presetWs);
}

/** 新建工作区：文件管理器弹窗（实现见 ./sessions/newsession.ts）。 */
export function newWorkspace(): void {
  newWorkspaceDialog(HOST);
}

/** 子渲染/操作回调编排入口（避免子模块反向 import 本文件造成循环引用）。 */
const HOST: TreeHost = {
  newSession: (presetWs?: string) => newSession(presetWs),
  newWorkspace: () => newWorkspace(),
  loadTreeInto: (container: HTMLElement, countEl: HTMLElement | null) => loadTreeInto(container, countEl),
  loadSessions: () => loadSessions(),
};

export function initSessionsPanel(): void {
  // 第 22 轮：清空/刷新入口已移除（后端端点保留）
  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.sess-menu')) closeCtxMenu();
  });
  // W701：权限标记到货/变化 → 只更新既有叶子的标记节点（局部，不重建树）
  window.addEventListener(GRANTS_CHANGED_EVENT, () => {
    const c = document.getElementById('sessionTree');
    if (c) updateGrantMarks(c);
  });
  // W514：任一会话运行态变化 → 只更新侧栏运行态点/Worker 行状态（局部）
  onBusyChange(() => {
    const c = document.getElementById('sessionTree');
    if (!c) return;
    updateBusyDots(c);
    const host = c.querySelector<HTMLElement>('.ws-worker-host');
    if (host) void refreshWorkers(c); // 只重建 Worker 组（签名变化时）
  });
  void loadSessions();
}
