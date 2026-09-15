// ============================================================================
// ui/hint/card.ts — 悬浮提示**引擎**（W790 · item 4）
// ----------------------------------------------------------------------------
// 一套悬停意图 + 一张共享卡片，取代原先并存的两套：
//   · 原生 title（render.ts / live.ts / rail.ts，约 1s 延迟、无法控样式）；
//   · ui/rail.ts 自制卡片（PREVIEW_MS = 150，自建 DOM + 自管定时器 + 自落位）。
// 现在两者都走这里：延迟 150ms（沿用 rail 已验证的阈值）、卡片宿主唯一、
// 内容由注册的提供者（见 ./registry.ts）构建，本模块不认识任何业务元素。
//
// 交互（全部事件委托到 document 捕获阶段，绝不逐节点绑监听 → 铁律 6）：
//   pointerover  → 进入带 data-hint 的元素（更近的子元素自带 title 则让位）
//   pointerout   → 指针离开该元素即撤卡
//   focusin/out  → 键盘可达同样给提示；Esc / pointerdown / 滚动 / 尺寸变化即撤卡
// 宿主自算命中区的场景（rail 轨道是 pointer-events:none）用 hoverHint(el) 直驱。
// ============================================================================
import { resolveHint, type HintHandle } from './registry';

/** 提示文本挂在这个属性上（提供者只认属性、不认业务类名）。 */
export const HINT_ATTR = 'data-hint';
/** 悬停停留阈值（沿用 rail 已验证的 150ms；原生 title 约 1s）。 */
export const HINT_DELAY_MS = 150;
const EDGE = 8;
const GAP = 12;

let host: HTMLElement | null = null;
let card: HTMLElement | null = null;
let timer: number | null = null;
let hovered: HTMLElement | null = null;
let mounted = false;

/** 登记/更新一个元素的提示文本（null = 撤掉提示）。只改属性，不碰 DOM 结构。 */
export function setHint(target: HTMLElement, text: string | null): void {
  if (!text) {
    target.removeAttribute(HINT_ATTR);
    if (target.title) target.removeAttribute('title');
    return;
  }
  target.setAttribute(HINT_ATTR, text);
  // 有人认领 → 由卡片表达（清掉原生 title，避免 1s 后双弹）；无人认领 → 原生 title 兜底。
  if (resolveHint(target, text)) target.removeAttribute('title');
  else target.title = text;
  if (hovered === target && card) show(target);
}

/** 直接驱动悬停意图（自算命中区的宿主用，例如 rail 的 fisheye 轨道）。 */
export function hoverHint(target: HTMLElement | null): void {
  if (target === hovered) return;
  cancel();
  hovered = target;
  if (!target) return;
  const text = target.getAttribute(HINT_ATTR) ?? '';
  const handle = resolveHint(target, text);
  if (!handle) return; // 无提供者：交给原生 title（不是本引擎的活）
  if (target.hasAttribute('title')) target.removeAttribute('title');
  timer = window.setTimeout(() => {
    timer = null;
    show(target);
  }, HINT_DELAY_MS);
}

/** 立即撤卡（离开 / Esc / 滚动 / 尺寸变化 / 宿主主动收）。 */
export function hideHint(): void {
  cancel();
  hovered = null;
}

/** 立即撤卡但保留悬停指针（内容变化时重建用）。 */
function cancel(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (card) {
    card.remove();
    card = null;
  }
}

/** 当前卡片（诊断/测试用：null = 没弹）。 */
export function hintCardEl(): HTMLElement | null {
  return card;
}

function show(target: HTMLElement): void {
  if (target !== hovered) return; // 迟到：指针已移开
  const handle = resolveHint(target, target.getAttribute(HINT_ATTR) ?? '');
  if (!handle) return;
  const built = handle.build();
  if (!built) return;
  cancel();
  hovered = target;
  card = built;
  card.classList.add('hint-card');
  card.setAttribute('role', 'tooltip');
  if (!host || !host.isConnected) host = document.getElementById('main') ?? document.body;
  host.appendChild(card);
  place(card, target, handle);
}

/** 缺省落位：锚点右下 GAP；越界则左/上回退，永不出宿主。 */
function place(box: HTMLElement, anchor: HTMLElement, handle: HintHandle): void {
  if (!host) return;
  if (handle.position) {
    handle.position(box, anchor);
    return;
  }
  const a = anchor.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  const w = box.offsetWidth || 0;
  const bh = box.offsetHeight || 0;
  let left = a.left - h.left + GAP;
  let top = a.bottom - h.top + 6;
  if (w > 0 && left + w > h.width - EDGE) left = Math.max(EDGE, a.right - h.left - w);
  if (bh > 0 && top + bh > h.height - EDGE) top = Math.max(EDGE, a.top - h.top - bh - 6);
  box.style.left = Math.max(EDGE, left) + 'px';
  box.style.top = Math.max(EDGE, top) + 'px';
}

/** 委托取目标：最近的 [data-hint] 祖先；中途遇到自带原生 title 的子元素则让位。 */
function claimTarget(node: EventTarget | null): HTMLElement | null {
  let n: Element | null = node instanceof Element ? node : null;
  while (n) {
    if (n.hasAttribute(HINT_ATTR)) return n as HTMLElement;
    if (n.hasAttribute('title')) return null;
    n = n.parentElement;
  }
  return null;
}

function onOver(e: Event): void {
  hoverHint(claimTarget(e.target));
}

function onOut(e: Event): void {
  const rel = (e as PointerEvent).relatedTarget;
  if (hovered && rel instanceof Node && hovered.contains(rel)) return;
  hideHint();
}

function onFocusIn(e: Event): void {
  const t = claimTarget(e.target);
  if (t) {
    hovered = null; // 键盘路径直接弹，不等停留
    hoverHint(t);
    show(t);
  }
}

/** 挂载引擎（幂等；main.ts 在 DOM 就绪后调用一次）。 */
export function mountHints(): void {
  if (mounted) return;
  mounted = true;
  host = document.getElementById('main') ?? document.body;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', hideHint, true);
  document.addEventListener('pointerdown', hideHint, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', hideHint, true);
  window.addEventListener('resize', hideHint);
  window.addEventListener('blur', hideHint);
}

function onKey(e: Event): void {
  if ((e as KeyboardEvent).key === 'Escape') hideHint();
}

/** 已挂载？（测试/诊断） */
export function hintsMounted(): boolean {
  return mounted;
}
