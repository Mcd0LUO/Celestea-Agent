// ============================================================================
// ui/messages/scroll.ts — 滚动与空态提示（W759 从 ui/messages.ts 拆出）
//   autoscroll()      粘性自动滚动（按会话容器）
//   hideEmptyHint()   隐藏空地提示
//   renderEmptyHint() 重建空地提示（容器级）
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el } from '../../utils/dom';
import type { SessionPane } from '../viewctx';

// ---- scrolling ----------------------------------------------------------------
/**
 * 粘性自动滚动：仅在用户接近底部时跟随；force 用于完成/新消息时。
 * W514：只作用于该会话自己的容器；后台（隐藏）容器不写布局——只记录
 * 「期望贴底」，切回时由 viewctx 恢复滚动位。
 */
export function autoscroll(ctx: SessionPane, force = false): void {
  if (ctx.el.hidden) {
    if (force) ctx.stickBottom = true;
    return;
  }
  const nearBottom = ctx.el.scrollTop + ctx.el.clientHeight >= ctx.el.scrollHeight - 200;
  if (force || nearBottom) ctx.el.scrollTop = ctx.el.scrollHeight;
}

export function hideEmptyHint(ctx: SessionPane): void {
  ctx.hint.classList.add('hidden');
}

/** Rebuild the empty state exactly as it shipped in index.html（容器级）。 */
export function renderEmptyHint(ctx: SessionPane): void {
  ctx.el.replaceChildren();
  const hint = el('div', 'empty-hint empty-hint-fresh');
  hint.appendChild(el('div', 'empty-mark', '◇'));
  hint.appendChild(el('div', 'empty-title', 'Celestea Studio'));
  hint.appendChild(
    el('div', 'empty-sub', '在下方输入消息开始对话 · Enter 发送 · Shift+Enter 换行'),
  );
  ctx.el.appendChild(hint);
  ctx.hint = hint;
}
