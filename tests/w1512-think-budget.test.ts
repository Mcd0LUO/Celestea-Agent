// @vitest-environment jsdom
// W1512：会话级**思考文本预算**（容器总量）—— 单段上限挡不住的那一半。
//
// 背景（真实 Chromium 实测，见 ui/messages/think-budget.ts 模块头）：
//   THINK_RENDER_LIMIT 只管一段，而**段数无界** —— 每步 flush 一段。
//   600 段 x 64K = 37.5 MB 展开态文本 => 每 tick 一次全容器布局 **127 ms**，
//   而 appendThinking 每个 SSE 增量都调一次 => 主线程被钉死（用户报的「长思考块卡死」）。
//
// 本文件钉两件事：
//   ① 预算真的回收（最旧的段被折起 + 释放正文，节点**不删**）；
//   ② 回收后容器内保留量回到上限内（这是「每 tick 回到 ~1ms」的机械前提）。
//
// 变异负控制（改坏必红）：把 enforceThinkBudget 的预算判定改成直接 return => ① ② 都红。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  textContent: string | null;
  classList: { contains(c: string): boolean };
  appendChild(n: unknown): unknown;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
}

/** 取一段思考段的可见正文长度（折叠态 = CSS 隐藏，但 textContent 仍在）。 */
function bodyLen(msg: El): number {
  return (msg.querySelector('.think-seg-body')?.textContent ?? '').length;
}

describe('W1512 · 思考段容器预算（会话总量上限）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('超出容器预算时从最旧的段回收：折起 + 释放正文，节点不删', async () => {
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as {
      buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; text: string; dropped: number };
      noteRestoredThinking(container: El, seg: { root: El; text: string; dropped: number }): void;
      thinkRetained(container: El): number;
    };
    const B = (await import(/* @vite-ignore */ at('ui/messages/think-budget.ts'))) as {
      THINK_CONTAINER_LIMIT: number;
    };
    const container = doc.createElement('div') as unknown as El;
    doc.body.appendChild(container as never);

    // 造到超过预算：每段取 64K，预算 256K => 第 5 段必然触发回收。
    const per = 65536;
    const segs: Array<{ root: El; text: string; dropped: number }> = [];
    const count = Math.ceil(B.THINK_CONTAINER_LIMIT / per) + 2;
    for (let i = 0; i < count; i += 1) {
      const seg = M.buildThinkSeg({ text: 's'.repeat(per), collapsed: false });
      container.appendChild(seg.root as never);
      M.noteRestoredThinking(container, seg);
      segs.push(seg);
    }

    // ② 保留量回到上限内（这是每 tick 回到 ~1ms 的机械前提）。
    expect(M.thinkRetained(container)).toBeLessThanOrEqual(B.THINK_CONTAINER_LIMIT);
    // ① 最旧的段被回收：正文清空、记入 dropped、且**折回折叠态**（不再参与布局）。
    const oldest = segs[0]!;
    expect(bodyLen(oldest.root), '最旧段的正文应被释放').toBe(0);
    expect(oldest.dropped, '释放量必须记进 dropped（提示行如实报数）').toBeGreaterThan(0);
    expect((oldest.root.querySelector('.msg') as El).classList.contains('collapsed')).toBe(true);
    // 节点仍在：回收 ≠ 删 DOM（FRONTEND-RULES 铁律 4）。
    expect(container.querySelectorAll('.msg.think-seg').length).toBe(count);
    // 最新的段一字未动（用户看的是尾部）。
    expect(bodyLen(segs[count - 1]!.root)).toBe(per);
  });

  it('预算之内不动任何段（不误伤正常会话）', async () => {
    const M = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as {
      buildThinkSeg(o?: { text?: string; collapsed?: boolean }): { root: El; text: string; dropped: number };
      noteRestoredThinking(container: El, seg: { root: El; text: string; dropped: number }): void;
      thinkRetained(container: El): number;
    };
    const container = doc.createElement('div') as unknown as El;
    doc.body.appendChild(container as never);
    const seg = M.buildThinkSeg({ text: 'short reasoning', collapsed: false });
    container.appendChild(seg.root as never);
    M.noteRestoredThinking(container, seg);

    expect(M.thinkRetained(container)).toBe('short reasoning'.length);
    expect(bodyLen(seg.root)).toBe('short reasoning'.length);
    expect(seg.dropped).toBe(0);
  });
});
