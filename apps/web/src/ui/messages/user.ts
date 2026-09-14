// ============================================================================
// ui/messages/user.ts — 用户侧消息（W759 从 ui/messages.ts 拆出）
//   W515 转录条目分类（user / steering / queued）与 inbox 条目（系统注入 /
//   worker 回执）；车道文案 laneLabel。
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import type { SessionPane } from '../viewctx';
import { railAdd, railSync } from '../rail';
import { autoscroll, hideEmptyHint } from './scroll';

// ---- message builders ----------------------------------------------------------

/**
 * W515 转录条目分类（对齐 DSH 的 user / steering / inbox）：
 *   user     —— 普通用户消息（聚焦会话空闲时发送，开新轮）
 *   steering —— 插话（运行中注入：DSH inbox 的 next-step 车道，最近 step 边界送达）
 *   queued   —— 排队（运行中提交、本轮结束后作为下一回合投递：next-turn 车道）
 *   inbox    —— 系统注入 / worker 回执（非用户输入，只读展示）
 */
export type MsgKind = 'user' | 'steering' | 'queued';

const USER_CAPTION: Record<MsgKind, string> = {
  user: '你',
  steering: '插话',
  queued: '排队',
};

/**
 * 用户侧消息（普通 / 插话 / 排队）。三类在样式与标题前缀上可区分，
 * 绝不与普通用户消息混同（W515 要求）。
 */
export function addUserMessage(
  ctx: SessionPane,
  text: string,
  opts?: { kind?: MsgKind; into?: HTMLElement },
): HTMLElement {
  const kind: MsgKind = opts?.kind ?? 'user';
  const target = opts?.into ?? ctx.el;
  if (target === ctx.el) hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const cls = kind === 'user' ? 'msg user' : 'msg user ' + kind + ' interject';
  const msg = el('div', cls);
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', USER_CAPTION[kind]));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble');
  const body = el('div', 'content');
  body.textContent = text;
  body.style.whiteSpace = 'pre-wrap';
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  railAdd(ctx, col, kind === 'user' ? 'user' : 'interject');
  if (target === ctx.el) {
    railSync(ctx);
    autoscroll(ctx, true);
  }
  return col;
}

/**
 * inbox 条目（W515）：系统注入 / worker 回执等非用户输入，独立样式与
 * 「回执/系统」前缀，避免与用户消息或系统 info 块混同。
 * source 用于前缀（如 worker id）；缺省 → 「系统」。
 */
export function renderInboxMessage(
  ctx: SessionPane,
  text: string,
  opts?: { source?: string; target?: string; into?: HTMLElement },
): HTMLElement {
  const target = opts?.into ?? ctx.el;
  if (target === ctx.el) hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const msg = el('div', 'msg inbox');
  const cap = el('div', 'msg-caption');
  const src = (opts?.source ?? '').trim();
  cap.appendChild(el('span', 'who', src === '' ? '系统' : '回执 · ' + src));
  if (opts?.target) cap.appendChild(el('span', 'inbox-lane', laneLabel(opts.target)));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble inbox-bubble');
  const body = el('div', 'content inbox-content');
  body.textContent = text;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  target.appendChild(col);
  if (target === ctx.el) {
    railSync(ctx);
    autoscroll(ctx, true);
  }
  return col;
}

/** DSH InboxTarget → 展示文案（缺省/未知车道 → 空）。 */
export function laneLabel(target: string): string {
  if (target === 'next-step') return '下一步送达';
  if (target === 'next-turn') return '下一回合送达';
  return '';
}
