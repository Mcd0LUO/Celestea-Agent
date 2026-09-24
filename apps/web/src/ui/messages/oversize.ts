// ============================================================================
// ui/messages/oversize.ts — 单条消息的**渲染上限**（W1485）
// ----------------------------------------------------------------------------
// 症状（用户报障）：切出网页挂后台一段时间后切回，页面卡死；刷新也卡死。
//   真实日志里最大单条消息 196187 字符（role: "tool" 的结果），而前端对单条消息
//   的**渲染**没有任何上限 —— 一次 renderTextView 就要把整条 100KB+ 的正文解析成
//   markdown、再走一遍增强遍（高亮 / 行号切分），刷新时更是同步渲染 200 条。
//
// 修法：渲染前先按字符数截断，超出部分折成一行提示 + 展开按钮。
//   · 折叠是**纯渲染**行为：view.text / 工具结果原文一个字都没丢，
//     点「展开全部」就按全文渲染一次（用户主动触发，慢一点是预期）；
//   · 上限取「远大于正常消息」的值，正常内容永远碰不到这条路径。
//
// 为什么放在这里而不是 markdown.ts：后者受模块体积棘轮约束，且这里是 DOM 侧
// 策略（提示行 + 按钮），与解析器无关。
// ============================================================================
import { el } from '../../utils/dom';
import { t } from '../../i18n';

/** 单条助手正文的渲染上限（字符）。正常回答 1~20K，到 64K 已属异常长。 */
export const MESSAGE_RENDER_LIMIT = 65536;
/** 单条工具结果的渲染上限（字符）。工具输出常是日志/文件内容，量级更大。 */
export const TOOL_RESULT_RENDER_LIMIT = 32768;

/** 截断结果：text = 实际渲染的文本，omitted = 被省略的字符数（0 = 未截断）。 */
export interface Clamped {
  text: string;
  omitted: number;
}

/**
 * 纯函数：按上限截断文本（上限 ≤0 或文本不长于上限时原样返回）。
 * 用 Array.from 语义切分以免劈开代理对（emoji / 罕见汉字）。
 */
export function clampForRender(text: string, limit: number): Clamped {
  if (limit <= 0 || text.length <= limit) return { text, omitted: 0 };
  return { text: text.slice(0, limit), omitted: text.length - limit };
}

/**
 * 造一个「已省略 N 字符 + 展开全部」提示行（**不挂载**；点展开先摘掉自己再调
 * onExpand，由调用方用全文重渲染一次）。
 *
 * 为什么不直接挂载：流式路径每个节拍都会重建尾部区，挂上去的节点下一 tick 就被
 * 摘掉 —— 调用方需要**复用**同一个节点（否则每个节拍都造一个新按钮）。
 */
export function buildOmittedNote(omitted: number, onExpand: () => void): HTMLElement {
  const note = el('div', 'oversize-note');
  note.appendChild(el('span', 'oversize-text', t('chat.oversize.omitted', { n: omitted })));
  const btn = el('button', 'btn btn-quiet oversize-more', t('chat.oversize.expand')) as HTMLButtonElement;
  btn.type = 'button';
  btn.addEventListener('click', () => {
    note.remove();
    onExpand();
  });
  note.appendChild(btn);
  return note;
}

/** 就地更新提示行的省略字数（复用节点时用）。 */
export function setOmittedCount(note: HTMLElement, omitted: number): void {
  const span = note.querySelector('.oversize-text');
  if (span) span.textContent = t('chat.oversize.omitted', { n: omitted });
}

/** 一次性挂载（工具结果等单次渲染路径）。 */
export function appendOmittedNote(host: HTMLElement, omitted: number, onExpand: () => void): HTMLElement {
  const note = buildOmittedNote(omitted, onExpand);
  host.appendChild(note);
  return note;
}
