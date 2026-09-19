// ============================================================================
// ui/workbench/files.ts — G4：文件管理器面板（Win 风格）。
// ----------------------------------------------------------------------------
// 数据源：GET /api/fs/list?path=（冻结形状 {name,type,size,mtime} + truncated）。
//   · 点文件夹进入、点文件选中（选中态）；面包屑 + 上级；显示大小与时间；
//   · 目录被截断（truncated）/ 端点报错 → **显式可读提示**，不静默。
// 竞态：调用方给 seq + isCurrent（每次导航取新 seq，晚到的旧目录结果丢弃）。
// 铁律：离屏构建 + 单次 replaceChildren（只动本面板 body）。
// ============================================================================
import { el } from '../../utils/dom';
import { api } from '../../api';
import { workspacePath } from '../commands/files';
import type { FsListEntry } from '../../types/fs-list';
import { nextSeq, type PanelState } from './state';

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

function parentOf(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function dataOf(panel: PanelState): FilesData {
  const d = panel.data as unknown as FilesData | undefined;
  if (d && typeof d.path === 'string') return d;
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
    body.replaceChildren(el('div', 'wb-notice', '当前工作区还不明确，无法打开文件管理器'));
    return;
  }
  const path = data.path;
  let resp;
  try {
    resp = await api.fsList(path);
  } catch {
    if (!isCurrent(panel.id, seq)) return;
    body.replaceChildren(el('div', 'wb-notice', '文件列举暂不可用，请稍后再试'));
    return;
  }
  if (!isCurrent(panel.id, seq)) return; // 竞态：晚到的旧目录结果丢弃
  if (resp.error !== undefined && resp.error !== '') {
    body.replaceChildren(el('div', 'wb-notice', '这个目录打不开：' + resp.error));
    return;
  }
  const entries = resp.entries ?? [];
  const off = document.createElement('div');
  const bar = el('div', 'wb-crumbs');
  const up = el('button', 'wb-crumb', '↑ 上级') as HTMLButtonElement;
  up.type = 'button';
  up.addEventListener('click', () => {
    data.path = parentOf(path);
    data.selected = null;
    // 导航取**新** seq：晚到的旧目录结果会被 isCurrent 判为过期而丢弃。
    void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
  });
  bar.appendChild(up);
  const label = el('span', 'wb-crumb wb-crumb-cur', path);
  label.title = path;
  bar.appendChild(label);
  off.appendChild(bar);
  if (resp.truncated === true) off.appendChild(el('div', 'wb-notice', '这个目录条目太多，只显示了前一部分'));
  const list = el('div', 'wb-list');
  if (entries.length === 0) list.appendChild(el('div', 'wb-notice', '（这个目录是空的）'));
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
      data.path = dir.replace(/\/+$/, '') + '/' + e.name;
      data.selected = null;
      void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
    } else {
      data.selected = data.selected === e.name ? null : e.name;
      body.querySelectorAll('.wb-row').forEach((n) => n.classList.remove('sel'));
      r.classList.add('sel');
    }
  });
  return r;
}
