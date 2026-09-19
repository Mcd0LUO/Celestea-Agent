// ============================================================================
// ui/workbench/panel.ts — G4：面板系统的**渲染与停靠**（离屏构建 + 单次替换）。
// ----------------------------------------------------------------------------
// 布局选择（报告里说明理由与代价）：**不动 #layout 的三栏骨架**（#sidebar + #main）。
//   在 #main 内部新增一个 .wb-host（普通 flex 子项，位于 .chat-shell 之后）：
//     垂直布局（有 bottom 面板时）与水平 split（有 right 面板时）各一段。
//   代价：面板只占 #main 的高度/宽度 ⇒ 对话区被压缩而不是覆盖；收益：零骨架改动、
//   零背景重建、与既有 .sess-pane 滚动容器互不干扰（铁律 5 满足）。
// 铁律：任何面板增删/停靠变化都**只重建面板区**（#messages / .chat-shell 的节点身份不变）；
//      分隔条拖拽用 rAF 节流；每个面板独立 seq（见 state.nextSeq）。
// ============================================================================
import { el } from '../../utils/dom';
import {
  closePanel, focusedPanel, focusPanel, isCurrentSeq, listPanels, nextSeq, onPanelsChange,
  setPanelDock, setPanelSize, type DockSide, type PanelState,
} from './state';
import { renderFilesPanel } from './files';
import { renderTerminalPanel } from './terminal';
import { renderBrowserPanel } from './browser';

let host: HTMLElement | null = null;
let dock: HTMLElement | null = null;
/** 面板内容根（.chat-shell 的兄弟；重建时只动它）。 */
let installed = false;
let dragQueued = false;
let dragState: { id: string; startX: number; startY: number; startSize: number; dock: DockSide } | null = null;

/** 面板头部（标题 + 停靠切换 + 关闭）。 */
function head(panel: PanelState): HTMLElement {
  const h = el('div', 'wb-head');
  h.appendChild(el('span', 'wb-title', panel.title));
  const dockBtn = el('button', 'wb-btn wb-dock', panel.dock === 'right' ? '⇩' : '⇨') as HTMLButtonElement;
  dockBtn.type = 'button';
  dockBtn.title = panel.dock === 'right' ? '停到底部' : '停到右侧';
  dockBtn.setAttribute('aria-label', dockBtn.title);
  dockBtn.addEventListener('click', () => setPanelDock(panel.id, panel.dock === 'right' ? 'bottom' : 'right'));
  h.appendChild(dockBtn);
  const close = el('button', 'wb-btn wb-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.title = '关闭面板';
  close.setAttribute('aria-label', '关闭面板');
  close.addEventListener('click', () => closePanel(panel.id));
  h.appendChild(close);
  // 拖动标题栏 → 按落点切换停靠边（right ↔ bottom）；rAF 节流，不逐 mousemove 写样式。
  h.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.wb-btn')) return; // 点在按钮上不拖
    startDockDrag(panel, e);
  });
  return h;
}

let dockDrag: { id: string; startDock: DockSide } | null = null;
let dockDragQueued = false;
let hintEl: HTMLElement | null = null;

function startDockDrag(panel: PanelState, e: MouseEvent): void {
  dockDrag = { id: panel.id, startDock: panel.dock };
  window.addEventListener('mousemove', onDockMove);
  window.addEventListener('mouseup', onDockEnd);
  e.preventDefault();
}

function onDockMove(e: MouseEvent): void {
  if (!dockDrag || dockDragQueued) return;
  dockDragQueued = true;
  const y = e.clientY;
  requestAnimationFrame(() => {
    dockDragQueued = false;
    if (!dockDrag || !host) return;
    const r = host.getBoundingClientRect();
    // 落点在下 1/3 ⇒ bottom；否则 right（用户原话：可拆到底部 / 右侧）。
    const target: DockSide = y > r.top + r.height * 0.66 ? 'bottom' : 'right';
    if (!hintEl) {
      hintEl = el('div', 'wb-drop-hint');
      host.appendChild(hintEl);
    }
    hintEl.className = 'wb-drop-hint ' + target;
    hintEl.textContent = target === 'bottom' ? '停到底部' : '停到右侧';
  });
}

function onDockEnd(e: MouseEvent): void {
  const drag = dockDrag;
  dockDrag = null;
  window.removeEventListener('mousemove', onDockMove);
  window.removeEventListener('mouseup', onDockEnd);
  if (hintEl) {
    hintEl.remove();
    hintEl = null;
  }
  if (!drag || !host) return;
  const r = host.getBoundingClientRect();
  const target: DockSide = e.clientY > r.top + r.height * 0.66 ? 'bottom' : 'right';
  setPanelDock(drag.id, target);
}

/** 分隔条（拖拽 resize；rAF 节流）。 */
function resizer(panel: PanelState): HTMLElement {
  const bar = el('div', 'wb-resizer ' + panel.dock);
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', panel.dock === 'right' ? 'vertical' : 'horizontal');
  bar.addEventListener('mousedown', (e) => {
    dragState = { id: panel.id, startX: e.clientX, startY: e.clientY, startSize: panel.size, dock: panel.dock };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  });
  return bar;
}

function onDragMove(e: MouseEvent): void {
  if (!dragState) return;
  const st = dragState;
  if (dragQueued) return;
  dragQueued = true;
  // rAF 节流：不逐 mousemove 直写尺寸。
  requestAnimationFrame(() => {
    dragQueued = false;
    if (!dragState) return;
    // right 面板：往左拖变大（起始 X - 当前 X）；bottom 面板：往上拖变大。
    const delta = st.dock === 'right' ? st.startX - e.clientX : st.startY - e.clientY;
    setPanelSize(st.id, st.startSize + delta);
  });
}

function onDragEnd(): void {
  dragState = null;
  window.removeEventListener('mousemove', onDragMove);
  window.removeEventListener('mouseup', onDragEnd);
}

/** 一个面板框（内容按 kind 分派）。 */
function panelBox(panel: PanelState): HTMLElement {
  const box = el('div', 'wb-panel' + (focusedPanel() === panel.id ? ' focused' : ''));
  box.dataset['panelId'] = panel.id;
  box.appendChild(head(panel));
  const body = el('div', 'wb-body');
  if (panel.kind === 'files') void renderFilesPanel(body, panel, nextSeq(panel.id), isCurrentSeq);
  else if (panel.kind === 'terminal') renderTerminalPanel(body, panel, isCurrentSeq);
  else if (panel.kind === 'browser') renderBrowserPanel(body, panel, isCurrentSeq);
  box.appendChild(body);
  box.addEventListener('mousedown', () => focusPanel(panel.id));
  return box;
}

/** 重建整个面板区（离屏构建 + 单次 replaceChildren；只动本容器）。 */
export function renderWorkbench(): void {
  if (!dock) return;
  const all = listPanels();
  const bottoms = all.filter((p) => p.dock === 'bottom');
  const rights = all.filter((p) => p.dock === 'right');
  const off = document.createElement('div');
  // bottom 区是底部一行；right 区是右侧一列（下沿让开 bottom 区高度）。
  const bottomH = bottoms.reduce((m, p) => Math.max(m, p.size), 0);
  dock.style.setProperty('--wb-bottom-h', bottomH + 'px');
  if (bottoms.length > 0) {
    const bottomZone = el('div', 'wb-zone bottom');
    for (const p of bottoms) {
      bottomZone.appendChild(resizer(p));
      const box = panelBox(p);
      box.style.height = p.size + 'px';
      box.style.flex = '1 1 0'; // 底部一行内多个面板等分宽度
      bottomZone.appendChild(box);
    }
    off.appendChild(bottomZone);
  }
  if (rights.length > 0) {
    const rightZone = el('div', 'wb-zone right');
    for (const p of rights) {
      const box = panelBox(p);
      box.style.width = p.size + 'px';
      rightZone.appendChild(box);
      rightZone.appendChild(resizer(p));
    }
    off.appendChild(rightZone);
  }
  dock.replaceChildren(...Array.from(off.childNodes));
  dock.classList.toggle('hidden', all.length === 0);
}

/** 装配（幂等）：建 .wb-host 插进 #main（.chat-shell 之后；绝对不动 #layout）。 */
export function installWorkbench(): void {
  if (installed) return;
  installed = true;
  const main = document.getElementById('main');
  if (!main) return;
  // 绝对定位在 #main 内（#main 已有 position:relative，见 rail.css）：
  // 不改 #layout 骨架、不改 #messages/.chat-shell 的父子关系（w871 断言依赖后者）。
  host = el('div', 'wb-host hidden');
  dock = el('div', 'wb-dock');
  host.appendChild(dock);
  main.appendChild(host);
  onPanelsChange(() => renderWorkbench());
  renderWorkbench();
}

/** 关闭所有面板（测试/清理用）。 */
export function workbenchPanelCount(): number {
  return listPanels().length;
}

export type { DockSide };
