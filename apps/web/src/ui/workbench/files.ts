// ============================================================================
// ui/workbench/files.ts — G4：文件管理器面板（Win 风格）。
// ----------------------------------------------------------------------------
// 数据源：GET /api/fs/list?path=（冻结形状 {name,type,size,mtime} + truncated）。
//   · 点文件夹进入、点文件**在右侧预览面板打开**（W1545，取代 W1532 的行内展开）；
//     面包屑 + 上级；
//   · 目录被截断（truncated）/ 端点报错 → **显式可读提示**，不静默。
// 竞态：调用方给 seq + isCurrent（每次导航取新 seq，晚到的旧目录结果丢弃）；
//       文件内容的竞态由**预览面板自己的 seq** 守着（openPreview 每次 ++seq，
//       晚到的旧文件段落一个字都画不进去）。
// 铁律：离屏构建 + 单次 replaceChildren（只动本面板 body）。
//
// ★ W1545（用户：「打开文件应该直接渲染完整的文件（流式打开巨文件）而不是直接原地
//   展开，且原地展开的文件还没有高亮」+「右侧的预览是应该几乎瞬时出现的」）：
//   W1532 的行内展开被**整块移除**（.wb-inline / files-inline.ts 已删）。理由三条，
//   都是用户点出来的：
//     · 行内块长在目录列表里，天然只能给一个小窗口（旧上限 128 KiB + max-height 340px），
//       而用户要的是**完整文件**；
//     · 行内块**没有** .rendered 祖先，hljs 的颜色规则（components.css 的
//       `.rendered .hljs-keyword`）一条都命中不了 ⇒ 类加上了、颜色没生效；
//     · 右侧预览面板才是「看文件」的地方（工具卡预览、F2 都走它），两块渲染面
//       本来就该是同一块。
//   内容装载在 ./files-open.ts：分段取（offset/limit）⇒ 面板壳先出、内容逐段追加。
// ============================================================================
import { el } from '../../utils/dom';
import { api } from '../../api';
import { workspacePath } from '../commands/files';
import type { FsListEntry } from '../../types/fs-list';
import { nextSeq, type PanelState } from './state';
import { joinPath, parentOfPath } from '../fs-path'; // 平台路径（win32 盘符/UNC vs POSIX）
import { openFilePreview } from './files-open';
import { t } from '../../i18n';

/** 单面板内的浏览状态（挂在面板 data 上，切换时不丢）。 */
interface FilesData {
  path: string;
  selected: string | null;
}

/** 人类可读大小。 */
function fmtSize(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** 人类可读时间（本地）。 */
function fmtTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => (n < 10 ? '0' : '') + String(n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function dataOf(panel: PanelState): FilesData {
  const d = panel.data as unknown as Partial<FilesData> | undefined;
  if (d && typeof d.path === 'string') {
    if (d.selected === undefined) d.selected = null;
    return d as FilesData;
  }
  const init: FilesData = { path: workspacePath(), selected: null };
  panel.data = init as unknown as Record<string, unknown>;
  return init;
}

/** 渲染文件管理器面板内容（可重入：导航时重新调用，只动 body）。 */
export async function renderFilesPanel(
  body: HTMLElement,
  panel: PanelState,
  seq: number,
  isCurrent: (id: string, seq: number) => boolean,
): Promise<void> {
  const data = dataOf(panel);
  if (data.path === '') {
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.noWorkspace')));
    return;
  }
  const path = data.path;
  let resp;
  try {
    resp = await api.fsList(path);
  } catch {
    if (!isCurrent(panel.id, seq)) return;
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.listUnavailable')));
    return;
  }
  if (!isCurrent(panel.id, seq)) return; // 竞态：晚到的旧目录结果丢弃
  if (resp.error !== undefined && resp.error !== '') {
    body.replaceChildren(el('div', 'wb-notice', t('chat.wb.dirOpenFailed', { reason: resp.error })));
    return;
  }
  const entries = resp.entries ?? [];
  const off = document.createElement('div');
  const bar = el('div', 'wb-crumbs');
  const up = el('button', 'wb-crumb', t('chat.wb.up')) as HTMLButtonElement;
  up.type = 'button';
  // 已在根（POSIX '/' / Windows 'C:\' / UNC '\\server\share\'）：上一级就是它自己 ⇒ 禁用，
  // 避免一次「导航到原地」的无效请求（后端在盘符根会把 parent 回成 C:\ 自身）。
  const atRoot = parentOfPath(path) === path;
  up.disabled = atRoot;
  if (atRoot) up.title = t('chat.wb.upAtRoot');
  up.addEventListener('click', () => {
    if (atRoot) return;
    data.path = parentOfPath(path);
    data.selected = null;
    // 导航取**新** seq：晚到的旧目录结果会被 isCurrent 判为过期而丢弃。
    void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
  });
  bar.appendChild(up);
  const label = el('span', 'wb-crumb wb-crumb-cur', path);
  label.title = path;
  bar.appendChild(label);
  off.appendChild(bar);
  if (resp.truncated === true) off.appendChild(el('div', 'wb-notice', t('chat.wb.dirTruncated')));
  const list = el('div', 'wb-list');
  if (entries.length === 0) list.appendChild(el('div', 'wb-notice', t('chat.wb.dirEmpty')));
  for (const e of entries) list.appendChild(row(e, data, path, body, panel, isCurrent));
  off.appendChild(list);
  body.replaceChildren(...Array.from(off.childNodes));
}

function row(
  e: FsListEntry,
  data: FilesData,
  dir: string,
  body: HTMLElement,
  panel: PanelState,
  isCurrent: (id: string, seq: number) => boolean,
): HTMLElement {
  const r = el('div', 'wb-row' + (e.type === 'dir' ? ' dir' : '') + (data.selected === e.name ? ' sel' : ''));
  r.appendChild(el('span', 'wb-icon', e.type === 'dir' ? '📁' : '📄'));
  r.appendChild(el('span', 'wb-name', e.name));
  r.appendChild(el('span', 'wb-size', fmtSize(e.size)));
  r.appendChild(el('span', 'wb-time', fmtTime(e.mtime)));
  r.addEventListener('click', () => {
    if (e.type === 'dir') {
      data.path = joinPath(dir, e.name);
      data.selected = null;
      void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
      return;
    }
    // W1545：点文件 ⇒ **右侧预览面板**（不再是行下方内联展开）。
    // 清选中态按**本面板**作用域（同一种面板可多开，document 级会误伤别的面板）。
    body.querySelectorAll('.wb-row').forEach((n) => n.classList.remove('sel'));
    r.classList.add('sel');
    data.selected = e.name;
    // 同步调用：面板壳当帧出现，内容由 files-open.ts 分段喂（首段小 ⇒ 首屏快）。
    openFilePreview(joinPath(dir, e.name));
  });
  return r;
}
