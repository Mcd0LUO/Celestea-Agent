// ============================================================================
// ui/quote/select.ts — F1 选段提及：**选区检测 + 浮动「引用」按钮**。
// ----------------------------------------------------------------------------
// 挂 document 级监听（零逐节点绑定）：
//   mouseup        → 选区落定后判定并显示浮标
//   selectionchange→ 选区折叠即收起（浮标自身交互期间不收起，见 interacting）
//   pointerdown(capture) → 点别处收起；点浮标自身放行
//   scroll(capture) / resize → 收起（含 .sess-pane 自身滚动）
//   Esc            → 经 utils/overlays 的层级栈，只关浮标这一层
// 判定：当前聚焦会话内 + 同一 .mcol + 命中 .content/.tool-out/.think-seg-body +
//   **不在 composer（#inputbar / textarea / input）**。
// 只存「选区字符串 + 来源元数据」，**不持有 Range**（流式 .content 每 tick replaceChildren）。
// 浮标落位复用 ui/grants/geom 的 panelGeom（右对齐锚点、贴上沿；minHeight=0，不写 maxHeight）。
// ============================================================================
import { activePane } from '../viewctx';
import { panelGeom } from '../grants/geom';
import { popOverlay, pushOverlay, type OverlayHandle } from '../../utils/overlays';
import { flashStatus } from '../statusbar';
import { addQuote, type AddQuoteResult } from './tray';
import type { QuoteFormat, QuoteKind, QuoteSource } from './model';

interface PendingSel {
  text: string;
  source: QuoteSource;
  format: QuoteFormat;
}

let installed = false;
let floatEl: HTMLButtonElement | null = null;
let overlay: OverlayHandle | null = null;
let pending: PendingSel | null = null;
let interacting = false;

function closestEl(node: Node | null, sel: string): Element | null {
  if (node === null) return null;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return el ? el.closest(sel) : null;
}

/** composer 自身选区必须排除（会自我引用）。 */
function insideComposer(node: Node): boolean {
  return closestEl(node, '#inputbar') !== null || closestEl(node, 'textarea, input') !== null;
}

function kindOf(col: Element): QuoteKind {
  const msg = col.querySelector('.msg');
  const cls = msg ? msg.className : '';
  if (cls.includes('user')) return 'user';
  if (cls.includes('tool')) return 'tool';
  if (cls.includes('inbox')) return 'inbox';
  return 'assistant';
}

function labelOf(col: Element, kind: QuoteKind): string {
  if (kind === 'assistant') return 'Studio';
  if (kind === 'inbox') return '系统';
  if (kind === 'tool') {
    const name = col.querySelector('.toolcard-name')?.textContent ?? '';
    return name === '' ? '工具' : '工具 ' + name;
  }
  return col.querySelector('.msg-caption .who')?.textContent ?? '你';
}

/** 轮次 = 该 .mcol 之前（含自身）的用户消息数；取不到则 undefined。 */
function turnOf(paneEl: Element, col: Element): number | undefined {
  let n = 0;
  for (const c of Array.from(paneEl.querySelectorAll('.mcol'))) {
    if (c.querySelector('.msg.user')) n += 1;
    if (c === col) break;
  }
  return n > 0 ? n : undefined;
}

function buildSource(pane: { id: string; el: HTMLElement }, col: Element): QuoteSource {
  const kind = kindOf(col);
  return { kind, session: pane.id, turn: turnOf(pane.el, col), label: labelOf(col, kind) };
}

function hideFloat(): void {
  if (floatEl) floatEl.classList.add('hidden');
  pending = null;
  interacting = false;
  if (overlay !== null) {
    popOverlay(overlay);
    overlay = null;
  }
}

function showFloat(rect: { top: number; right: number; bottom: number; left: number; width: number; height: number }): void {
  if (!floatEl) return;
  floatEl.classList.remove('hidden');
  const g = panelGeom({
    anchor: rect,
    panel: { width: floatEl.offsetWidth || 48, height: floatEl.offsetHeight || 24 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gap: 6,
    minHeight: 0,
  });
  floatEl.style.top = g.top + 'px';
  floatEl.style.left = g.left + 'px';
  if (overlay === null) overlay = pushOverlay(hideFloat);
}

function onMouseUp(e: Event): void {
  if (floatEl && e.target instanceof Node && floatEl.contains(e.target)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideFloat();
    return;
  }
  const range = sel.getRangeAt(0);
  const text = sel.toString();
  const pane = activePane();
  const node = range.commonAncestorContainer;
  if (text.trim() === '' || !pane || !pane.el.contains(node) || insideComposer(node)) {
    hideFloat();
    return;
  }
  const startCol = closestEl(range.startContainer, '.mcol');
  const endCol = closestEl(range.endContainer, '.mcol');
  if (!startCol || startCol !== endCol) {
    hideFloat();
    return;
  }
  if (!closestEl(node, '.content, .tool-out, .think-seg-body')) {
    hideFloat();
    return;
  }
  pending = { text, source: buildSource(pane, startCol), format: closestEl(node, 'pre, code') ? 'code' : 'text' };
  showFloat(range.getBoundingClientRect());
}

function onSelChange(): void {
  if (interacting) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) hideFloat();
}

function onPointerDown(e: Event): void {
  if (floatEl && e.target instanceof Node && floatEl.contains(e.target)) {
    interacting = true;
    return;
  }
  hideFloat();
}

function onFloatClick(): void {
  const sel = pending;
  hideFloat();
  if (!sel) return;
  void addQuote(sel).then((res: AddQuoteResult) => {
    if (res === 'full') flashStatus('引用已达上限（最多 8 条）', 'err', 4000);
    else if (res === 'duplicate') flashStatus('这段已经引用过了', 'ok', 3000);
  });
}

/** 装配（幂等；main.ts 在 viewctx 之后调用一次）。 */
export function installQuoteSelection(): void {
  if (installed) return;
  installed = true;
  floatEl = document.createElement('button');
  floatEl.type = 'button';
  floatEl.className = 'quote-float hidden';
  floatEl.textContent = '引用';
  floatEl.title = '把选中的内容作为引用加入下一条消息';
  floatEl.setAttribute('aria-label', '引用选中的内容');
  floatEl.addEventListener('click', onFloatClick);
  document.body.appendChild(floatEl);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('selectionchange', onSelChange);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('scroll', hideFloat, true);
  window.addEventListener('resize', hideFloat);
}
