// @vitest-environment jsdom
// ============================================================================
// tests/w9113-adaptive-prune.test.ts — W9113（P0-2 / P1-3）的机械门禁。
//
// P0-2 症状（results/W9111.md §5/§6）：DOM 上限名义 600，但高速工具流下新增 900 列
// 只要 3.6 秒，而「100 条/秒」的绝对回收速率要 9 秒 —— 收敛延迟 5–10 秒，收敛期间
// 用户看到 4–9 秒的单帧冻结。修法：按**超出量**自适应（batch = clamp(excess,100,600)，
// excess>300 时把扫描间隔收紧到 100ms）。
//
// P1-3：prunePaneDom 摘思考列时必须把保留量从账本里减掉（改动前全文零 addThinkRetained
// 调用，只靠 enforceThinkBudget 的反向钳回自纠）。
//
// 变异负控制（改坏必红，逐条实测见报告）：
//   · pruneBatchFor 改回常量 DOM_PRUNE_BATCH → ② 红；
//   · pruneIntervalFor 恒返回 PRUNE_INTERVAL_MS → ③ 红；
//   · pruneThinkBudget 直接 return 0（不减账）→ ④ 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  appendChild(n: unknown): unknown;
  querySelectorAll(sel: string): ArrayLike<El>;
}
interface Pane {
  el: El;
  ops: Map<string, unknown>;
  streaming: boolean;
}
interface CapMod {
  MAX_DOM_COLS: number;
  DOM_PRUNE_BATCH: number;
  MAX_PRUNE_BATCH: number;
  PRUNE_INTERVAL_MS: number;
  PRUNE_INTERVAL_TIGHT_MS: number;
  PRUNE_INTERVAL_TIGHTEN_ABOVE: number;
  pruneBatchFor(excess: number): number;
  pruneIntervalFor(lastExcess: number): number;
  prunePaneDom(ctx: unknown, force?: boolean): number;
  pruneThinkBudget(ctx: unknown, doomed: El[]): number;
}
interface MsgMod {
  buildThinkSeg(o?: { text?: string; collapsed?: boolean }): {
    root: El; text: string; dropped: number;
  };
  noteRestoredThinkingBatch(container: El, segs: unknown[]): void;
  thinkRetained(container: El): number;
}

const cap = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as CapMod;
const msg = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MsgMod;
const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as {
  initViewCtx(): unknown;
  ensurePane(id: string, k?: string, t?: string): Pane;
};

function bootPane(id: string): Pane {
  ctxMod.initViewCtx();
  return ctxMod.ensurePane(id, 'session', '甲会话');
}

/** 造 n 个普通 .mcol 列（不参与 rail 记账 —— 这里只测回收口径）。 */
function addCols(pane: Pane, n: number, cls = 'mcol'): void {
  for (let i = 0; i < n; i += 1) {
    const col = doc.createElement('div');
    col.className = cls;
    pane.el.appendChild(col);
  }
}

describe('W9113 · ① 自适应口径是纯函数：超出量越大，单批越大，且有上下限', () => {
  it('excess 小时守下限；excess 大时按超出量放大；任何情况不超过硬顶', () => {
    // 下限：不逐条动 DOM
    expect(cap.pruneBatchFor(0)).toBe(cap.DOM_PRUNE_BATCH);
    expect(cap.pruneBatchFor(1)).toBe(cap.DOM_PRUNE_BATCH);
    expect(cap.pruneBatchFor(99)).toBe(cap.DOM_PRUNE_BATCH);
    expect(cap.pruneBatchFor(100)).toBe(cap.DOM_PRUNE_BATCH);
    // 自适应：单批 = 超出量（这是 P0-2 的修法本体）
    expect(cap.pruneBatchFor(300)).toBe(300);
    expect(cap.pruneBatchFor(900)).toBe(cap.MAX_PRUNE_BATCH);
    // 硬顶 + 非有限值兜底
    expect(cap.pruneBatchFor(100000)).toBe(cap.MAX_PRUNE_BATCH);
    expect(cap.pruneBatchFor(Number.NaN)).toBe(cap.DOM_PRUNE_BATCH);
    expect(cap.pruneBatchFor(-5)).toBe(cap.DOM_PRUNE_BATCH);
    for (const excess of [0, 50, 100, 101, 299, 300, 301, 600, 601, 5000]) {
      const b = cap.pruneBatchFor(excess);
      expect(b, 'excess=' + excess).toBeGreaterThanOrEqual(cap.DOM_PRUNE_BATCH);
      expect(b, 'excess=' + excess).toBeLessThanOrEqual(cap.MAX_PRUNE_BATCH);
    }
    // ★ 这条是 P0-2 的核心钉子：超出量大时单批必须**大于**旧的常量上限。
    expect(cap.pruneBatchFor(300), '超出 300 时必须一批收回 300，不能还是 100').toBeGreaterThan(cap.DOM_PRUNE_BATCH);
  });

  it('超出量大时扫描间隔收紧到 100ms；收敛后回到常规间隔', () => {
    expect(cap.pruneIntervalFor(0)).toBe(cap.PRUNE_INTERVAL_MS);
    expect(cap.pruneIntervalFor(cap.PRUNE_INTERVAL_TIGHTEN_ABOVE)).toBe(cap.PRUNE_INTERVAL_MS);
    expect(cap.pruneIntervalFor(cap.PRUNE_INTERVAL_TIGHTEN_ABOVE + 1)).toBe(cap.PRUNE_INTERVAL_TIGHT_MS);
    expect(cap.pruneIntervalFor(5000)).toBe(cap.PRUNE_INTERVAL_TIGHT_MS);
    expect(cap.PRUNE_INTERVAL_TIGHT_MS, '收紧间隔必须显著小于常规间隔').toBeLessThan(cap.PRUNE_INTERVAL_MS);
  });
});

describe('W9113 · ② 真机路径：超出量大时单次回收量 > DOM_PRUNE_BATCH', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('一次性超上限 400 条：单次 force 扫描就收回全部 400（旧的 100 条/次做不到）', () => {
    const pane = bootPane('ws/adaptive');
    const over = 400;
    addCols(pane, cap.MAX_DOM_COLS + over);
    const before = pane.el.querySelectorAll('.mcol').length;
    expect(before).toBe(cap.MAX_DOM_COLS + over);
    const dropped = cap.prunePaneDom(pane, true);
    expect(dropped, '单批必须 > DOM_PRUNE_BATCH').toBeGreaterThan(cap.DOM_PRUNE_BATCH);
    expect(dropped).toBe(over);
    expect(pane.el.querySelectorAll('.mcol').length, '一次扫描就收敛到上限').toBe(cap.MAX_DOM_COLS);
  });

  it('超出量小时仍守下限：超 5 条只摘 5 条，不多摘', () => {
    const pane = bootPane('ws/adaptive-small');
    addCols(pane, cap.MAX_DOM_COLS + 5);
    const dropped = cap.prunePaneDom(pane, true);
    expect(dropped).toBe(5);
    expect(pane.el.querySelectorAll('.mcol').length).toBe(cap.MAX_DOM_COLS);
  });
});

describe('W9113 · ③ 摘思考列时账本同步减少（记账不变式）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('pruneThinkBudget 对每段减掉其保留字符数，账本与 DOM 一致', () => {
    const pane = bootPane('ws/ledger');
    const container = pane.el as unknown as El;
    const per = 1000;
    const segs = [
      msg.buildThinkSeg({ text: 'a'.repeat(per), collapsed: true }),
      msg.buildThinkSeg({ text: 'b'.repeat(per), collapsed: true }),
    ];
    for (const s of segs) container.appendChild(s.root);
    msg.noteRestoredThinkingBatch(container, segs);
    expect(msg.thinkRetained(container), '两段共 2000').toBe(per * 2);

    // 摘掉第一段 → 账本必须减 1000
    const released = cap.pruneThinkBudget(pane as unknown, [segs[0]!.root]);
    expect(released).toBe(per);
    expect(msg.thinkRetained(container), '摘掉一段后账本必须减少对应字符数').toBe(per);

    // 第二段正文已被 enforceThinkBudget 回收时（text=''）→ 不重复减账
    segs[1]!.text = '';
    expect(cap.pruneThinkBudget(pane as unknown, [segs[1]!.root])).toBe(0);
    expect(msg.thinkRetained(container)).toBe(per);
  });

  it('prunePaneDom 摘列时把思考列的保留量一起减掉（真实路径）', () => {
    const pane = bootPane('ws/ledger2');
    const container = pane.el as unknown as El;
    const per = 500;
    // 回收**从头部**摘列，所以思考列必须放在头部才会被摘到。
    // 先放 20 个思考列，再补满上限 —— 此时超出量 20、且超出的正是这 20 个思考列。
    const thinkSegs = [];
    for (let i = 0; i < 20; i += 1) {
      const seg = msg.buildThinkSeg({ text: 't'.repeat(per), collapsed: true });
      container.appendChild(seg.root);
      thinkSegs.push(seg);
    }
    addCols(pane, cap.MAX_DOM_COLS);
    msg.noteRestoredThinkingBatch(container, thinkSegs);
    expect(msg.thinkRetained(container)).toBe(per * 20);
    const dropped = cap.prunePaneDom(pane, true);
    expect(dropped, '回收的是 20 个超出上限的列').toBe(20);
    expect(msg.thinkRetained(container), '被摘掉的 20 段账本必须清零').toBe(0);
  });
});
