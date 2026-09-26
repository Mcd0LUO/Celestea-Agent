// @vitest-environment jsdom
/**
 * W9204 · rail 布局的两条纪律（真实 rail 模块 + 真实事件路径）。
 *
 * ① **建列不再是 N 次同步重排**（P1-1）：
 *    W9111 实测 1 200 列 21.9s、3 000 列 92.5s。根因不是「数组遍历慢」，而是
 *    railAdd 每列同步调一次 layout()，而 layout() 会为上一帧留下的 O(N) 个脏元素
 *    （对全部长条无条件写 display/top/--barh）付一次**强制同步重排** ⇒ O(N²)。
 *    本文件用**计数 stub** 把「写次数」变成可断言量（jsdom 支持 Proxy 包 style，
 *    见 tests/lib/w795-dom.ts 的 rafStub 与下面的 countTopWrites）。
 *      · 200 次 railAdd 只排 **1** 个 rAF（queueSync 去重）—— 旧实现排 0 个、同步排 200 次；
 *      · 帧跑完后一次几何变化，style.top 写次数 ≤ 窗口内条数（< 全部条数）；
 *      · 没有任何变化时整帧早退 ⇒ 0 次写。
 *
 * ② **摘高亮覆盖整轨**（P1-2）：
 *    真正的缺口是**折叠条** —— 它不在 st.items 里（只有 allItems 才含它），原先
 *    clearHover 遍历 st.items ⇒ 折叠条的高亮永远摘不掉。第二条用例是它的回归护栏，
 *    变异负控制实测：把 clearHover 改回 st.items 即变红。
 *    窗口外的条本来就在 st.items 里（窗口只影响 display），所以那条断言是**护栏**
 *    而非 bug 复现 —— 保留它是因为「摘高亮不看 visible」是这条修复的显式纪律。
 *
 * 变异负控制（把实现改坏一次，本文件必须变红）见报告 §变异红绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flushRaf, rafStub, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUND_H = 400;
const DOC_PAD = 8;

interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railSync(p: unknown): void;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface HintMod {
  initHints(): void;
  hintCardEl(): ElLike | null;
}

const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

interface Boot { main: ElLike; msgs: ElLike; pane: { el: ElLike } }

/** 装一个 N 轮的会话容器（几何全用固定 rect 桩，不依赖 jsdom 排版）。 */
async function boot(rounds: number): Promise<Boot> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  // W9204：rAF 接管成显式队列（真实浏览器里 rAF 与定时器是两个队列）。
  vi.stubGlobal('requestAnimationFrame', rafStub);
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  const main = doc.getElementById('main') as ElLike;
  (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const msgs = pane.el as unknown as ElLike;
  (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const gutterCol = doc.createElement('div') as unknown as ElLike;
  gutterCol.className = 'mcol';
  (gutterCol as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
  msgs.appendChild(gutterCol);
  const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
  rail.initRail();
  for (let i = 0; i < rounds; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    // 该轮的 rect 跟着 msgs.scrollTop 走 ⇒ docCenterY 恒定（见 rail-doc.ts）。
    (round as unknown as RectHost).getBoundingClientRect = () => {
      const st = Number((msgs as unknown as { scrollTop: number }).scrollTop);
      const top = DOC_PAD + i * ROUND_H - st;
      return rect(GUTTER, top, MAIN_W, top + ROUND_H);
    };
    const content = doc.createElement('div') as unknown as ElLike;
    content.className = 'content';
    content.textContent = '第 ' + (i + 1) + ' 轮提问';
    round.appendChild(content);
    msgs.appendChild(round);
    rail.railAdd(pane, round, 'user');
  }
  return { main, msgs, pane };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const topOf = (b: ElLike): string => String(b.style?.['top'] ?? '');
const barY = (i: number): number => Number.parseFloat(topOf(bars()[i]!)) + 2.5;

/**
 * 给每个长条的 style 包一层计数 Proxy（只数 `top` 的写入）。
 * jsdom 的 CSSStyleDeclaration 支持 defineProperty 覆盖（实测可用），Proxy 转发其余成员。
 */
function countTopWrites(): () => number {
  let n = 0;
  for (const b of bars()) {
    const real = (b as unknown as { style: Record<string, unknown> }).style;
    const px = new Proxy(real, {
      set(t, p, v) { if (p === 'top') n += 1; (t as Record<string, unknown>)[p as string] = v; return true; },
      get(t, p) {
        const v = (t as Record<string, unknown>)[p as string];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    Object.defineProperty(b, 'style', { value: px, configurable: true });
  }
  return () => n;
}

/** 真滚动 + 跑完 rail 的 rAF（不推进提示停留）。 */
function scrollTo(msgs: ElLike, top: number): void {
  (msgs as unknown as { scrollTop: number }).scrollTop = top;
  msgs.dispatchEvent(new Ev('scroll', { bubbles: false }));
  flushRaf();
}

/** 在 #main 上推一次指针（onMove → rAF → applyMove）。 */
function moveTo(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  flushRaf();
}

describe('W9204 ① · 建列不再 N 次同步重排（P1-1）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('200 次 railAdd 只排 1 个 rAF；帧跑完前长条没有位置（建列已异步合并）', async () => {
    const { main } = await boot(200);
    void main;
    // 建列尚未落位：top 还是空串（旧实现每列同步 layout，这里早有值）。
    expect(bars().length, '200 根长条都已登记').toBe(200);
    expect(topOf(bars()[0]!), '建列不再同步重排（位置要等这一帧）').toBe('');
    flushRaf();
    expect(topOf(bars()[0]!), '帧跑完后第一根条落位').not.toBe('');
    // 窗口分支：远端的条**没有**位置（它们被 display:none 隐藏，这正是「只处理窗口内」）。
    expect(topOf(bars()[199]!), '窗口外的条不写位置（旧实现会给全部条写）').toBe('');
    expect(bars()[199]?.style?.['display'], '窗口外的条被隐藏').toBe('none');
  });

  it('一次几何变化只写**窗口内**的条：style.top 写次数 ≤ shown.length < 全部条数', async () => {
    const { main, msgs, pane } = await boot(200);
    flushRaf();
    const N = bars().length;
    // 200 根 × 最密节距 4px = 800px > 可用高 ⇒ 走 viewWindow 分支，shown 远小于 N。
    const visibleBefore = bars().filter((b) => b.style?.['display'] !== 'none').length;
    expect(visibleBefore, '窗口只显示一部分（否则本用例测不到「不是全部条」）').toBeLessThan(N);
    const writes = countTopWrites();
    // 触发一次真实重排：消息区高度变了 ⇒ 节距/位置全变（但窗口外的条不该被写 top）。
    (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, 500);
    (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, 500);
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    rail.railSync(pane);
    flushRaf();
    const written = writes();
    expect(written, '必须真的重排了（否则这条断言空转）').toBeGreaterThan(0);
    expect(written, '写次数必须 ≤ 窗口内条数（脏检查：不碰窗口外的条）').toBeLessThanOrEqual(visibleBefore);
    expect(written, '远小于全部条数 —— 旧实现恒等于 N').toBeLessThan(N);
  });

  it('没有任何变化时整帧早退：0 次 style.top 写', async () => {
    const { msgs, pane } = await boot(200);
    flushRaf();
    const writes = countTopWrites();
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    rail.railSync(pane);
    flushRaf();
    rail.railSync(pane);
    flushRaf();
    expect(writes(), '几何与可见集都没变 ⇒ 一次 style 都不写（整帧早退）').toBe(0);
  });
});

describe('W9204 ② · 摘高亮覆盖整轨（P1-2）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('滚出窗口的条：离开条带后不得残留 .is-hover/.is-near（滚回可见时不复活）', async () => {
    // 200 轮：31 根条时 railFitsAll(584, 31) 仍为真（31×最密 4px = 124px），走的是
    // modeAll=true 分支 —— 必须让条数 × 最密节距真的超过可用高，才会进入 viewWindow。
    const { main, msgs } = await boot(200);
    flushRaf();
    expect(bars().length, '200 轮 + 折叠条').toBe(201);
    moveTo(main, 20, barY(1)); // 悬停第 1 轮（滚到顶时它在窗口内）
    expect(bars()[1]?.classList.contains('is-hover'), '悬停成立').toBe(true);
    scrollTo(msgs, 4000); // 把它推出窗口：layout 置 display:none，但类还留着（P1-2）
    expect(bars()[1]?.style?.['display'], '第 1 轮已滚出窗口（隐藏）').toBe('none');
    moveTo(main, MAIN_W - 5, 5); // 横向出带 ⇒ collapse() ⇒ clearHover()
    expect(bars()[1]?.classList.contains('is-hover'), '隐藏条上的 .is-hover 必须被摘掉').toBe(false);
    expect(bars().filter((b) => b.classList.contains('is-hover')).length, '整轨零高亮').toBe(0);
    expect(bars().filter((b) => b.classList.contains('is-near')).length, '整轨零 .is-near').toBe(0);
  });

  it('折叠条：离开条带后 .is-hover 必须被摘掉（它不在 st.items 里）', async () => {
    const { main } = await boot(30);
    flushRaf();
    const fold = doc.querySelector('#main .railv3-fold') as ElLike;
    expect(fold, '30 轮必须造出折叠条').not.toBeNull();
    moveTo(main, 20, Number.parseFloat(topOf(fold)) + 2.5);
    expect(fold.classList.contains('is-hover'), '折叠条可悬停').toBe(true);
    moveTo(main, MAIN_W - 5, 5); // 出带
    expect(fold.classList.contains('is-hover'), '折叠条的高亮必须被摘掉').toBe(false);
    expect(bars().filter((b) => b.classList.contains('is-hover')).length, '整轨零高亮').toBe(0);
  });
});
