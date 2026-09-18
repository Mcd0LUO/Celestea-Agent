// ============================================================================
// ui/downgrade.ts — W805：上游「图像不支持」降级状态帧的前端可见面（设计 §7.6）。
//   后端已把该次降级写进进程日志（审计）；这里补「信息块 + 一次性状态栏提示」，
//   且**绝不**把该帧当成轮次结束 —— 它的 envelope.turn=0，是进程级提示。
// ============================================================================
import { downgradeNotice } from './attachments';
import { renderInfoBlock } from './messages';
import { flashStatus } from './statusbar';
import { isActivePane, type SessionPane } from './viewctx';
import type { StatusPayload } from '../types';

export function renderImageDowngrade(ctx: SessionPane, p: StatusPayload): void {
  const text = downgradeNotice(p);
  const headline = text.split('\n')[0] ?? text;
  renderInfoBlock(ctx, text, 'err');
  if (isActivePane(ctx)) flashStatus(headline, 'err', 6000);
}
