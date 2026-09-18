// ============================================================================
// ui/downgrade.ts — W805：上游「图像不支持」降级状态帧的前端可见面（设计 §7.6）。
//   后端已把该次降级写进进程日志（审计）；这里补「信息块 + 一次性状态栏提示」，
//   且**绝不**把该帧当成轮次结束 —— 它的 envelope.turn=0，是进程级提示。
//   W863：同一会话容器里**至多一条**降级提示块。后端已按 (model, cause) 去重；
//   这里是前端兜底（SSE 重连重放 / 旧服务仍逐帧发）：后续帧**就地更新**该块文案，
//   只有「首次出现」或签名（model/cause/message）变化才 flash 一次 ——
//   重复帧既不再叠块，也不再闪。
// ============================================================================
import { downgradeNotice } from './attachments';
import { renderInfoBlock, updateInfoBlock } from './messages';
import { flashStatus } from './statusbar';
import { isActivePane, type SessionPane } from './viewctx';
import type { StatusPayload } from '../types';

/** 降级提示块的定位 class：作用域 = ctx.el 自己的子树，会话之间天然隔离。 */
const BLOCK_SELECTOR = '.msg.info.downgrade';

/**
 * W863：flash 门控签名 —— 文案（model/cause/message）变了才算「新提示」。
 * `cause` 由服务端降级帧携带，但 apps/web/src/types.ts 有模块体积棘轮（只许降
 * 不许升），所以这里结构化读取，不给它加行数（先例见 api.ts 的 W858 注释）。
 */
function signatureOf(p: StatusPayload): string {
  const cause = (p as { cause?: unknown }).cause;
  return [p.model ?? '', typeof cause === 'string' ? cause : '', p.message ?? ''].join('\u0000');
}

/** 该会话容器里已有的降级块（没有 = null）。历史恢复 replaceChildren 后自然为 null。 */
function existingBlock(ctx: SessionPane): HTMLElement | null {
  return ctx.el.querySelector<HTMLElement>(BLOCK_SELECTOR);
}

export function renderImageDowngrade(ctx: SessionPane, p: StatusPayload): void {
  const text = downgradeNotice(p);
  const headline = text.split('\n')[0] ?? text;
  const signature = signatureOf(p);
  const existing = existingBlock(ctx);
  if (existing) {
    updateInfoBlock(existing, text);
    if (existing.dataset.downgradeSig === signature) return; // 重复帧：只改文案、不 flash
    existing.dataset.downgradeSig = signature;
  } else {
    const block = renderInfoBlock(ctx, text, 'err', 'downgrade');
    if (block === null) return;
    block.dataset.downgradeSig = signature;
  }
  if (isActivePane(ctx)) flashStatus(headline, 'err', 6000);
}
