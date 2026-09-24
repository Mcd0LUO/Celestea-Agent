// @vitest-environment jsdom
// W1502 复核 → 主会话修复：DOM 裁剪必须**同时释放堆引用**。
//
// 缺陷（W1502 扫描发现，主会话独立复现）：prunePaneDom 只 removeChild，从不碰
// ctx.ops（Map<toolCallId, ToolCardRef>，而 ToolCardRef 持有卡片 DOM 节点），
// 于是被摘掉的卡片树仍被 Map 强引用 —— 绘制有界了，堆没有。而唯一会清 ops 的
// 两个函数（resetMessages / resetToolCards）在本仓零调用者，所以 ops 只增不减。
//
// 变异负控制：把 pruneToolCards 的调用去掉 → 本用例红（ops 会持续增长）。
import { afterEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  textContent: string | null;
  className: string;
  isConnected?: boolean;
  querySelectorAll(sel: string): ArrayLike<El>;
}

/** 每轮造 N 条消息列 + N 个 ops 条目（模拟真实工具卡登记），返回每轮快照。 */
async function runRounds(rounds: number, perRound: number): Promise<string[]> {
  resetHarness();
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as any;
  const domCap = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as any;
  ctxMod.initViewCtx();
  const pane = ctxMod.ensurePane('ws/heap', 'session', '堆验证');
  const host = pane.el.parentElement as unknown as El | null;
  if (host !== null && host.isConnected === false) doc.body.appendChild(host as never);
  const snap: string[] = [];
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < perRound; i++) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      col.textContent = 'msg ' + round + '-' + i;
      pane.el.appendChild(col as never);
      pane.ops.set('call_' + round + '_' + i, { card: col, label: col, body: col, resultPv: col });
    }
    domCap.prunePaneDom(pane, true);
    snap.push(pane.el.querySelectorAll('.mcol').length + '/' + pane.ops.size);
  }
  return snap;
}

describe('W1502 · DOM 裁剪同时释放堆引用', () => {
  afterEach(() => { doc.body.replaceChildren(); });

  it('反复裁剪后 ops 不再增长（与文档列数一同钉在上限）', async () => {
    const snap = await runRounds(12, 100);
    const [docCols, opsSize] = snap[snap.length - 1]!.split('/').map(Number);
    // 文档有界。
    expect(docCols).toBe(600);
    // 堆也有界 —— 这就是修复前会失败的那条（改前此处是 1200）。
    expect(opsSize).toBe(600);
    // 且 ops 从某轮起不再增长（不是「恰好等于 600」的巧合）。
    const opsSeries = snap.map((s) => Number(s.split('/')[1]));
    expect(opsSeries[opsSeries.length - 1]).toBe(opsSeries[opsSeries.length - 2]);
  });

  it('未超上限时不误删任何 ops 条目', async () => {
    const snap = await runRounds(3, 100);
    // 300 条 < 600 上限 → 一次都不该裁，ops 应恰好等于累计条数。
    expect(snap[2]).toBe('300/300');
  });
});
