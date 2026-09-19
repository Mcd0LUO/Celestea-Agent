// @vitest-environment jsdom
/**
 * A1：phase=completed 与「空闲」等价 —— 状态栏**不得**再出现「完成」字样
 * （cancelled/error 的文案保留）。用真实 chat.ts 的 onStatus 走一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface ChatMod { onStatus(ctx: unknown, p: Record<string, unknown>): void }
interface StatusbarMod { setStatus(t: string, c?: string): void }

const statusText = (): string => doc.getElementById('statusText')?.textContent ?? '';

describe('A1 · completed 不再产生「完成」文案', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{ chat: ChatMod; ctx: unknown; sb: StatusbarMod }> {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const sb = (await import(/* @vite-ignore */ at('ui/statusbar.ts'))) as StatusbarMod;
    // chat.ts 的 onStatus 需要 #statusText 等（夹具骨架已提供）。
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as ChatMod;
    return { chat, ctx: pane, sb };
  }

  it('phase=completed：状态栏不出现「完成」，回到空闲/在线文案', async () => {
    const { chat, ctx, sb } = await boot();
    sb.setStatus('运行中…', 'busy');
    chat.onStatus(ctx, { phase: 'completed', turn: 1 });
    expect(statusText(), 'completed 不得产生「完成」').not.toContain('完成');
  });

  it('cancelled / error 的文案保留', async () => {
    const { chat, ctx } = await boot();
    chat.onStatus(ctx, { phase: 'cancelled', turn: 1 });
    expect(statusText(), 'cancelled 仍显示「已取消」').toContain('已取消');
    chat.onStatus(ctx, { phase: 'error', turn: 2, error: 'boom' });
    expect(statusText(), 'error 仍显示「出错」').toContain('出错');
  });
});
