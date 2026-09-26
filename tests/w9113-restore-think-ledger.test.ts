// @vitest-environment jsdom
// ============================================================================
// tests/w9113-restore-think-ledger.test.ts — W9113（P1-2）刷新路径的账本不变量。
//
// 缺陷（W9111 真机实测，results/W9111.md §4.6(b)/§6 P1-2）：
//   restore.ts 的 noteRestoredThinking(container, seg) 里 container 是**离屏** off；
//   搬家（ctx.el.replaceChildren(...off.childNodes)）之后 off 被丢弃 ——
//   于是记账记在了一个被扔掉的容器上，`thinkRetained(ctx.el)` **恒为 0**。
//   60 段 × 8K = 491520 字符的历史恢复后，DOM 里 262144 字符的思考正文在，账本却是 0。
//   后果：刷新后的会话在下一个 live 思考段到达之前**完全不受容器预算约束**。
//
// 修法：记账点移到 replaceChildren **之后**，用 (container, seg) 暂存列表批量记账。
//
// ★ 本文件的主断言是「> 0」：改动前它是 **0**（这是唯一能抓住这个 bug 的形状）。
//
// 变异负控制（改坏必红，逐条实测见报告）：
//   · 把 noteRestoredThinkingBatch 的调用点移回离屏 off（改回改动前）→ 主断言红；
//   · 让 noteRestoredThinkingBatch 不记账（只守预算）→ 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  textContent: string | null;
  appendChild(n: unknown): unknown;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Pane { el: El }
interface MsgMod {
  buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; text: string };
  appendThinking(ctx: unknown, delta: string): void;
  thinkRetained(container: El): number;
  THINK_CONTAINER_LIMIT: number;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, k?: string, t?: string): Pane;
  activatePane(id: string, k?: string, t?: string): unknown;
}
interface RestoreMod { restoreSessionHistory(pane: unknown): Promise<void> }

/** 一段历史思考正文（远小于 THINK_RENDER_LIMIT，避免触发单段钳位）。 */
const THINK = '推理'.repeat(400); // 800 字符
const THINK2 = '结论'.repeat(300); // 600 字符

const history = (): unknown => ({
  messages: [
    { role: 'thinking', content: THINK },
    { role: 'assistant', content: '第一段回答' },
    { role: 'thinking', content: THINK2 },
    { role: 'assistant', content: '第二段回答' },
  ],
});

/** 容器内思考正文的字符总数（与账本应当逐字相等）。 */
function domThinkChars(pane: Pane): number {
  let n = 0;
  for (const body of Array.from(pane.el.querySelectorAll('.think-seg-body'))) {
    n += (body.textContent ?? '').length;
  }
  return n;
}

describe('W9113 · P1-2 刷新路径：restoreSessionHistory 之后账本必须 > 0', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('历史恢复后 thinkRetained(ctx.el) === DOM 里的思考正文字符数（主断言：> 0）', async () => {
    const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    V.initViewCtx();
    const pane = V.ensurePane('ws/restore-ledger', 'session', '甲会话');
    V.activatePane('ws/restore-ledger', 'session', '甲会话');
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => history() }));

    await restore.restoreSessionHistory(pane);

    const dom = domThinkChars(pane);
    expect(dom, '前提：DOM 里确实有思考正文').toBe(THINK.length + THINK2.length);
    // ★ 主断言：改动前这里是 0（账本记在了被丢弃的离屏容器上）。
    expect(M.thinkRetained(pane.el), '刷新后的账本必须 > 0').toBeGreaterThan(0);
    expect(M.thinkRetained(pane.el), '账本必须与 DOM 逐字一致').toBe(dom);
  });

  it('刷新路径与 live 路径的记账口径一致（同一段正文 → 同一个数）', async () => {
    const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    V.initViewCtx();
    const replayPane = V.ensurePane('ws/replay', 'session', '甲');
    V.activatePane('ws/replay', 'session', '甲');
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => history() }));
    await restore.restoreSessionHistory(replayPane);

    // live：同一个 buildThinkSeg 构造 + appendThinking 记账（走真实 live 路径）。
    const livePane = V.ensurePane('ws/live', 'session', '乙');
    V.activatePane('ws/live', 'session', '乙');
    M.appendThinking(livePane, THINK);
    M.appendThinking(livePane, THINK2);

    expect(M.thinkRetained(replayPane.el), '刷新路径的账本').toBe(M.thinkRetained(livePane.el));
  });
});
