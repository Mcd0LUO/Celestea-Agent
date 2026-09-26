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
/**
 * 悬停停留阈值**缺省值**（沿用 rail 已验证的 150ms；原生 title 约 1s）。
 * W9106：这是缺省，不是全站唯一值 —— 提供者可以按 handle/自身覆盖它
 * （见 ./registry.ts 的 delayMs 与 ui/rail.ts 的 railHintPlugin：条带预览 = 0）。
 */
export const HINT_DELAY_MS = 150;
const EDGE = 8;
const GAP = 12;

// W871：宿主 = document.body（全站定位基准）。卡片 position:fixed（hint.css），
// 故 style.left/top 与 getBoundingClientRect() 同坐标系 = 视口坐标。
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
  clearTimer(); // 换目标：旧的停留计时一律作废（不留悬挂的旧计时）
  hovered = target;
  if (!target) {
    cancel();
    return;
  }
  const text = target.getAttribute(HINT_ATTR) ?? '';
  const handle = resolveHint(target, text);
  if (!handle) {
    cancel(); // 无提供者：撤掉上一张卡，交给原生 title（不是本引擎的活）
    return;
  }
  if (target.hasAttribute('title')) target.removeAttribute('title');
  if (hintDelayOf(handle) <= 0) {
    show(target); // W9106：零停留（rail 预览）—— 当帧就弹；已有卡则**就地换内容**
    return;
  }
  // 有停留（缺省 150ms 的密集控件）：换目标必须撤掉上一张卡再重新计时 —— 否则旧卡
  // 会带着旧内容留在屏幕上等新计时结束（「扫过不弹」的既有手感，逐字不变）。
  cancel();
  timer = window.setTimeout(() => {
    timer = null;
    show(target);
  }, hintDelayOf(handle));
}

/**
 * W9106：生效的停留阈值（handle 级 > provider 级 > 引擎缺省，provider 级已由
 * registry 的 resolveHint 合并进 handle）。非有限 / 负数一律回落到缺省 —— 提供者
 * 写坏一个数字不该让提示永不出现（0 是**合法**值：立即弹，由调用点显式表达）。
 */
function hintDelayOf(handle: HintHandle): number {
  const d = handle.delayMs;
  return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : HINT_DELAY_MS;
}

/** 立即撤卡（离开 / Esc / 滚动 / 尺寸变化 / 宿主主动收）。 */
export function hideHint(): void {
  cancel();
  hovered = null;
}

/** 作废停留计时（不动已挂的卡）。 */
function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

/** 立即撤卡但保留悬停指针（内容变化时重建用）。 */
function cancel(): void {
  clearTimer();
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
  // W9106：**就地换内容**（条带内从 A 条滑到 B 条，或同一锚点的文案变了）—— 旧卡节点
  // 被新节点原子替换（一次 replaceWith），中间没有「卡已摘、新卡未挂」的空窗；撤卡再建
  // 会让卡片闪一下、把落位从上一帧甩到新位置，用户看到的就不是「就地更新」。
  clearTimer(); // 卡已经画出来了：不再需要任何停留计时
  const prev = card;
  hovered = target;
  card = built;
  card.classList.add('hint-card');
  card.setAttribute('role', 'tooltip');
  // W871：宿主 = document.body + 卡片 position: fixed（见 place() 的坐标口径）。
  //   旧实现把卡片挂进 #main，再用「锚点 rect − 宿主 rect」算相对坐标 —— 那只在
  //   「锚点落在 #main 内」时成立。会话树在**侧栏**里（#main 之外），实测锚点行
  //   在 (12, 218.94)–(303, 249.56)、#main 从 322 起 ⇒ a.left − h.left = −310 < 0，
  //   卡片被夹到 EDGE=8 后画在 (330, 255.56)：横向落在主区、纵向骑在行外，
  //   用户看到的就是「提示错位」（fly out）。改成全站定位基准后侧栏与主区同坐标系。
  if (!host || !host.isConnected) host = document.body;
  if (prev && prev.parentNode) prev.replaceWith(card);
  else host.appendChild(card);
  // W9106：instant（delay ≤ 0）的卡**不播入场动画** —— 卡要在指针移动的同一帧出现，
  // 0.14s 的淡入会让「几乎立即」在观感上打回去（真机 CDP 量的是 DOM 出现时刻，
  // 但用户看的是动画）。见 styles/hint.css 的 .hint-card-instant。
  if (hintDelayOf(handle) <= 0) card.classList.add('hint-card-instant');
  place(card, target, handle);
}

/** 缺省落位：锚点右下 GAP；越界则左/上回退，永不出视口。 */
function place(box: HTMLElement, anchor: HTMLElement, handle: HintHandle): void {
  if (!host) return;
  if (handle.position) {
    handle.position(box, anchor);
    return;
  }
  // W871：宿主 = document.body（初始包含块）⇒ position:fixed（hint.css）下
  //   style.left/top 与 getBoundingClientRect() **同为视口坐标**，可以直接写锚点的
  //   rect，不必也不该再减宿主 rect（页面有滚动时那套相对坐标会漂）。
  //   先例：ui/grants/panel/position.ts 的盾牌面板（fixed + rect 现算）。
  const a = anchor.getBoundingClientRect();
  const w = box.offsetWidth || 0;
  const bh = box.offsetHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = a.left + GAP;
  let top = a.bottom + 6;
  if (w > 0 && left + w > vw - EDGE) left = a.right - w; // 右越界 → 右缘回退到锚点右缘
  if (bh > 0 && top + bh > vh - EDGE) top = a.top - bh - 6; // 下越界 → 翻到锚点上方
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
  host = document.body; // W871：全站定位基准（侧栏锚点也在同一坐标系里）
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
