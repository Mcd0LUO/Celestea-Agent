// ============================================================================
// ui/messages/user.ts — 用户侧消息（W759 从 ui/messages.ts 拆出）
//   W515 转录条目分类（user / steering / queued）与 inbox 条目（系统注入 /
//   worker 回执）；车道文案 laneLabel。
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, esc, fmtNow } from '../../utils/dom';
import { sanitizeNodes } from '../../utils/sanitize';
import type { SessionPane } from '../viewctx';
import type { QuoteRef } from '../quote/model';
import { railAdd, railSync } from '../rail';
import { autoscroll, hideEmptyHint } from './scroll';
import { renderAttachmentGrid, type AttachmentView } from '../attachments';

/** F1：引用卡 —— 正文不可信，经 esc + sanitizeNodes 进 DOM（绝不 innerHTML）。 */
function quoteBlockEl(q: QuoteRef): HTMLElement {
  const label = q.source.label + (q.truncated ? ' · 已截断' : '');
  const html =
    '<div class="quote-head"><span class="quote-src">' + esc(label) + '</span></div>' +
    '<div class="quote-body">' + esc(q.text) + '</div>';
  const wrap = el('div', 'quote-block');
  wrap.replaceChildren(...sanitizeNodes(html));
  return wrap;
}

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
  opts?: { kind?: MsgKind; into?: HTMLElement; attachments?: AttachmentView[]; quotes?: readonly QuoteRef[] },
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
  for (const q of opts?.quotes ?? []) bubble.appendChild(quoteBlockEl(q)); // 引用卡在正文之上
  const body = el('div', 'content');
  body.textContent = text;
  body.style.whiteSpace = 'pre-wrap';
  bubble.appendChild(body);
  // W805：文本下方渲染附件网格（live 有缩略图；历史只有元数据，见设计 §7.4）。
  const atts = opts?.attachments ?? [];
  if (atts.length > 0) bubble.appendChild(renderAttachmentGrid(atts));
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
 * W888：注入行的 origin -> 块标题 + 默认是否折叠。
 *
 * 折叠默认值的理由：
 *   · 记忆 / 技能目录是**每轮都注入**的大块背景（可能数百行），默认展开会把
 *     对话淹没，所以默认折叠（`skill`/`memory`）；
 *   · 回执 / 插话 / 压缩摘要是**一次性、给人看的事件**，默认展开（`receipt`
 *     /`steering`/`compact`），否则用户会以为它没发生。
 */
const INBOX_KIND: Record<string, { title: string; collapsed: boolean }> = {
  skill: { title: '技能目录', collapsed: true },
  memory: { title: '记忆 · 每轮注入', collapsed: true },
  receipt: { title: '回执', collapsed: false },
  steering: { title: '插话', collapsed: false },
  compact: { title: '压缩摘要', collapsed: false },
};

/**
 * inbox 条目（W515/W888）：系统注入 / worker 回执 / 技能目录 / 记忆等**非用户**
 * 输入。独立配色 + 左侧色条 + 标题条，与用户气泡一眼可分；长注入默认折叠。
 * `kind` 是 origin（skill/memory/receipt/steering/compact）；缺省走旧的
 * 「回执 · source」形态（W515 兼容）。
 */
export function renderInboxMessage(
  ctx: SessionPane,
  text: string,
  opts?: { source?: string; target?: string; kind?: string; into?: HTMLElement },
): HTMLElement {
  const target = opts?.into ?? ctx.el;
  if (target === ctx.el) hideEmptyHint(ctx);
  const kind = (opts?.kind ?? '').trim();
  const meta = INBOX_KIND[kind];
  const col = el('div', 'mcol');
  const msg = el('div', kind === '' ? 'msg inbox' : 'msg inbox inbox-' + kind);
  const cap = el('div', 'msg-caption');
  const src = (opts?.source ?? '').trim();
  cap.appendChild(el('span', 'who', meta ? meta.title : src === '' ? '系统' : '回执 · ' + src));
  if (opts?.target) cap.appendChild(el('span', 'inbox-lane', laneLabel(opts.target)));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble inbox-bubble');
  // 折叠：已知 origin 用 details/summary（原生、可键盘操作、默认态由 JS 决定）。
  if (meta) {
    const box = el('details', 'inbox-fold') as HTMLDetailsElement;
    box.open = !meta.collapsed;
    const head = el('summary', 'inbox-fold-head');
    head.appendChild(el('span', 'inbox-fold-title', meta.title));
    if (src !== '') head.appendChild(el('span', 'inbox-fold-src', src));
    box.appendChild(head);
    const body = el('div', 'content inbox-content');
    body.textContent = text;
    box.appendChild(body);
    bubble.appendChild(box);
  } else {
    const body = el('div', 'content inbox-content');
    body.textContent = text;
    bubble.appendChild(body);
  }
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
