// ============================================================================
// ui/messages/assistant.ts — 助手文本段（W759 从 ui/messages.ts 拆出）
//   W301：文本段增量渲染（MarkdownStream 只解析未固化尾部 + 节拍重渲染）
//   W514：渲染目标 = 会话视图容器 SessionPane，每个 AssistantView 一份流式状态
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import { highlightCode } from '../../utils/hljs';
import { MarkdownStream } from '../../utils/markdown';
import type { AssistantView, StreamDom } from '../view';
import type { SessionPane } from '../viewctx';
import { railAdd, railSync } from '../rail';
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
      stableNodes: [],
      tailNodes: [],
      lastText: '\u0000',
      inited: false,
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
  if (ctx.renderTimer !== null) {
    window.clearTimeout(ctx.renderTimer);
    ctx.renderTimer = null;
  }
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

// ---- 流式正文渲染节流 ---------------------------------------------------------
const RENDER_INTERVAL = 60; // ms —— 重渲染节拍（兼顾流畅与 CPU）

/**
 * 增量渲染文本段（W301 + W514 每容器独立节拍）：
 *   1) MarkdownStream 只解析「未固化尾部」，返回 stableHtml / tailHtml 分解；
 *   2) 新固化的块离屏构建后 append 到 content（已有块 DOM 原地保留）；
 *   3) 尾部节点离屏构建后**单次替换**（同一帧内完成，无空白帧）。
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

  if (parts.reset || !d.inited) {
    d.stableNodes = htmlToNodes(parts.stableHtml);
    d.tailNodes = htmlToNodes(parts.tailHtml);
    view.content.replaceChildren(...d.stableNodes, ...d.tailNodes);
    d.inited = true;
  } else {
    const anchor = d.tailNodes[0] ?? null;
    const place = (n: Node) => {
      if (anchor) view.content.insertBefore(n, anchor);
      else view.content.appendChild(n);
    };
    if (parts.stableDeltaHtml) {
      for (const n of htmlToNodes(parts.stableDeltaHtml)) {
        place(n);
        d.stableNodes.push(n);
      }
    }
    const freshTail = htmlToNodes(parts.tailHtml);
    for (const n of freshTail) place(n);
    for (const n of d.tailNodes) n.parentNode?.removeChild(n);
    d.tailNodes = freshTail;
  }

  highlightCode(view.content);
  autoscroll(ctx);
  railSync(ctx);
}

function scheduleTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.renderTimer !== null) return; // 已有一次节拍排队
  const wait = Math.max(0, ctx.renderDeadline + RENDER_INTERVAL - performance.now());
  ctx.renderTimer = window.setTimeout(() => {
    ctx.renderTimer = null;
    ctx.renderDeadline = performance.now();
    renderTextView(ctx, view);
  }, wait);
}

/** 立即冲刷（turn 结束 / done 事件 / 最终文本到来时调用）。 */
function flushTextView(ctx: SessionPane, view: AssistantView): void {
  if (ctx.renderTimer !== null) {
    window.clearTimeout(ctx.renderTimer);
    ctx.renderTimer = null;
  }
  ctx.renderDeadline = performance.now();
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
  autoscroll(ctx, true);
}
