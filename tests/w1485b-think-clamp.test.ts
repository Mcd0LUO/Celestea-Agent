// @vitest-environment jsdom
// W1485 收尾（主会话复核时发现并补的缺口）：
// A/E 覆盖了助手正文与工具结果，但**思考段**没有上限 —— 而流式期间思考段是
// **自动展开**的（messages.ts 的 W752 分支），appendThinking 每节拍都写一次
// textContent 再 autoscroll。真机 CDP 实测「已挂载且可见」的单 tick 代价：
//   50K→9.7ms  200K→31.9ms  600K→104.8ms  **1.36M→241.7ms**
// 而真实日志里就有一条 1363020 字符的 thinking 段（活跃会话 dsh_plugins/插件哥）。
// 修法同 A：正文经 THINK_RENDER_LIMIT 钳位 + 一行「已省略 N 字符 + 展开全部」，
// 原文留在 seg.text，展开后按全文渲染一次。
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
      buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; body: El; text: string };
      THINK_RENDER_LIMIT: number;
    };
    const limit = M.THINK_RENDER_LIMIT;
    const long = 'x'.repeat(limit * 3);
    const seg = M.buildThinkSeg({ text: long });
    doc.body.appendChild(seg.root as never);
    // 正文被钳到上限（这是「不再每节拍布局 1.36MB」的机械证明）。
    expect((seg.body.textContent ?? '').length).toBe(limit);
    // 原文一字不丢：累积字段仍是全文。
    expect(seg.text.length).toBe(long.length);
    // 用户看得到「有东西被省略了」，且能展开。
    const note = seg.root.querySelector('.oversize-note');
    expect(note).not.toBeNull();
    expect(seg.root.querySelector('.oversize-more')).not.toBeNull();
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
