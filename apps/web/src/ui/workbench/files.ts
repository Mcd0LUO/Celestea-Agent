// ============================================================================
// ui/workbench/files.ts — G4：文件管理器面板（Win 风格）。
// ----------------------------------------------------------------------------
// 数据源：GET /api/fs/list?path=（冻结形状 {name,type,size,mtime} + truncated）。
//   · 点文件夹进入、点文件**在行下方内联展开**（W1532，VSCode 风格）；面包屑 + 上级；
//   · 目录被截断（truncated）/ 端点报错 → **显式可读提示**，不静默。
// 竞态：调用方给 seq + isCurrent（每次导航取新 seq，晚到的旧目录结果丢弃）；
//       **内联展开另有自己的 seq**（见 FilesData.inlineSeq）—— 快速连点不同文件时，
//       晚到的旧文件内容绝不能画进新文件的展开块。
// 铁律：离屏构建 + 单次 replaceChildren（只动本面板 body）。
//
// W1532（用户：「点击文件默认就是展开的 vscode 风格」）：上一版点文件弹**右侧覆盖式
// 浮层**（ui/preview/panel.ts 的 openPreview）。浮层与目录列表是两块互不相干的地方，
// 看一个文件要先把视线挪到右边、还要记得关掉。现在展开块**就长在那一行下面**：
//   · DOM 上它是 .wb-row 的**兄弟**（.wb-inline，同一个 .wb-list 容器内），
//     所以它的左边界与文件行对齐、宽度就是列宽 —— 绝不是覆盖视口的浮层；
//   · 再点同一行收起（toggle），进入目录 / 上级 / 切面板都会收起（不留孤儿块）。
// 内容装载与降级在 ./files-inline.ts（复用 F2 的渲染器与文案）。
// ============================================================================
import { el } from '../../utils/dom';
import { api } from '../../api';
import { workspacePath } from '../commands/files';
import type { FsListEntry } from '../../types/fs-list';
import { nextSeq, type PanelState } from './state';
import { joinPath, parentOfPath } from '../fs-path'; // 平台路径（win32 盘符/UNC vs POSIX）
import { loadInline } from './files-inline';
import { t } from '../../i18n';

/** 单面板内的浏览状态（挂在面板 data 上，切换时不丢）。 */
interface FilesData {
  path: string;
  selected: string | null;
  /** 当前内联展开的文件名（null = 全部收起）。 */
  expanded: string | null;
  /** 内联装载的竞态序号：每次展开/收起 ++，晚到的旧内容丢弃。 */
  inlineSeq: number;
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
    // 归一旧载荷（本模块之外挂上来的 data 可能缺 W1532 新增的两个字段）。
    if (d.selected === undefined) d.selected = null;
    if (d.expanded === undefined) d.expanded = null;
    if (typeof d.inlineSeq !== 'number') d.inlineSeq = 0;
    return d as FilesData;
  }
  const init: FilesData = { path: workspacePath(), selected: null, expanded: null, inlineSeq: 0 };
  panel.data = init as unknown as Record<string, unknown>;
  return init;
}

/**
 * 在展开块里装载并画出内容（竞态：seq 不是最新的就整段丢弃）。
 *
 * 装载期间先放一行可读的等待说明（不是空白），落笔前再查一次 seq ——
 * 用户可能在这次往返里点了别的文件或收起了这一行。
 */
async function fillInline(box: HTMLElement, abs: string, data: FilesData, my: number): Promise<void> {
  const r = await loadInline(abs);
  if (my !== data.inlineSeq) return; // 竞态：旧文件的装载结果，丢弃
  const parts: HTMLElement[] = [];
  if (r.badge !== null) parts.push(el('div', 'wb-inline-badge', r.badge));
  parts.push(r.node);
  if (r.truncated) parts.push(el('div', 'wb-inline-note', t('chat.preview.truncated')));
  box.replaceChildren(...parts);
}

/**
 * 收起当前展开块（若在飞，++seq 使其作废）。
 *
 * ★ 作用域必须是**本面板的 body**，不能是 document：同一种面板可多开
 * （g4-workbench.test.ts 的「同一种可多开」），document 级选择器会让 A 面板的
 * 收起动作把 B 面板的展开块一起删掉 —— B 的行还留着 open 态，块却没了。
 */
function collapse(data: FilesData, body: HTMLElement): void {
  data.expanded = null;
  data.inlineSeq += 1;
  body.querySelectorAll('.wb-inline').forEach((n) => n.remove());
  body.querySelectorAll('.wb-row.open').forEach((n) => n.classList.remove('open'));
}

/** 展开一个文件：块插在该行**正下方**（DOM 兄弟，非浮层）。 */
function expand(row: HTMLElement, name: string, dir: string, data: FilesData, body: HTMLElement): void {
  collapse(data, body);
  data.expanded = name;
  data.selected = name;
  // 选中态与展开态是**两件事**：展开可以收起，选中表示「当前看的文件」。
  // 既有用例（g4-workbench.test.ts:134）钉的就是选中态，收起时也不该凭空多一个。
  row.classList.add('open', 'sel');
  const box = el('div', 'wb-inline');
  box.dataset['file'] = name;
  box.appendChild(el('div', 'wb-inline-status', t('chat.wb.file.loading')));
  row.after(box); // ★ 行下方：同一列表容器内的兄弟节点
  data.inlineSeq += 1;
  void fillInline(box, joinPath(dir, name), data, data.inlineSeq);
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
    collapse(data, body); // 导航收起展开块：内容属于旧目录，留着是孤儿
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
  const isOpen = e.type !== 'dir' && data.expanded === e.name;
  const r = el('div', 'wb-row' + (e.type === 'dir' ? ' dir' : '') + (isOpen || data.selected === e.name ? ' sel' : '') + (isOpen ? ' open' : ''));
  r.appendChild(el('span', 'wb-icon', e.type === 'dir' ? '📁' : '📄'));
  r.appendChild(el('span', 'wb-name', e.name));
  r.appendChild(el('span', 'wb-size', fmtSize(e.size)));
  r.appendChild(el('span', 'wb-time', fmtTime(e.mtime)));
  r.addEventListener('click', () => {
    if (e.type === 'dir') {
      collapse(data, body);
      data.path = joinPath(dir, e.name);
      data.selected = null;
      void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrent);
    } else if (data.expanded === e.name) {
      // 再点同一行 ⇒ 收起（VSCode 行为）。
      collapse(data, body);
      r.classList.remove('sel');
    } else {
      // 点文件 ⇒ 选中 + 在**行下方**内联展开（内容由服务端读，降级可读）。
      // 清选中态按**本面板**作用域（同一种面板可多开，document 级会误伤别的面板）。
      body.querySelectorAll('.wb-row').forEach((n) => n.classList.remove('sel'));
      expand(r, e.name, dir, data, body);
    }
  });
  return r;
}
