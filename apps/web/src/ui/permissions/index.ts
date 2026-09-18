// ============================================================================
// ui/permissions/index.ts — 设置页「权限预设」pane 的装配入口。
//
//   容器结构（首次装载离屏构建、单次替换）：
//     #settingsPermissions
//       .perm-toolbar  运行时封顶说明 + 「新建预设」
//       .perm-status   保存/删除结果（就地说明）
//       .perm-list     内置三档 + 自定义档卡片
//       .perm-editor   新建/编辑表单宿主（默认 .hidden；编辑器自身负责显隐）
//
//   列表重渲染由 store 的 PERMISSIONS_CHANGED 事件驱动：pane 只订阅一次，
//   乐观插卡 / 失败回滚都会自动反映到界面上。
// ============================================================================
import { userErrorText } from '../../api';
import type { PermissionPreset } from '../../types/permission';
import { el, need } from '../../utils/dom';
import { confirmDialog } from '../confirm';
import { deletePreset } from './actions';
import { closeEditor, openEditor } from './editor';
import { renderMaxNote, renderPresetsList, type ListHandlers } from './list';
import { PERMISSIONS_CHANGED, ensurePresets, snapshot } from './store';

const HOST = '#settingsPermissions';

let wired = false;

function q<T extends Element>(sel: string): T | null {
  return document.querySelector<T>(sel);
}
function listEl(): HTMLElement | null {
  return q<HTMLElement>(HOST + ' .perm-list');
}
function editorEl(): HTMLElement | null {
  return q<HTMLElement>(HOST + ' .perm-editor');
}
function setStatus(text: string, ok: boolean): void {
  const node = q<HTMLElement>(HOST + ' .perm-status');
  if (node === null) return;
  node.className = 'perm-status' + (text === '' ? '' : ok ? ' ok' : ' err');
  node.textContent = text;
}

function showEditor(preset: PermissionPreset | null): void {
  const host = editorEl();
  if (host === null) return;
  openEditor(host, preset, {
    onSettled: (result) => {
      closeEditor(host);
      setStatus(result.text, result.ok);
    },
    onCancel: () => closeEditor(host),
  });
}

async function removePreset(preset: PermissionPreset): Promise<void> {
  const ok = await confirmDialog({
    title: '删除自定义预设',
    message: '删除「' + (preset.label || preset.id) + '」？仍在使用该档位的会话会回落到默认档。',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  const result = await deletePreset(preset.id);
  setStatus(result.text, result.ok);
}

function renderList(): void {
  const node = listEl();
  if (node === null) return;
  const handlers: ListHandlers = {
    onEdit: (p) => showEditor(p),
    onDelete: (p) => void removePreset(p),
  };
  renderPresetsList(node, handlers);
}

function renderMax(): void {
  const node = q<HTMLElement>(HOST + ' .perm-max');
  if (node !== null) renderMaxNote(node);
}

function buildShell(host: HTMLElement): void {
  const off = document.createElement('div');
  const bar = el('div', 'perm-toolbar');
  bar.appendChild(el('span', 'perm-max', ''));
  const add = el('button', 'btn-mini', '新建预设') as HTMLButtonElement;
  add.type = 'button';
  add.id = 'btnNewPreset';
  add.addEventListener('click', () => showEditor(null));
  bar.appendChild(add);
  off.append(
    bar,
    el('div', 'perm-status'),
    el('div', 'perm-list'),
    el('div', 'perm-editor hidden'),
  );
  host.replaceChildren(...off.childNodes);
}

function subscribe(): void {
  if (wired) return;
  wired = true;
  window.addEventListener(PERMISSIONS_CHANGED, () => {
    renderMax();
    renderList();
  });
}

/** 载入并渲染这一格（config.ts 的 loadPane 调用；「重新载入」会再次调用）。 */
export async function loadPermissionsSection(): Promise<void> {
  const host = need<HTMLElement>(HOST);
  buildShell(host);
  subscribe();
  renderMax();
  if (snapshot() !== null) renderList(); // 已有缓存：当帧就画，不闪空白
  try {
    await ensurePresets(true);
    renderMax();
    renderList();
  } catch (err) {
    setStatus('权限预设暂不可用：' + userErrorText(err, '请稍后重试'), false);
  }
}
