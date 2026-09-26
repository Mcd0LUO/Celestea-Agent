// @vitest-environment jsdom
// ============================================================================
// tests/w9201-empty-done-flush.test.ts — W9201（P1）空文本 done 必须冲刷排队渲染。
//
// 缺陷：ui/messages/assistant.ts 的 applyFinalText 第一行是
//   `if (typeof text !== 'string' || !text) return;`
// 早退在「内容没变就冲刷」分支**之前** —— 而它上面的整段注释（W1524）论证的恰恰是
// 「done 到达时完全可能有一次渲染还排在窗口里，turn 结束本来就该立刻对齐终态」。
// 空文本的 done（工具步的 done、被掐断的流、provider 只回完整文本的兜底）不带正文，
// 于是终态 DOM 停在旧内容上，最长再等一个合并窗口（RENDER_WINDOW_MAX=50ms），
// 而 chat.ts:271 紧接着就 autoscroll 了（滚到底、DOM 却是旧的）。
//
// 两层断言（缺一层就守不住）：
//   ① **行为**：view.text 非空 + 有排队渲染 + applyFinalText(ctx, view, '')
//      ⇒ 定时器被清、DOM 当帧就是终态；
//   ② **不造空气泡**：空文本路径不得改 view.text、不得新建/移除任何节点。
//
// 变异负控制（改坏必红，逐条实测见 results/W9201-修复.md）：
//   · applyFinalText 把 `if (text === '')` 分支删回 `if (typeof text !== 'string' || !text) return;`
//     → ① 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface View { text: string; content: { textContent: string | null }; root: { remove(): void } }
interface Pane { el: { querySelectorAll(s: string): ArrayLike<unknown> }; render: { timer: number | null; deadline: number; cost?: number } }
interface AssistantMod {
  applyFinalText(ctx: unknown, view: unknown, text: string): void;
}
interface MessagesMod {
  appendText(ctx: unknown, view: unknown, delta: string): void;
  ensureAssistant(ctx: unknown): View;
}

async function boot(): Promise<{ asst: AssistantMod; msg: MessagesMod; view: View; ctx: Pane }> {
  resetHarness();
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as {
    initViewCtx(): unknown; ensurePane(id: string, k?: string, t?: string): Pane;
    activatePane(id: string, k?: string, t?: string): unknown;
  };
  ctxMod.initViewCtx();
  const ctx = ctxMod.ensurePane('ws/empty-done', 'session', '甲会话');
  ctxMod.activatePane('ws/empty-done', 'session', '甲会话');
  const msg = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
  const asst = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as AssistantMod;
  const view = msg.ensureAssistant(ctx);
  return { asst, msg, view, ctx };
}

describe('W9201 · 空文本 done 必须冲刷排队中的渲染', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('view.text 非空 + 有排队渲染：applyFinalText(ctx, view, "") 必须当帧落地', async () => {
    const { asst, msg, view, ctx } = await boot();
    msg.appendText(ctx, view, '终态正文');
    expect(view.content.textContent, '前提：正文已渲染').toContain('终态正文');

    // 造一次「排在窗口里」的渲染：先让上一次渲染很贵，再追加（走 trailing 排队）。
    ctx.render.cost = 50;
    ctx.render.deadline = performance.now();
    msg.appendText(ctx, view, '');
    if (ctx.render.timer === null) {
      // 没排上队说明仍在窗口内走了 leading —— 本用例前提不成立，显式跳过（与 w1524 同手法）。
      expect(ctx.render.timer).toBeNull();
      return;
    }
    // 排队期间再把正文推进一步（DOM 还没跟上）。
    view.text = '终态正文 + 尾部';
    expect(view.content.textContent, '前提：DOM 落后于 view.text').not.toContain('尾部');

    asst.applyFinalText(ctx, view, '');
    // ★ 主断言：改动前定时器还在（DOM 要等满一个窗口），这里必须已经被清掉。
    expect(ctx.render.timer, '空文本 done 之后不得再有排队的渲染').toBeNull();
    expect(view.content.textContent, '空文本 done 必须把终态当帧对齐').toContain('尾部');
  });

  it('不造空气泡：空文本路径不改 view.text、不动节点', async () => {
    const { asst, view, ctx } = await boot();
    const before = view.text;
    const cols = ctx.el.querySelectorAll('.mcol').length;
    asst.applyFinalText(ctx, view, '');
    expect(view.text, '空文本不得改写 view.text').toBe(before);
    expect(ctx.el.querySelectorAll('.mcol').length, '空文本不得新建/移除节点').toBe(cols);
  });

  it('没有排队渲染时是纯空转（不得凭空多出一次渲染）', async () => {
    const { asst, view, ctx } = await boot();
    // flushTextView 会把 deadline 写成 performance.now()；它没被调 ⇒ deadline 不变。
    // 用一个**不可能由渲染产生**的哨兵值，避免「恰好没变」被误读成通过。
    ctx.render.timer = null;
    ctx.render.deadline = -12345;
    asst.applyFinalText(ctx, view, '');
    expect(ctx.render.timer).toBeNull();
    expect(ctx.render.deadline, '无排队渲染时不得调用 flushTextView（deadline 哨兵必须原样）').toBe(-12345);
  });
});
