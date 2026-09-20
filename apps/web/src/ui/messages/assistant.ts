// ============================================================================
// ui/messages/assistant.ts — 助手文本段（W759 从 ui/messages.ts 拆出）
//   W301：文本段增量渲染（MarkdownStream 只解析未固化尾部 + 节拍重渲染）
//   W514：渲染目标 = 会话视图容器 SessionPane，每个 AssistantView 一份流式状态
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import { MarkdownStream } from '../../utils/markdown';
import type { AssistantView, StreamDom } from '../view';
import type { SessionPane } from '../viewctx';
import { railAdd, railSync } from '../rail';
import { runEnhancers } from '../enhance';
import { htmlToNodes } from './markdown';
import { autoscroll, hideEmptyHint, renderEmptyHint } from './scroll';

// ---- 文本段增量渲染器（W301） ---------------------------------------------------
/** 每个 AssistantView 一份流式渲染状态（WeakMap 挂载，不改 view.ts 公共接口）。 */
const doms = new WeakMap<AssistantView, StreamDom>();

function domOf(view: AssistantView): StreamDom {
  let d = doms.get(view);
  if (!d) {
    d = {
      stream: new MarkdownStream(),
      boundary: document.createComment('w895-boundary'),
      lastText: '\u0000',
    };
    doms.set(view, d);
  }
  return d;
}

/** 助手文本段是否已有内容（占位判定）。 */
export function assistantHasContent(view: AssistantView): boolean {
  return view.text.trim() !== '' || view.content.childElementCount > 0;
}

/** 直接移除空占位助手气泡（不渲染空块）。 */
export function removeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.root.remove();
  doms.delete(view);
  if (ctx.assistant === view) ctx.assistant = null;
}

/** 清空该会话消息流并重建空态（/api/clear 成功后调用；同时重置流式状态）。 */
export function resetMessages(ctx: SessionPane): void {
  if (ctx.render.timer !== null) {
    window.clearTimeout(ctx.render.timer);
    ctx.render.timer = null;
  }
  ctx.render.deadline = Number.NEGATIVE_INFINITY; // W867：清空后第一帧同样立即渲染
  if (ctx.assistant) doms.delete(ctx.assistant);
  ctx.assistant = null;
  ctx.turn = null;
  ctx.thinkSeg = null;
  ctx.lastTextCol = null;
  ctx.interjectNote = null;
  ctx.ops.clear();
  ctx.step = 0;
  renderEmptyHint(ctx);
}

// ---- 流式正文渲染节拍（W867：近似立即 + 短 debounce 合并） ----------------------
/**
 * 合并窗口（ms，≈1 帧）。语义 = leading 立即 + trailing 合并：
 *   · 距上次渲染已过窗口（首次 / 空闲后的第一帧）→ **同一调用栈内立即渲染**，事件到达
 *     即出字，不再等一个 60ms 节拍（旧口径在流式与快速切换时明显发顿，用户 6②）；
 *   · 同一窗口内的连续增量 → 并成一次尾部渲染，绝不逐字节重排。
 */
export const RENDER_DEBOUNCE = 12;

/**
 * 渲染文本段（W301 + W514 每容器独立节拍）—— **实时与重放走同一个函数、同一条分支**。
 *
 * W895-R：分区用**边界哨兵**而不是节点引用记账（见 view.ts 的 StreamDom 注释）。
 *   1) MarkdownStream 只解析「未固化尾部」，返回 stableHtml / tailHtml 分解；
 *   2) 新固化的块插到边界**之前**（已有块 DOM 原地保留，不重建）；
 *   3) 尾部区 = 边界**之后**的全部节点，整体替换（同一帧内完成，无空白帧）。
 *
 * 重放只是「文本已完整」的一次调用：此时 stable 已是全量、tailHtml 为空，
 * 走的仍是这条路径 —— 没有「只有重放才走」的分支，两者因此不可能分叉。
 */
function renderTextView(ctx: SessionPane, view: AssistantView): void {
  const d = domOf(view);
  if (d.lastText === view.text) {
    autoscroll(ctx);
    railSync(ctx);
    return;
  }
  const parts = d.stream.updateParts(view.text);
  d.lastText = view.text;

  // 边界必须是 content 的子节点：首次渲染挂上，或在 reset 后（容器被别处清过）重新挂。
  if (d.boundary.parentNode !== view.content) view.content.appendChild(d.boundary);

  // (2) 新增的稳定块插到边界之前。reset 时 stableDeltaHtml 是**全量** stable，
  //     所以这里天然覆盖「整体重建」，不需要另一条分支。
  // ★ 用 DocumentFragment 一次性插入（每 tick 至多 1 次 DOM 变更）：
  //   W867 的门禁按「.content 上的变更调用次数」计重排，逐节点插入会把
  //   一次合并渲染变成 N 次 —— 那是真实的性能回退，不是测试口径问题。
  if (parts.reset || parts.stableDeltaHtml) {
    const stableHtml = parts.reset ? parts.stableHtml : parts.stableDeltaHtml;
    const frag = document.createDocumentFragment();
    for (const n of htmlToNodes(stableHtml)) frag.appendChild(n);
    view.content.insertBefore(frag, d.boundary);
  }

  // (3) 尾部区整体替换：删掉边界之后的一切，再按文档序插回（同样用 fragment）。
  for (let n = d.boundary.nextSibling; n !== null; ) {
    const next = n.nextSibling;
    n.remove();
    n = next;
  }
  const tailFrag = document.createDocumentFragment();
  for (const n of htmlToNodes(parts.tailHtml)) tailFrag.appendChild(n);
  view.content.appendChild(tailFrag);

  // W895：渲染后的增强遍走注册缝（内置 hljs + math 仍在此链上，顺序不变）。
  runEnhancers(view.content);
  autoscrollView(ctx, view); // W867：离屏（历史恢复）不写滚动位
  railSync(ctx);
}

function scheduleTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.render.timer !== null) return; // 已有一次尾部渲染排队（窗口内的增量都并进它）
  const now = performance.now();
  const wait = Math.max(0, ctx.render.deadline + RENDER_DEBOUNCE - now);
  if (wait === 0) {
    ctx.render.deadline = now;
    renderTextView(ctx, view); // leading：立即渲染（不再等定时器）
    return;
  }
  ctx.render.timer = window.setTimeout(() => {
    ctx.render.timer = null;
    ctx.render.deadline = performance.now();
    renderTextView(ctx, view);
  }, wait);
}

/**
 * W867：只有**已挂载**的气泡才需要跟随滚动。历史恢复在离屏容器里构建（restore.ts 的
 * off），逐条写 scrollTop 是纯浪费（200 条 ≈ 200 次强制布局 + 无效写）；恢复末尾
 * restoreSessionHistory 自己会 autoscroll(ctx, true) 贴底一次，观感不变。
 * 用 `=== false` 判定（而不是 `!isConnected`）：DOM 垫片没有该属性时行为与改动前一致。
 */
function autoscrollView(ctx: SessionPane, view: AssistantView, force = false): void {
  if (view.root.isConnected === false) return;
  autoscroll(ctx, force);
}

/** 立即冲刷（turn 结束 / done 事件 / 最终文本到来时调用）。 */
function flushTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.render.timer !== null) {
    window.clearTimeout(ctx.render.timer);
    ctx.render.timer = null;
  }
  ctx.render.deadline = performance.now();
  renderTextView(ctx, view);
}

/** 增量追加正文 delta（节拍渲染，不逐字重排）。 */
export function appendText(ctx: SessionPane, view: AssistantView, delta: string): void {
  view.text += delta || '';
  scheduleTextView(ctx, view);
}

/** Sync final assistant text from the done event. */
export function applyFinalText(ctx: SessionPane, view: AssistantView, text: string): void {
  if (typeof text !== 'string' || !text || view.text === text) return;
  view.text = text;
  flushTextView(ctx, view);
}

/** 冻结当前文本段：有内容则收尾为完整气泡，并解除当前段。 */
export function flushTextSegment(ctx: SessionPane): void {
  const a = ctx.assistant;
  if (!a) return;
  ctx.assistant = null;
  if (assistantHasContent(a)) {
    a.bubble.classList.remove('streaming');
    a.bubble.classList.add('complete');
    flushTextView(ctx, a);
    autoscroll(ctx, true);
  } else {
    a.root.remove(); // 空占位不渲染
    doms.delete(a);
  }
}

/** 获取当前文本段视图或创建新的流式文本气泡（容器 = 该会话的视图）。 */
export function ensureAssistant(ctx: SessionPane, into?: HTMLElement): AssistantView {
  const target = into ?? ctx.el;
  if (target === ctx.el) {
    if (ctx.assistant) return ctx.assistant;
    hideEmptyHint(ctx);
  }
  const col = el('div', 'mcol');
  const msg = el('div', 'msg assistant');
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', 'Studio'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble streaming');
  const content = el('div', 'content');
  bubble.appendChild(content);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  railAdd(ctx, col, 'assistant');
  if (target === ctx.el) railSync(ctx);

  // think/cards 字段为类型兼容保留（不挂载；thinking/工具卡均独立成段）
  const view: AssistantView = {
    root: msg,
    bubble,
    think: document.createElement('details'),
    thinkBody: document.createElement('div'),
    thinkTime: document.createElement('span'),
    cards: document.createElement('div'),
    content,
    text: '',
    thinkText: '',
    ops: new Map(),
    steps: 0,
  };
  if (target === ctx.el) {
    ctx.lastTextCol = col; // 同轮最近文本段（thinking 重排锚点）
    ctx.assistant = view;
    autoscroll(ctx, true);
  }
  return view;
}

/** 文本段收尾（turn 结束 / done 冲刷）。 */
export function finalizeAssistant(ctx: SessionPane, view: AssistantView): void {
  view.bubble.classList.remove('streaming');
  view.bubble.classList.add('complete');
  flushTextView(ctx, view);
  autoscrollView(ctx, view, true); // W867：离屏（历史恢复）不写滚动位
}
