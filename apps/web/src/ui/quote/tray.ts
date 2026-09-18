// ============================================================================
// ui/quote/tray.ts — F1 选段提及：**待发引用 chip 收纳区**（按会话隔离）。
// ----------------------------------------------------------------------------
// 为什么独立于 attach-tray：附件展示夹绑定 PendingAttachment[] 且有折叠/几何与
// W867/W869 的证据；引用与它类型不同，混进去会污染那份证据。这里用同一视觉语言
// 另起一个 #quoteTray，钉在输入框上沿之上、叠在附件夹之上（量实测高度，出流）。
// 状态与 attachments.ts 的 drafts 同模式：Map<sessionId, QuoteRef[]>，切会话只换内容。
// 铁律：refreshQuoteTray 离屏构建 + 单次 replaceChildren；不重建输入栏/消息流。
// ============================================================================
import { el } from '../../utils/dom';
import { activePane, onPaneChange } from '../viewctx';
import {
  QUOTE_MAX_BYTES, QUOTE_MAX_PER_TURN, QUOTE_TOTAL_MAX_BYTES,
  capQuote, hashQuote, makeQuote, quoteDedupKey,
  type QuoteFormat, type QuoteLineRange, type QuoteRange, type QuoteRef, type QuoteSource,
} from './model';

/** 加入结果：added / duplicate（同内容已引用）/ full（条数或字节超限）。 */
export type AddQuoteResult = 'added' | 'duplicate' | 'full';

export interface AddQuoteInput {
  source: QuoteSource;
  text: string;
  range?: QuoteRange;
  format?: QuoteFormat;
  filePath?: string;
  lineRange?: QuoteLineRange;
}

const quotesBySession = new Map<string, QuoteRef[]>();
let trayEl: HTMLElement | null = null;
let trayBox: HTMLElement | null = null;
let seq = 0;

function activeKey(): string {
  return activePane()?.id ?? '';
}

function listOf(key: string): QuoteRef[] {
  return quotesBySession.get(key) ?? [];
}

/** 当前聚焦会话的引用（只读副本）。 */
export function quoteList(): QuoteRef[] {
  return listOf(activeKey()).slice();
}

/** 把展示区钉在输入框上沿之上、附件夹之上（量实测高度；height ≤ 0 时不写）。 */
function placeQuoteTray(): void {
  if (!trayEl || !trayBox) return;
  const boxH = trayBox.getBoundingClientRect().height;
  if (boxH <= 0) return;
  const attach = trayBox.querySelector<HTMLElement>('.attach-tray');
  const attachH = attach ? attach.offsetHeight : 0;
  trayEl.style.bottom = boxH + attachH + 'px';
}

function quoteChip(q: QuoteRef, onRemove: (q: QuoteRef) => void): HTMLElement {
  const chip = el('div', 'quote-chip');
  chip.appendChild(el('span', 'quote-chip-src', q.source.label + (q.truncated ? ' · 已截断' : '')));
  const preview = q.text.replace(/\s+/g, ' ').trim();
  chip.appendChild(el('span', 'quote-chip-text', preview === '' ? '（空引用）' : preview.slice(0, 40)));
  chip.appendChild(el('span', 'quote-chip-bytes', String(q.bytes) + ' B'));
  const rm = el('button', 'quote-chip-remove', '×') as HTMLButtonElement;
  rm.type = 'button';
  rm.title = '移除这条引用';
  rm.setAttribute('aria-label', '移除引用：' + q.source.label);
  rm.addEventListener('click', () => onRemove(q));
  chip.appendChild(rm);
  return chip;
}

/** 重建展示区（离屏构建 + 单次 replaceChildren；空则隐藏）。 */
export function refreshQuoteTray(): void {
  if (!trayEl) return;
  const items = listOf(activeKey());
  if (items.length === 0) {
    trayEl.classList.add('hidden');
    trayEl.replaceChildren();
    return;
  }
  trayEl.classList.remove('hidden');
  placeQuoteTray();
  const off = document.createElement('div');
  for (const q of items) off.appendChild(quoteChip(q, removeQuote));
  trayEl.replaceChildren(...Array.from(off.childNodes));
  placeQuoteTray();
}

/** 移除一条（就地 splice + 重画，不重建输入栏）。 */
export function removeQuote(q: QuoteRef): void {
  const key = activeKey();
  const list = listOf(key);
  const i = list.indexOf(q);
  if (i >= 0) {
    list.splice(i, 1);
    quotesBySession.set(key, list);
  }
  refreshQuoteTray();
}

/** 清空当前会话的引用。 */
export function clearQuotes(): void {
  quotesBySession.set(activeKey(), []);
  refreshQuoteTray();
}

/** 发送时取走（默认当前会话）并清空 —— 与 attachments.takePending 同语义。 */
export function takeQuotes(key: string = activeKey()): QuoteRef[] {
  const list = listOf(key);
  quotesBySession.set(key, []);
  if (activeKey() === key) refreshQuoteTray();
  return list;
}

/** 发送失败：把引用放回**原会话**（按内容键去重合并到队首）。 */
export function restoreQuotes(key: string, items: readonly QuoteRef[]): void {
  const cur = listOf(key);
  const seen = new Set(cur.map((q) => quoteDedupKey(q)));
  const fresh = items.filter((q) => !seen.has(quoteDedupKey(q)));
  quotesBySession.set(key, [...fresh, ...cur]);
  if (activeKey() === key) refreshQuoteTray();
}

/**
 * 加入一条引用（乐观：哈希在后台算，算完才落列表）。
 * 竞态守卫：**await 前捕获 key**，哈希回来写该 key 的列表（切会话不串味）。
 */
export async function addQuote(input: AddQuoteInput): Promise<AddQuoteResult> {
  const key = activeKey();
  const first = capQuote(input.text, QUOTE_MAX_BYTES);
  const hash = await hashQuote(first.text);
  const list = listOf(key);
  const dedupKey = hash !== '' ? hash : 'x:' + first.text;
  if (list.some((q) => quoteDedupKey(q) === dedupKey)) return 'duplicate';
  if (list.length >= QUOTE_MAX_PER_TURN) return 'full';
  const used = list.reduce((n, q) => n + q.bytes, 0);
  const remaining = QUOTE_TOTAL_MAX_BYTES - used;
  if (remaining < 256) return 'full';
  const capped = capQuote(input.text, Math.min(QUOTE_MAX_BYTES, remaining));
  const q = makeQuote({
    id: 'q' + String(++seq),
    source: input.source,
    text: capped.text,
    hash,
    range: input.range,
    format: input.format,
    filePath: input.filePath,
    lineRange: input.lineRange,
  });
  q.truncated = capped.truncated;
  list.push(q);
  quotesBySession.set(key, list);
  if (activeKey() === key) refreshQuoteTray();
  return 'added';
}

/** 建出 #quoteTray 并订阅会话切换（幂等；由 inputbar 装配时调用一次）。 */
export function initQuoteTray(host: HTMLElement, box: HTMLElement | null): void {
  if (trayEl) return;
  trayBox = box ?? host;
  trayEl = el('div', 'quote-tray hidden');
  trayEl.id = 'quoteTray';
  trayBox.appendChild(trayEl);
  onPaneChange(() => refreshQuoteTray());
}
