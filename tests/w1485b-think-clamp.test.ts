// @vitest-environment jsdom
// W1485 收尾（主会话复核时发现并补的缺口）：
// A/E 覆盖了助手正文与工具结果，但**思考段**没有上限 —— 而流式期间思考段是
// **自动展开**的（messages.ts 的 W752 分支），appendThinking 每节拍都写一次
// textContent 再 autoscroll。真机 CDP 实测「已挂载且可见」的单 tick 代价：
//   50K→9.7ms  200K→31.9ms  600K→104.8ms  **1.36M→241.7ms**
// 而真实日志里就有一条 1363020 字符的 thinking 段（活跃会话 dsh_plugins/插件哥）。
// 修法同 A：正文经 THINK_RENDER_LIMIT 钳位 + 一行「已省略 N 字符」提示。
//
// ★ W1505（P1-1）修订了上面那条修法的一半：W1485 只钳**渲染**、seg.text 留全文，
// 于是内存上界由模型行为决定（实测单段 1,362,974 字符）。现在同一个上限也管**保留**，
// 超出即丢弃，提示行**不带展开按钮**（没有全文可展，挂按钮就是撒谎）。
// 「原文一字不丢」这个承诺被撤销 —— 理由见 messages.ts 模块头。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  textContent: string | null;
  querySelector(sel: string): El | null;
}

describe('W1485 · F：思考段的渲染上限（复核补的缺口）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('超长思考段只渲染前缀，并挂出省略提示（原文不丢）', async () => {
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as {
      buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; body: El; text: string; dropped: number };
      THINK_RENDER_LIMIT: number;
    };
    const limit = M.THINK_RENDER_LIMIT;
    const long = 'x'.repeat(limit * 3);
    const seg = M.buildThinkSeg({ text: long });
    doc.body.appendChild(seg.root as never);
    // 正文被钳到上限（这是「不再每节拍布局 1.36MB」的机械证明）。
    expect((seg.body.textContent ?? '').length).toBe(limit);
    // ★ W1505 改了这里的契约：保留字段也钳到上限（W1485 时它留全文，于是内存上界
    //   由模型行为决定）。见 messages.ts 模块头的内存论证。
    expect(seg.text.length).toBe(limit);
    expect(seg.dropped).toBe(long.length - limit);
    // 用户看得到「有东西被省略了」……
    const note = seg.root.querySelector('.oversize-note');
    expect(note).not.toBeNull();
    // ……但**没有**展开按钮：我们确实没保留全文，挂按钮就是撒谎。
    expect(seg.root.querySelector('.oversize-more')).toBeNull();
  });

  it('W1505：保留的是前缀，dropped 随流式单调增长（不是超限就清零）', async () => {
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as {
      buildThinkSeg(o?: { text?: string }): { root: El; text: string; dropped: number };
      THINK_RENDER_LIMIT: number;
    };
    const limit = M.THINK_RENDER_LIMIT;
    const seg = M.buildThinkSeg({ text: 'a'.repeat(limit) });
    expect(seg.dropped).toBe(0);
    expect(seg.text.length).toBe(limit);
    // 构造时就超限：保留前缀（不是整段丢弃）。
    const over = M.buildThinkSeg({ text: 'b'.repeat(limit + 500) });
    expect(over.text.length).toBe(limit);
    expect(over.text.startsWith('b')).toBe(true);
    expect(over.dropped).toBe(500);
  });

  it('正常长度的思考段不触发钳位（这条路径不该被正常内容碰到）', async () => {
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as {
      buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; body: El };
    };
    const seg = M.buildThinkSeg({ text: '先想一下 A 再做 B。' });
    expect(seg.body.textContent).toBe('先想一下 A 再做 B。');
    expect(seg.root.querySelector('.oversize-note')).toBeNull();
  });
});

/**
 * 流式路径 —— 这才是 P1-1 真正无界的那一段。
 *
 * 构造/恢复时钳一次只解决「历史全文」；**正在流式的那一段**由 appendThinking 每节拍
 * 累加，而 dom-cap 永远不裁它（它是最新的一列）。所以保留上限必须也在这里生效，
 * 否则一个超长单段推理（实测 1.36M 字符）会整段常驻内存。
 */
describe('W1505 · 流式思考段的保留上限（P1-1 的真正无界面）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('appendThinking 累加到上限后停止保留，并计入 dropped', async () => {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as any;
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as any;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/stream', 'session', '甲');
    const host = pane.el.parentElement as any;
    if (host && host.isConnected === false) doc.body.appendChild(host);

    const limit = M.THINK_RENDER_LIMIT;
    const chunk = 'z'.repeat(1000);
    // 喂到 3× 上限：若保留无上限，seg.text 会是 3×limit。
    for (let i = 0; i < (limit * 3) / chunk.length; i++) M.appendThinking(pane, chunk);

    const seg = pane.el.querySelector('.think-seg');
    expect(seg).not.toBeNull();
    // 正文（= 保留文本）永远不超过上限。
    const body = seg.querySelector('.think-seg-body');
    expect((body.textContent ?? '').length).toBeLessThanOrEqual(limit);
    // 提示行出现，且**没有**展开按钮。
    expect(seg.querySelector('.oversize-note')).not.toBeNull();
    expect(seg.querySelector('.oversize-more')).toBeNull();
  });

  it('未超上限时不挂提示行（正常内容碰不到这条路径）', async () => {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as any;
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as any;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/stream2', 'session', '甲');
    const host = pane.el.parentElement as any;
    if (host && host.isConnected === false) doc.body.appendChild(host);
    M.appendThinking(pane, '先看目录');
    M.appendThinking(pane, '，再改文件。');
    const seg = pane.el.querySelector('.think-seg');
    expect(seg.querySelector('.think-seg-body').textContent).toBe('先看目录，再改文件。');
    expect(seg.querySelector('.oversize-note')).toBeNull();
  });
});
