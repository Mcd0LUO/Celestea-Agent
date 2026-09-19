// ============================================================================
// ui/workbench/menu.ts — G4：右上角「+」入口菜单（文件管理器 / 终端 / 浏览器）。
//   点按钮 → 弹出三选一菜单；选一项即开一个对应面板。
//   铁律：离屏构建 + 单次替换；Esc 走 utils/overlays 层级栈；点击外部关闭。
// ============================================================================
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { openPanel, type PanelKind } from './state';
import { t } from '../../i18n';

let menuEl: HTMLElement | null = null;
let overlay: OverlayHandle | null = null;

function closeMenu(): void {
  if (menuEl) menuEl.classList.add('hidden');
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

/** 开一个面板（文件管理器在工作区不明确时由面板自身给可读提示）。 */
export function openWorkbenchPanel(kind: PanelKind): void {
  closeMenu();
  openPanel(kind, 'right');
}

function item(kind: PanelKind, label: string, desc: string): HTMLElement {
  const btn = el('button', 'wb-menu-item') as HTMLButtonElement;
  btn.type = 'button';
  btn.appendChild(el('span', 'wb-menu-label', label));
  btn.appendChild(el('span', 'wb-menu-desc', desc));
  btn.addEventListener('click', () => openWorkbenchPanel(kind));
  return btn;
}

/** 弹出/收起入口菜单（锚在右上角按钮下方）。 */
export function toggleWorkbenchMenu(): void {
  if (menuEl === null) {
    menuEl = el('div', 'wb-menu hidden');
    menuEl.id = 'wbMenu';
    menuEl.appendChild(item('files', t('chat.wb.menu.files'), t('chat.wb.menu.filesDesc')));
    menuEl.appendChild(item('terminal', t('chat.wb.menu.terminal'), t('chat.wb.menu.terminalDesc')));
    menuEl.appendChild(item('browser', t('chat.wb.menu.browser'), t('chat.wb.menu.browserDesc')));
    document.body.appendChild(menuEl);
  }
  if (!menuEl.classList.contains('hidden')) {
    closeMenu();
    return;
  }
  menuEl.classList.remove('hidden');
  positionMenu();
  overlay = pushOverlay(closeMenu);
  document.addEventListener('pointerdown', onOutside, true);
}

function onOutside(e: Event): void {
  const target = e.target;
  if (menuEl && target instanceof Node && (menuEl.contains(target) || (target instanceof Element && target.closest('#btnWorkbench')))) return;
  document.removeEventListener('pointerdown', onOutside, true);
  closeMenu();
}

function positionMenu(): void {
  if (!menuEl) return;
  const btn = document.getElementById('btnWorkbench');
  const r = btn ? btn.getBoundingClientRect() : null;
  menuEl.style.top = (r ? r.bottom + 6 : 56) + 'px';
  menuEl.style.right = (r ? Math.max(8, window.innerWidth - r.right) : 12) + 'px';
}

/** 装配入口按钮（main.ts 调用一次）。 */
export function installWorkbenchEntry(): void {
  const btn = document.getElementById('btnWorkbench');
  if (btn) btn.addEventListener('click', () => toggleWorkbenchMenu());
}
export { closeMenu as closeWorkbenchMenu };
