// ============================================================================
// ui/commands/popup.ts — A3：命令**补全框**（输入框开头打 '/' 自动弹出）。
//   交互：边打边过滤、↑↓ 选择、Enter 选中、Esc 关闭、点击选中；
//   走 utils/overlays 的层级栈管 Esc（一次 Esc 只关这一层）。
//   铁律：离屏构建 + 单次 replaceChildren；不重建输入栏/背景。
// ============================================================================
import { el } from '../../utils/dom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { filterCommands, type Command } from './registry';

let box: HTMLElement | null = null;
let input: HTMLTextAreaElement | null = null;
let overlay: OverlayHandle | null = null;
let items: Command[] = [];
let active = 0;
/** 选中回调（由 index.ts 接成「把选中命令写回输入框」）。 */
let onPick: ((cmd: Command) => void) | null = null;

function renderList(): void {
  if (!box) return;
  const off = document.createElement('div');
  items.forEach((cmd, i) => {
    const row = el('div', 'cmd-row' + (i === active ? ' active' : ''));
    row.appendChild(el('span', 'cmd-name', '/' + cmd.name));
    row.appendChild(el('span', 'cmd-desc', cmd.desc));
    if (cmd.args !== '') row.appendChild(el('span', 'cmd-args', cmd.args));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === active ? 'true' : 'false');
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 不夺焦点（否则输入框失焦、下次输入断掉）
      choose(i);
    });
    off.appendChild(row);
  });
  box.replaceChildren(...Array.from(off.childNodes));
  const cur = box.querySelector('.cmd-row.active');
  if (cur && typeof (cur as HTMLElement).scrollIntoView === 'function') {
    (cur as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function choose(i: number): void {
  const cmd = items[i];
  if (cmd && onPick) onPick(cmd);
}

/** 当前是否可见。 */
export function completionVisible(): boolean {
  return box !== null && !box.classList.contains('hidden');
}

/** 当前高亮的命令名（测试/诊断）。 */
export function activeCommandName(): string {
  return items[active]?.name ?? '';
}

/** 按输入行刷新补全框（由 inputbar 的 input/keydown 调用）。 */
export function updateCompletion(line: string): void {
  if (!box || !input) return;
  if (!line.startsWith('/') || /\s/.test(line.slice(1))) {
    hideCompletion();
    return;
  }
  const prefix = line.slice(1);
  items = filterCommands(prefix);
  if (items.length === 0) {
    hideCompletion();
    return;
  }
  if (active >= items.length) active = 0;
  box.classList.remove('hidden');
  positionBox();
  renderList();
  if (overlay === null) overlay = pushOverlay(hideCompletion);
}

/** 隐藏补全框（Esc / 失焦 / 发送后）。 */
export function hideCompletion(): void {
  if (!box) return;
  box.classList.add('hidden');
  items = [];
  active = 0;
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

/** ↑↓/Enter/Tab/Shift+Tab 的键盘处理；返回 true = 已消费（调用方不要走发送）。 */
export function completionKey(e: { key: string; shiftKey?: boolean; preventDefault(): void }): boolean {
  if (!completionVisible()) return false;
  if (e.key === 'Escape') {
    e.preventDefault();
    hideCompletion();
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active = (active + 1) % items.length;
    renderList();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active - 1 + items.length) % items.length;
    renderList();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    choose(active);
    return true;
  }
  return false;
}

/** 落位：贴输入框上沿偏左（视口坐标 + fixed）。 */
function positionBox(): void {
  if (!box || !input) return;
  const r = input.getBoundingClientRect();
  box.style.left = Math.max(8, r.left) + 'px';
  box.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + 'px';
}

/** 建出补全框（幂等；index.ts 装配一次）。 */
export function initCompletion(inputEl: HTMLTextAreaElement, pick: (cmd: Command) => void): void {
  if (box) return;
  input = inputEl;
  onPick = pick;
  box = el('div', 'cmd-popup hidden');
  box.id = 'cmdPopup';
  box.setAttribute('role', 'listbox');
  document.body.appendChild(box);
}
