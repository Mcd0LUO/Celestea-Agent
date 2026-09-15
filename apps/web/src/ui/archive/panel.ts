// ============================================================================
// ui/archive/panel.ts — 设置页「归档会话管理」pane（W786）。
//   只列**已归档**会话（`archived === true`），按工作区分组；每行两个动作：
//     恢复 → unarchive（把该行放回会话列表）；删除 → 批量删除端点（二次确认）。
//   这里**不放**新建会话 / 改名 / 分支 / 切工作区等侧栏功能。
//
//   W792 修复（真机复现）：取数必须走**归档端点** `GET /api/sessions?archived=1`。
//   过去用缺省列表 `api.sessions()` 再筛 `archived === true` —— 实测（2026-09-16，
//   3777）缺省响应体里**连 `archived` 键都没有**（该响应体已冻结不变），筛出来恒为
//   空 ⇒ 面板永远是「暂无归档会话」，归档后的会话在 UI 里既看不到也删不掉。
//   缺省列表仍要能拿到（会话树在用），所以口径落在 api.sessions({archived:true})。
//
//   纪律（FRONTEND-RULES）：
//     · 铁律 1：离屏构建 + 一次 replaceChildren，旧内容保留到新内容就绪；
//     · 铁律 3：加载带序号竞态守卫，晚到的旧结果丢弃；
//     · 铁律 7：pane 内容由 config.ts 首载缓存，只有显式动作（切页首载 /
//       「重新载入」/ 本页操作成功后）才重新拉取。
//   判断逻辑全在 ./rows 的纯函数里（可在 node 里跑真实生产代码）。
// ============================================================================
import { api, userErrorText } from '../../api';
import type { BatchOpResp, ClearResp, SessionInfo } from '../../types';
import { el } from '../../utils/dom';
import { batchFailureText } from '../batchresult';
import { confirmDialog } from '../confirm';
import { removeRowOptimistic } from '../optimistic';
import {
  archiveCountText,
  archiveDeleteConfirmText,
  archiveEmptyText,
  archivedRows,
  groupArchived,
  isEmptyArchive,
  restoreConfirmText,
  rowLabel,
  tailOf,
} from './rows';

/** 渲染与刷新所需的落点（容器 + 计数位）。 */
interface Ctx {
  container: HTMLElement;
  countEl: HTMLElement | null;
}

/** 竞态守卫（铁律 3）：只有最后一次请求的结果允许落地。 */
let seq = 0;
/** 同一时刻只允许一个归档操作在飞（防连点两次「恢复」发两次请求）。 */
let busy = false;

/** 页内提示行（在 pane 容器之外，刷新列表不会把它一起换掉）。 */
function setStatus(text: string, err = false): void {
  const n = document.getElementById('settingsArchiveHint');
  if (!n) return;
  n.className = err ? 'cfg-hintline err' : 'cfg-hintline';
  n.textContent = text;
}

function actionButton(label: string, cls: string, onPick: () => void): HTMLButtonElement {
  const b = el('button', cls, label) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', onPick);
  return b;
}

function renderRow(s: SessionInfo, ctx: Ctx): HTMLElement {
  const id = s.id ?? '';
  const label = rowLabel(s);
  const row = el('div', 'arc-row');
  row.dataset.id = id;
  const main = el('div', 'arc-main');
  main.appendChild(el('div', 'arc-title', label));
  const tail = tailOf(id);
  if (tail !== '') main.appendChild(el('div', 'arc-id', tail));
  row.appendChild(main);
  const acts = el('div', 'arc-actions');
  acts.appendChild(actionButton('恢复', 'btn-mini', () => void restoreRow(id, label, ctx)));
  acts.appendChild(actionButton('删除', 'btn-mini danger', () => void deleteRow(id, label, ctx)));
  row.appendChild(acts);
  return row;
}

function renderGroup(workspace: string, rows: SessionInfo[], ctx: Ctx): HTMLElement {
  const det = el('details', 'arc-ws') as HTMLDetailsElement;
  det.open = true; // 默认展开：归档是低频页，先看见内容
  const head = el('summary', 'arc-ws-head');
  head.appendChild(el('span', 'arc-ws-name', workspace));
  head.appendChild(el('span', 'arc-ws-count', String(rows.length)));
  det.appendChild(head);
  for (const s of rows) det.appendChild(renderRow(s, ctx));
  return det;
}

/** 结果 → 离屏 DOM（调用方负责一次 replaceChildren）。 */
function buildBody(rows: SessionInfo[], ctx: Ctx): HTMLElement {
  const off = el('div', 'arc-wrap');
  if (isEmptyArchive(rows)) {
    off.appendChild(el('div', 'side-note', archiveEmptyText()));
    return off;
  }
  for (const g of groupArchived(rows)) off.appendChild(renderGroup(g.workspace, g.rows, ctx));
  return off;
}

function buildError(err: unknown): HTMLElement {
  const off = el('div', 'arc-wrap');
  off.appendChild(el('div', 'side-note err', '归档会话暂不可用'));
  off.appendChild(el('div', 'side-note', userErrorText(err)));
  return off;
}

/**
 * 载入并渲染归档会话列表（切页首载 / 「重新载入」/ 操作成功后的刷新）。
 *   W792：取数走归档端点 `?archived=1`（缺省列表里根本没有归档行）；
 *   `archivedRows()` 只作防御性过滤（服务端已保证每行 `archived:true`）。
 */
export function loadArchiveSection(
  container: HTMLElement,
  countEl: HTMLElement | null,
  opts?: { quiet?: boolean },
): Promise<void> {
  const my = ++seq;
  const ctx: Ctx = { container, countEl };
  // quiet = 动作后的**静默**刷新：不把计数位清成加载占位（前端能立即响应的就立即响应）。
  if (countEl && opts?.quiet !== true) countEl.textContent = '…';
  return api
    .sessions({ archived: true })
    .then((d) => {
      if (my !== seq) return; // 晚到的旧结果：丢弃，不覆盖新状态
      const rows = archivedRows(d.sessions);
      if (countEl) countEl.textContent = archiveCountText(rows.length);
      container.replaceChildren(...buildBody(rows, ctx).childNodes);
    })
    .catch((err: unknown) => {
      if (my !== seq) return;
      if (countEl) countEl.textContent = '—';
      container.replaceChildren(...buildError(err).childNodes);
    });
}

/**
 * 执行一次归档操作（恢复 / 删除）。
 *   W792 口径：确认后该行**立即**消失（乐观更新，无「…中」占位、不阻塞），请求后台发；
 *   失败再插回原位并说明原因。批量端点**部分失败也返回 200 + ok:true**（失败项只在
 *   `failed[]`）—— 不能只看有没有抛异常，响应里的失败必须呈现给用户，不得静默吞掉。
 */
async function applyAction(
  verb: string,
  id: string,
  call: () => Promise<ClearResp | BatchOpResp>,
  done: string,
  ctx: Ctx,
): Promise<void> {
  busy = true;
  const undo = removeRowOptimistic({
    container: ctx.container,
    id,
    rowSel: '.arc-row',
    countEl: ctx.countEl,
  });
  try {
    const resp = await call();
    const fail = batchFailureText(verb, resp);
    if (fail !== '') {
      undo?.restore();
      setStatus(fail, true);
    } else {
      setStatus(done);
      // 成功才静默对账一次（归档集合已变）：不清计数位、不闪加载态。
      await loadArchiveSection(ctx.container, ctx.countEl, { quiet: true });
    }
  } catch (err) {
    undo?.restore();
    setStatus(verb + '失败：' + userErrorText(err), true);
  } finally {
    busy = false;
  }
}

/**
 * 别的入口（会话树的单个/批量删除、归档）改动了归档集合后，若设置页归档 pane
 * 正挂在文档里就地刷新它（挂载判定看容器是否在场，不引入额外全局状态）。
 */
export function refreshArchivePane(): void {
  const box = document.getElementById('settingsArchive');
  if (!box) return;
  void loadArchiveSection(box, document.getElementById('settingsArchiveCount'), { quiet: true });
}

async function restoreRow(id: string, label: string, ctx: Ctx): Promise<void> {
  if (busy || id === '') return;
  const ok = await confirmDialog({
    title: '恢复归档会话',
    message: restoreConfirmText(label),
    okLabel: '恢复',
  });
  if (!ok) return;
  await applyAction('恢复', id, () => api.unarchiveSession(id), '已恢复会话：' + label, ctx);
}

async function deleteRow(id: string, label: string, ctx: Ctx): Promise<void> {
  if (busy || id === '') return;
  const ok = await confirmDialog({
    title: '删除归档会话',
    message: archiveDeleteConfirmText(label),
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  await applyAction('删除', id, () => api.batchDeleteSessions([id]), '已删除会话：' + label, ctx);
}
