// @vitest-environment jsdom
/**
 * F1 选段提及 · DOM 行为（jsdom）：
 *   选中 → 浮标可见 → 点击 → chip 进待发区 → 发送请求 input 含引用块；
 *   历史喂一条含引用块的 user 消息 → 渲染 .quote-block 且 .content 只剩 rest；
 *   两条负例（composer 选区 / 跨两个 .mcol 不弹浮标）+ 零回归（无引用时请求体逐字节一致）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
interface RangeLike {
  setStart(n: unknown, o: number): void;
  setEnd(n: unknown, o: number): void;
  getBoundingClientRect(): RectLike;
  commonAncestorContainer: unknown;
  startContainer: unknown;
  endContainer: unknown;
}
interface SelLike {
  isCollapsed: boolean; rangeCount: number; toString(): string;
  getRangeAt(i: number): RangeLike; removeAllRanges(): void; addRange(r: RangeLike): void;
}
interface DomLike { createRange(): RangeLike }
interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown }
interface TrayMod { initQuoteTray(host: ElLike, box: ElLike | null): void; addQuote(input: unknown): Promise<string>; quoteList(): unknown[] }
interface SelectMod { installQuoteSelection(): void }
interface SendMod { dispatchSend(text: string, mode?: string): void }
interface RestoreMod { restoreSessionHistory(ctx: unknown, guard?: () => boolean): Promise<void> }
interface ModelMod { QUOTE_BLOCK_DELIMITER: string; makeQuote(input: unknown): unknown; serializeQuotes(text: string, quotes: readonly unknown[]): string }

const rect = (l: number, t: number, r: number, b: number): RectLike => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
const sel = (): SelLike | null => (globalThis as unknown as { getSelection(): SelLike | null }).getSelection();
const rangeOf = (): RangeLike => (doc as unknown as DomLike).createRange();

interface Boot { pane: { el: ElLike }; calls: string[]; tray: TrayMod; model: ModelMod }

/** 装好：真实 viewctx 会话容器 + #inputbar/.input-box + #quoteTray + fetch 记录器。 */
async function boot(): Promise<Boot> {
  resetHarness();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  (pane.el as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, 900, 600);
  const inputbar = doc.createElement('div') as unknown as ElLike;
  inputbar.id = 'inputbar';
  const box = doc.createElement('div') as unknown as ElLike;
  box.className = 'input-box';
  inputbar.appendChild(box);
  (doc.getElementById('main') as ElLike).appendChild(inputbar);
  const tray = (await import(/* @vite-ignore */ at('ui/quote/tray.ts'))) as TrayMod;
  tray.initQuoteTray(inputbar, box);
  const model = (await import(/* @vite-ignore */ at('ui/quote/model.ts'))) as ModelMod;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    calls.push(init?.body === undefined ? '' : String(init.body));
    if (u.includes('/messages')) return reply(200, { ok: true, messages: [] });
    if (u.includes('/api/turn')) return reply(200, { ok: true, turn: 1, session: 'ws/s1' });
    return reply(200, { ok: true });
  });
  return { pane, calls, tray, model };
}

/** 造一条 assistant 消息列，返回其 .content 与文本节点。 */
function makeCol(pane: { el: ElLike }, text: string, kind = 'assistant'): { content: ElLike; textNode: unknown } {
  const col = doc.createElement('div') as unknown as ElLike;
  col.className = 'mcol';
  const msg = doc.createElement('div') as unknown as ElLike;
  msg.className = 'msg ' + kind;
  const bubble = doc.createElement('div') as unknown as ElLike;
  bubble.className = 'bubble';
  const content = doc.createElement('div') as unknown as ElLike;
  content.className = 'content';
  content.textContent = text;
  bubble.appendChild(content);
  msg.appendChild(bubble);
  col.appendChild(msg);
  pane.el.appendChild(col);
  return { content, textNode: (content as unknown as { firstChild: unknown }).firstChild };
}

function selectRange(a: unknown, ao: number, b: unknown, bo: number): void {
  const s = sel();
  if (!s) throw new Error('no selection');
  s.removeAllRanges();
  const r = rangeOf();
  r.setStart(a, ao);
  r.setEnd(b, bo);
  // jsdom 的 Range 没有 getBoundingClientRect；补一个确定性矩形供浮标落位。
  (r as unknown as { getBoundingClientRect: () => RectLike }).getBoundingClientRect = () => rect(20, 40, 120, 60);
  s.addRange(r);
  (doc as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(new Ev('mouseup'));
}

const floatEl = (): ElLike | null => doc.querySelector('.quote-float');
const floatHidden = (): boolean => floatEl()?.classList.contains('hidden') ?? true;

describe('F1 · 选段提及（DOM）', () => {
  beforeEach(() => { /* resetHarness 在 boot 内调用 */ });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('选中 → 浮标可见 → 点击 → chip 进待发区', async () => {
    const { pane, tray } = await boot();
    ((await import(/* @vite-ignore */ at('ui/quote/select.ts'))) as SelectMod).installQuoteSelection();
    const { textNode } = makeCol(pane, '这是一段可以引用的回答');
    expect(floatHidden()).toBe(true);
    selectRange(textNode, 0, textNode, 8);
    expect(floatHidden(), '选中后浮标应可见').toBe(false);
    floatEl()?.click();
    await flush();
    expect(doc.querySelectorAll('#quoteTray .quote-chip').length).toBe(1);
    expect(tray.quoteList().length).toBe(1);
  });

  it('发送：请求 input 含定界行 + header + "> " 正文；气泡含 .quote-block', async () => {
    const { pane, calls, tray, model } = await boot();
    ((await import(/* @vite-ignore */ at('ui/quote/select.ts'))) as SelectMod).installQuoteSelection();
    await tray.addQuote({ source: { kind: 'assistant', session: 'ws/s1', turn: 2, label: 'Studio' }, text: '引用正文' });
    ((await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod).dispatchSend('你好');
    await flush();
    const body = JSON.parse(calls[calls.length - 1] ?? '{}') as { input?: string };
    expect(body.input ?? '').toContain(model.QUOTE_BLOCK_DELIMITER);
    expect(body.input ?? '').toContain('[引用 1 · assistant · 第 2 轮 · Studio');
    expect(body.input ?? '').toContain('> 引用正文');
    expect(doc.querySelector('#messages .msg.user .quote-block')).not.toBeNull();
  });

  it('零回归：无引用时请求 input 逐字节为原文', async () => {
    const { calls } = await boot();
    ((await import(/* @vite-ignore */ at('ui/send.ts'))) as SendMod).dispatchSend('你好');
    await flush();
    expect((JSON.parse(calls[calls.length - 1] ?? '{}') as { input?: string }).input).toBe('你好');
  });

  it('历史：含引用块的 user 消息 → .quote-block 且 .content 只剩 rest', async () => {
    const { pane, model } = await boot();
    const q = model.makeQuote({ id: 'q1', source: { kind: 'assistant', session: 'ws/s1', turn: 1, label: 'Studio' }, text: '被引用的回答', hash: '' });
    const wire = model.serializeQuotes('问题正文', [q]);
    vi.stubGlobal('fetch', async (url: unknown) => String(url).includes('/messages')
      ? reply(200, { ok: true, messages: [{ role: 'user', content: wire }] })
      : reply(200, { ok: true }));
    await ((await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod).restoreSessionHistory(pane);
    expect(doc.querySelectorAll('#messages .quote-block').length).toBe(1);
    expect(doc.querySelector('#messages .msg.user .content')?.textContent).toBe('问题正文');
  });

  it('负例：composer 选区不弹浮标', async () => {
    const { pane } = await boot();
    ((await import(/* @vite-ignore */ at('ui/quote/select.ts'))) as SelectMod).installQuoteSelection();
    const ok = makeCol(pane, '正常回答');
    selectRange(ok.textNode, 0, ok.textNode, 2);
    expect(floatHidden()).toBe(false); // 先证明浮标能正常出现
    // 把一条**完整可引用**的 .mcol（.content 齐全）放进 #inputbar，
    // 使唯一拒绝原因就是 composer 守卫（否则 .mcol 检查会先拦下，测不到守卫）。
    const inputbar = doc.getElementById('inputbar') as ElLike;
    pane.el.appendChild(inputbar);
    const col = doc.createElement('div') as unknown as ElLike;
    col.className = 'mcol';
    const msg = doc.createElement('div') as unknown as ElLike;
    msg.className = 'msg user';
    const bubble = doc.createElement('div') as unknown as ElLike;
    bubble.className = 'bubble';
    const content = doc.createElement('div') as unknown as ElLike;
    content.className = 'content';
    content.textContent = 'composer 文本';
    bubble.appendChild(content);
    msg.appendChild(bubble);
    col.appendChild(msg);
    inputbar.appendChild(col);
    const t = (content as unknown as { firstChild: unknown }).firstChild;
    selectRange(t, 0, t, 3);
    expect(floatHidden(), 'composer 选区不得弹浮标').toBe(true);
  });

  it('负例：跨两个 .mcol 不弹浮标', async () => {
    const { pane } = await boot();
    ((await import(/* @vite-ignore */ at('ui/quote/select.ts'))) as SelectMod).installQuoteSelection();
    const a = makeCol(pane, '第一条回答');
    const b = makeCol(pane, '第二条回答');
    selectRange(a.textNode, 0, b.textNode, 3);
    expect(floatHidden(), '跨消息选区不得弹浮标').toBe(true);
  });
});
