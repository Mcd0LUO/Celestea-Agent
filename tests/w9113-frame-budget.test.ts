// @vitest-environment jsdom
// ============================================================================
// tests/w9113-frame-budget.test.ts — W9113（P0-1）帧内预算的机械门禁。
//
// 缺陷（W9111 真机 CDP，results/W9111.md §5/§6）：每 step 3 帧 / 4–6ms 间隔时，
// Chromium 把一个帧里到达的 **584 个** EventSource 回调串成一条 7.9–9.4 秒的同步
// 执行链（每个回调都写 DOM + 强制一次同步布局，中途无法让出）。
//
// 本文件钉三件事：
//   ① 纯函数 frameAllowance：K = clamp(floor(budget/cost), 1, 硬顶)；
//   ② 预算器：喂 N 个事件到一帧里 → **单帧内联量 ≤ K**，其余排队且**保序**；
//   ③ 接线：真实 chat.ts 的 SSE 帧真的过这个预算（去掉接线这条必须红）。
//
// 变异负控制（改坏必红，逐条实测见报告）：
//   · frameAllowance 去掉 maxPerFrame 夹取 → ① 红；
//   · 预算器 push 去掉 `queue.length > 0` 判据（允许插队）→ ② 的保序断言红；
//   · chat.ts 把 paced 换成直接执行 → ③ 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, HTML as FIXTURE_HTML, resetHarness } from './lib/w795-dom.js';

interface BudgetMod {
  FRAME_BUDGET_MS: number;
  MAX_EVENTS_PER_FRAME: number;
  frameAllowance(costMs: number | undefined, budgetMs?: number, maxPerFrame?: number): number;
  createFrameBudget(o?: {
    budgetMs?: number;
    maxPerFrame?: number;
    now?: () => number;
    schedule?: (cb: () => void) => void;
  }): {
    push(run: () => void): boolean;
    stats(): { inlineThisFrame: number; queued: number; frames: number; cap: number };
  };
}

const mod = (await import(/* @vite-ignore */ at('ui/messages/frame-budget.ts'))) as BudgetMod;

describe('W9113 · ① frameAllowance：K 由实测代价反推，且有硬顶', () => {
  it('没测到代价（0/NaN/Infinity）→ 用硬顶（与改动前等价，不限流）', () => {
    expect(mod.frameAllowance(0)).toBe(mod.MAX_EVENTS_PER_FRAME);
    expect(mod.frameAllowance(undefined)).toBe(mod.MAX_EVENTS_PER_FRAME);
    expect(mod.frameAllowance(Number.NaN)).toBe(mod.MAX_EVENTS_PER_FRAME);
    expect(mod.frameAllowance(Number.POSITIVE_INFINITY)).toBe(mod.MAX_EVENTS_PER_FRAME);
    expect(mod.frameAllowance(-3)).toBe(mod.MAX_EVENTS_PER_FRAME);
  });

  it('代价越高 K 越小；任何代价下 K 都落在 [1, 硬顶]', () => {
    // budget = 12ms（默认）
    expect(mod.frameAllowance(1)).toBe(12);
    expect(mod.frameAllowance(3)).toBe(4);
    expect(mod.frameAllowance(12)).toBe(1);
    // 代价超过整个帧预算：K 不允许降到 0（0 会让队列永远排不空 = 饿死）
    expect(mod.frameAllowance(50)).toBe(1);
    expect(mod.frameAllowance(0.01)).toBe(mod.MAX_EVENTS_PER_FRAME); // 12/0.01=1200 → 夹到硬顶
    for (const cost of [0.001, 0.5, 1, 2.5, 7, 11.9, 12, 100]) {
      const k = mod.frameAllowance(cost);
      expect(k, 'cost=' + cost).toBeGreaterThanOrEqual(1);
      expect(k, 'cost=' + cost).toBeLessThanOrEqual(mod.MAX_EVENTS_PER_FRAME);
    }
  });
});

/** 一个可控的「帧」调度器：schedule 只入队，测试显式排空。 */
function fakeFrames(): { queue: Array<() => void>; drain(max?: number): void } {
  const queue: Array<() => void> = [];
  return {
    queue,
    drain(max = 200): void {
      for (let i = 0; i < max && queue.length > 0; i += 1) {
        const batch = queue.splice(0, queue.length);
        for (const cb of batch) cb();
      }
    },
  };
}

/** 排空宏任务（生产调度器 = setTimeout(0)；与 w795-dom 的 flush 同一手法）。 */
async function drainMacrotasks(until: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !until(); i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('W9113 · ② 预算器：单帧处理量 ≤ K，其余保序排到后续帧', () => {
  it('N 个事件塞进一帧：内联量 ≤ K，其余排队，排空后顺序与投递顺序逐字一致', () => {
    const frames = fakeFrames();
    let clock = 0;
    const N = 20;
    const MAX = 8;
    const budget = mod.createFrameBudget({
      budgetMs: 12,
      maxPerFrame: MAX,
      now: () => clock,
      schedule: (cb) => frames.queue.push(cb),
    });
    const order: number[] = [];
    for (let i = 0; i < N; i += 1) {
      budget.push(() => {
        order.push(i);
        clock += 1; // 每个事件实测 1ms
      });
    }
    // ① 单帧内联量 ≤ K：K = min(8, floor(12/1)) = 8
    const s = budget.stats();
    expect(s.inlineThisFrame, '单帧处理量必须 ≤ 硬顶').toBeLessThanOrEqual(MAX);
    expect(s.inlineThisFrame).toBe(MAX);
    // 其余全部排队（一个都不能丢）
    expect(s.queued).toBe(N - MAX);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    frames.drain();
    // ② 排空后：一个不丢、顺序保序（工具卡不会被排到它的工具结果之后）
    expect(order).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(budget.stats().queued).toBe(0);
    expect(budget.stats().frames).toBeGreaterThan(0);
  });

  it('★ 确定性：帧内出现一个极慢事件，本帧的 K 也**不得**当场缩小（回归钉子）', () => {
    // 这条钉住的是本任务真实踩过的坑：第一版把 K 写成「每次 push 都用刚测到的**那一个**
    // 事件的耗时代入」，于是在负载高的机器上 K 当场掉到 2，同一个同步循环里投递的事件
    // 大半被延后 —— W867 / W895-R 那种「同一调用栈内读结果」的门禁随之变红，且**红不红
    // 取决于机器快慢**。修法 = 控制周期钉成一帧（帧开始时冻结 K）。
    const frames = fakeFrames();
    let clock = 0;
    const budget = mod.createFrameBudget({
      budgetMs: 12,
      maxPerFrame: 8,
      now: () => clock,
      schedule: (cb) => frames.queue.push(cb),
    });
    const order: number[] = [];
    const push = (i: number, cost: number): boolean =>
      budget.push(() => {
        order.push(i);
        clock += cost;
      });
    // 第一个事件慢到「12ms 预算 ÷ 50ms 代价 = 0」——若 K 会被当场重算，本帧立刻只剩 0/1 个。
    expect(push(0, 50)).toBe(true);
    // 同一个同步循环里继续投递：本帧冻结的 K=8 仍然成立，不许因为上面那 50ms 而缩小。
    for (let i = 1; i < 8; i += 1) {
      expect(push(i, 0), '第 ' + i + ' 个事件仍应落在本帧（K 已冻结）').toBe(true);
    }
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // 第 9 个才越界 → 排队（延后，不丢弃）。
    expect(push(8, 0)).toBe(false);
    frames.drain();
    expect(order, '延后的事件必须全部落地，顺序不变').toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // 下一帧的 K 才允许按上一帧的每事件均值（50/8 = 6.25ms → floor(12/6.25) = 1）缩小。
    expect(budget.stats().cap, '下一帧按上一帧均值收紧').toBe(1);
  });

  it('保序硬不变量：本帧一旦有积压，其后事件一律排队（不许插队）', () => {
    const frames = fakeFrames();
    let clock = 0;
    const budget = mod.createFrameBudget({
      budgetMs: 12,
      maxPerFrame: 1, // K = 1：第 2 个事件起必然排队
      now: () => clock,
      schedule: (cb) => frames.queue.push(cb),
    });
    const order: string[] = [];
    budget.push(() => { order.push('tool'); clock += 1; });
    const inline = budget.push(() => { order.push('tool_result'); clock += 1; });
    expect(inline, '预算用尽 → 必须排队').toBe(false);
    expect(order).toEqual(['tool']);
    frames.drain();
    expect(order, '结果必须在它的工具卡之后').toEqual(['tool', 'tool_result']);
  });
});

// ---- ③ 接线：真实 chat.ts 的轮次帧真的过预算 --------------------------------

type Listener = (e: { data: string }) => void;
class FakeES {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  seq = 0;
  private listeners = new Map<string, Listener[]>();
  constructor() { lastES = this; }
  addEventListener(name: string, fn: Listener): void {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  close(): void {}
  fire(name: string, payload: Record<string, unknown>): void {
    const env = { v: 2, session: LIVE, turn: 1, seq: this.seq++, payload };
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(env) });
  }
}
let lastES: FakeES | null = null;
const LIVE = 'test/w9113-budget';
// 骨架直接复用共用夹具（w795-dom 的 HTML 已满足 statusline 的 DockCells 全部单元）。
const HTML = FIXTURE_HTML;

describe('W9113 · ③ 真实 SSE 接线：一帧内到达的 200 个 tool 帧被切开', () => {
  beforeEach(() => {
    lastES = null;
    doc.body.innerHTML = HTML;
    vi.resetModules();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    vi.stubGlobal('EventSource', FakeES);
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, questions: [], messages: [] }) }));
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('同步投递 200 帧：同步落地量被切开；排空宏任务后 200 张全部到位且保序', async () => {
    const V = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as {
      initViewCtx(): void; ensurePane(id: string, k?: string, t?: string): { el: unknown };
      activatePane(id: string, k?: string, t?: string): unknown;
    };
    V.initViewCtx();
    const pane = V.ensurePane(LIVE, 'session', '甲会话');
    V.activatePane(LIVE, 'session', '甲会话');
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as { initRail(): void };
    rail.initRail();
    const chat = (await import(/* @vite-ignore */ at('chat.ts'))) as { connectSse(): void };
    chat.connectSse();

    const el = pane.el as unknown as { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> };
    // ★ 同步循环投递 200 帧 —— 这正是「一个帧里到达一批帧」的形状：改动前它们会在
    //   同一个任务里全部落地（584 个回调 → 7.9–9.4 秒的单帧）。
    for (let i = 0; i < 200; i += 1) {
      lastES?.fire('tool', { id: 'tc' + i, name: 'read_file', args: { path: 'f' + i + '.md', desc: '读取' } });
    }
    const inline = el.querySelectorAll('.msg.tool').length;
    expect(inline, '一帧内到达 200 个 tool 帧，绝不允许全部同步落地').toBeGreaterThan(0);
    expect(inline, '同步落地量必须被预算切开（< 200）').toBeLessThan(200);

    const cards = (): number => el.querySelectorAll('.msg.tool').length;
    await drainMacrotasks(() => cards() === 200);
    expect(cards(), '排空后一个都不能丢').toBe(200);
    // 保序：工具卡按投递顺序落在 DOM 里（结果不会排到它的卡之前）。
    const ids = Array.from(el.querySelectorAll('.msg.tool')).map((n) => n.textContent ?? '');
    const idx = (i: number): number => ids.findIndex((t) => t.includes('f' + i + '.md'));
    expect(idx(0), '第一张卡在第一位').toBe(0);
    for (let i = 1; i < 200; i += 1) {
      expect(idx(i), '第 ' + i + ' 张卡必须排在它前面那张之后').toBeGreaterThan(idx(i - 1));
    }
  });
});
