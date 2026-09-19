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
import { api, userErrorText } from '../../api';
import { workspacePath } from '../commands/files';
import type { FsListEntry } from '../../types/fs-list';
import { nextSeq, type PanelState } from './state';
import { joinPath, parentOfPath } from '../fs-path'; // 平台路径（win32 盘符/UNC vs POSIX）
import { openPreview } from '../preview/panel'; // F2：复用既有预览面板（不新写）
import { classifyByPath, type PreviewKind } from '../preview/detect';
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

/**
 * 工作区文件的预览类型：扩展名不认识（如 LICENSE / Makefile）或图片（无 URL 可给）时，
 * 一律按**纯文本**渲染（服务端已判定 kind=text/binary；binary 走降级），避免「类型不支持」误判。
 */
function filePreviewKind(path: string): PreviewKind {
  const k = classifyByPath(path);
  return k === 'markdown' || k === 'diff' || k === 'code' ? k : 'code';
}

/**
 * 打开工作区里的一个文件：复用 F2 的预览面板。
 * 内容由服务端读（GET /api/fs/read）；binary / 读取失败都给**可读降级**，不静默、不白屏。
 * 只传路径，预览面板自己负责显示文件名/路径与「已截断」标记。
 */
function openFilePreview(dir: string, name: string): void {
  const abs = joinPath(dir, name);
  openPreview({
    candidate: { path: abs, kind: filePreviewKind(abs), source: 'label' },
    loadFull: async () => {
      try {
        const r = await api.fsRead(abs);
        if (r.error !== undefined && r.error !== '') return { degraded: r.error };
        if (r.kind === 'binary') {
          return { degraded: t('chat.preview.degradeBinary'), badge: t('chat.preview.badgeBinary') };
        }
        return { text: r.text, truncated: r.truncated === true };
      } catch (err) {
        return { degraded: userErrorText(err, t('chat.preview.degradeReadFailed')) };
      }
    },
  });
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
    } else {
      // 点文件：选中态 + 打开预览面板（内容由服务端读，降级可读）。
      data.selected = e.name;
      body.querySelectorAll('.wb-row').forEach((n) => n.classList.remove('sel'));
      r.classList.add('sel');
      openFilePreview(dir, e.name);
    }
  });
  return r;
}
