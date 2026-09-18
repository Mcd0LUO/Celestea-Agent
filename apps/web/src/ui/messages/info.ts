// ============================================================================
// ui/messages/info.ts — 信息块与队列注记（W759 从 ui/messages.ts 拆出）
//   renderInfoBlock()      context/status 类事件的信息块（注入 / lagged / error）
//   renderInterjectNote()  运行中插话/排队的轻提示（成功/失败就地改文案）
//   纯搬家：行为 / 文案 / DOM 结构逐字不变。
// ============================================================================
import { el, fmtNow } from '../../utils/dom';
import type { SessionPane } from '../viewctx';
import { autoscroll, hideEmptyHint } from './scroll';

// ---- 信息块（context/status 类事件：注入、lagged、error 提示等） ------------------

/**
 * 渲染一条可见信息块（按序出现在流中；样式与普通消息区分：左侧色条 + 浅色底）。
 * W863：返回该块句柄（调用方需要就地更新时用），并接受一个额外的定位 class；
 * text 为空 = 什么都没画（返回 null）。
 */
export function renderInfoBlock(
  ctx: SessionPane,
  text: string,
  cls?: 'err' | 'warn',
  extraClass?: string,
): HTMLElement | null {
  if (!text) return null;
  hideEmptyHint(ctx);
  const col = el('div', 'mcol');
  const msg = el('div', 'msg info' + (cls ? ' ' + cls : '') + (extraClass ? ' ' + extraClass : ''));
  const cap = el('div', 'msg-caption');
  cap.appendChild(el('span', 'who', '系统'));
  cap.appendChild(el('span', null, fmtNow()));
  msg.appendChild(cap);
  const bubble = el('div', 'bubble info-bubble');
  const body = el('div', 'content info-content');
  body.textContent = text;
  bubble.appendChild(body);
  msg.appendChild(bubble);
  col.appendChild(msg);
  ctx.el.appendChild(col);
  autoscroll(ctx, true);
  return msg;
}

/**
 * W863：就地改一条已存在信息块的文案 —— 不新建块、不动顺序、不滚动。
 * 正文节点是 renderInfoBlock 画的 .info-content；结构意外缺失时退化为整块文本。
 */
export function updateInfoBlock(msg: HTMLElement, text: string): void {
  const body = msg.querySelector<HTMLElement>('.info-content');
  if (body) body.textContent = text;
  else msg.textContent = text;
}

/**
 * 运行中插话的轻提示（贴在插话气泡下方；成功/失败各一态）。
 * 返回元素句柄，供结果到达后就地改文案（不重建列表）。
 */
export function renderInterjectNote(
  ctx: SessionPane,
  text: string,
  cls?: 'ok' | 'err',
  after?: HTMLElement | null,
): HTMLElement {
  const note = el('div', 'mcol interject-note-col');
  const msg = el('div', 'interject-note' + (cls ? ' ' + cls : ''), text);
  note.appendChild(msg);
  const anchor = after ?? null;
  if (anchor) anchor.after(note);
  else ctx.el.appendChild(note);
  if (anchor) {
    if (anchor.nextSibling === note) autoscroll(ctx, true);
  } else {
    autoscroll(ctx, true);
  }
  return msg;
}
