// ============================================================================
// ui/permissions/list.ts — 预设卡片列表（内置三档 + 自定义档）。
//
//   铁律 1/2：离屏构建 + 单次替换（container.replaceChildren），不清空后逐条渲染；
//   卡片内容全是只读呈现，编辑/删除入口只回调调用方（本模块零网络、零状态）。
// ============================================================================
import type { PermissionPreset } from '../../types/permission';
import { el } from '../../utils/dom';
import { maxNote, presetChips, unsandboxedNote } from './copy';
import { snapshot } from './store';
import { t } from '../../i18n';

export interface ListHandlers {
  onEdit(preset: PermissionPreset): void;
  onDelete(preset: PermissionPreset): void;
}

function opButton(label: string, cls: string, run: () => void): HTMLButtonElement {
  const b = el('button', cls, label) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', run);
  return b;
}

/** 一张档位卡：label + id + 语义 chips（+ 额外目录清单 + 免沙箱说明）。 */
export function presetCard(
  preset: PermissionPreset,
  builtin: boolean,
  handlers: ListHandlers,
): HTMLElement {
  const card = el('div', 'perm-card');
  card.dataset.id = preset.id;
  card.dataset.builtin = builtin ? '1' : '0';

  const head = el('div', 'perm-card-head');
  head.appendChild(el('span', 'perm-card-title', preset.label || preset.id));
  head.appendChild(el('code', 'perm-card-id', preset.id));
  if (builtin) head.appendChild(el('span', 'perm-badge', t('settings.permissions.builtin')));
  else {
    const ops = el('div', 'perm-card-ops');
    ops.appendChild(opButton(t('settings.action.edit'), 'btn-mini', () => handlers.onEdit(preset)));
    ops.appendChild(opButton(t('settings.action.delete'), 'btn-mini danger', () => handlers.onDelete(preset)));
    head.appendChild(ops);
  }
  card.appendChild(head);

  const chips = el('div', 'perm-chips');
  for (const chip of presetChips(preset)) chips.appendChild(el('span', 'perm-chip ' + chip.tone, chip.text));
  card.appendChild(chips);

  if (preset.writeRoots.length > 0) {
    const roots = el('div', 'perm-roots');
    roots.appendChild(el('span', 'perm-roots-label', t('settings.permissions.extraRootsLabel')));
    for (const root of preset.writeRoots) roots.appendChild(el('code', 'perm-root', root));
    card.appendChild(roots);
  }
  const note = unsandboxedNote(preset);
  if (note !== '') card.appendChild(el('div', 'perm-card-note', note));
  return card;
}

/** 列表区渲染（容器 = #settingsPermissions .perm-list）。 */
export function renderPresetsList(container: HTMLElement, handlers: ListHandlers): void {
  const off = document.createElement('div');
  const snap = snapshot();
  if (snap === null) {
    off.appendChild(el('div', 'side-note', t('settings.permissions.unavailable')));
  } else {
    for (const p of snap.builtin) off.appendChild(presetCard(p, true, handlers));
    for (const p of snap.custom) off.appendChild(presetCard(p, false, handlers));
    if (snap.custom.length === 0) {
      off.appendChild(el('div', 'side-note', t('settings.permissions.emptyCustom')));
    }
  }
  container.replaceChildren(...off.childNodes);
}

/** 封顶说明节点（'' = 服务未给出 max 时保持空文本，不编造）。 */
export function renderMaxNote(node: HTMLElement): void {
  const snap = snapshot();
  node.textContent = snap === null ? '' : maxNote(snap.max);
}
