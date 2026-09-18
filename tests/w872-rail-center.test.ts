// @vitest-environment jsdom
/**
 * W872 · thread-rail「中间判定」（视口中间的常驻指示）。
 *
 * 语义（与 ui/rail-center.ts 的文件头口径一致）：
 *   · 消息滚动内容坐标 yDoc(轮) = 该轮 rect.top − 消息区 rect.top + scrollTop + 半高；
 *   · 视口中央 = scrollTop + 视口高 / 2（与轨道几何同源）；
 *   · 命中 = 与视口中央最近的那一根长条（拿到 .is-center）；
 *   · 指示线在相邻两根条心之间按 doc 坐标**线性插值**（条心之间的空隙如实显示，
 *     「视口中央落在哪一根上 / 落在哪两根之间」两件事都能从线上读出来）；
 *   · 视口中央落在第一轮之前 / 最后一轮之后 ⇒ 线夹在首/末条心（clamped、无命中）。
 *
 * 夹具沿用 tests/w867-rail-hit.test.ts 的写实桩（每轮一个 rect，滚动时 rect 跟着
 * scrollTop 走），因此「滚动」是真的滚动、不是改内部字段。几何刻意选成天然节距：
 * 4 轮 × 400px、视口 600px ⇒ 条心间隔恰为 9px（pitch = RAIL_PITCH_NATURAL），
 * 断言用相对关系（line 在首/末两条心之间），不写魔数。
 *
 * 读数口径：条心 = 条 top + 半条高（与 w867 的 barY 同式）；线位置 = 指示线的
 * transform translateY（单值写入、不重建 DOM）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUNDS = 4;
const ROUND_H = 400;
const DOC_PAD = 8;
const BAR_H = 5;

/** 第 i 轮（0 起）条心在「消息滚动内容坐标」里的 Y —— 夹具造的就是这个值。 */
const yDoc = (i: number): number => DOC_PAD + i * ROUND_H + ROUND_H / 2;
const lastYDOC = (): number => DOC_PAD + (ROUNDS - 1) * ROUND_H + ROUND_H / 2;
/** 让第 i 轮正好落在视口中央所需的 scrollTop。 */
const toCenter = (i: number): number => yDoc(i) - PANE_H / 2;

interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
/** 消息容器要用到的滚动字段（根 tsconfig 无 DOM lib，测试一律最小结构类型）。 */
type MsgsEl = ElLike & { scrollTop: number; scrollHeight: number; clientHeight: number };
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railSync(p: unknown): void;
  RAIL_MID_SEL: string;
}
interface CenterMod {
  railCenterHit(
    items: readonly { y: number; yDoc: number }[],
    yMid: number,
  ): { item: { y: number } | null; y: number; clamped: boolean; round: number } | null;
  railCenterLabel(hit: { round: number; clamped: boolean }, fold?: number): string;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}

const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 每轮高（可改：用来造「第一轮比视口还高」的刚进页形态；beforeEach 复位）。 */
const heights = [ROUND_H, ROUND_H, ROUND_H, ROUND_H];
const resetHeights = (): void => { for (let i = 0; i < heights.length; i++) heights[i] = ROUND_H; };
/** 每轮内容顶（累加高度），用来算第 i 轮的 rect。 */
function topOf(i: number): number {
  let y = DOC_PAD;
  for (let k = 0; k < i; k++) y += heights[k] ?? ROUND_H;
  return y;
}
/** 每轮的 rect 跟着 msgs.scrollTop 走（= 真的滚动了这些轮）。 */
function roundRect(i: number, scrollTop: number): RectLike {
  const t = topOf(i) - scrollTop;
  return rect(GUTTER, t, MAIN_W, t + (heights[i] ?? ROUND_H));
}

interface Boot { rail: RailMod; main: ElLike; msgs: MsgsEl; pane: { el: ElLike } }

/** 装一个「有条带、有留白、有 ROUNDS 轮真实 rect」的会话容器（同 w867 夹具）。 */
async function bootRail(): Promise<Boot> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  const main = doc.getElementById('main') as ElLike;
  (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const msgs = pane.el as unknown as MsgsEl;
  (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const gutterCol = doc.createElement('div') as unknown as ElLike;
  gutterCol.className = 'mcol';
  (gutterCol as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
  msgs.appendChild(gutterCol);
  const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
  rail.initRail();
  for (let i = 0; i < ROUNDS; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    (round as unknown as RectHost).getBoundingClientRect = () => roundRect(i, Number(msgs.scrollTop));
    const content = doc.createElement('div') as unknown as ElLike;
    content.className = 'content';
    content.textContent = '第 ' + (i + 1) + ' 轮提问';
    round.appendChild(content);
    msgs.appendChild(round);
    rail.railAdd(pane, round, 'user');
  }
  // 排空 activatePane 的「贴底」rAF：它会把 scrollTop 写回 0（浏览器里用户滚动后
  // 不会再有这一帧）。之后本夹具的每一次滚动都只由测试驱动，读数才可信。
  vi.advanceTimersByTime(50);
  return { rail, main, msgs, pane };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['top'])) + BAR_H / 2;
const midEl = (): ElLike | null => doc.querySelector('#main .railv3-mid') as ElLike | null;
/** 指示线的位置（transform 的单值写入，不依赖 jsdom 的布局）。 */
const midY = (): number => Number.parseFloat((String(midEl()?.style?.['transform']) || '').replace(/[^0-9.-]/g, ''));
const centerIdx = (): number => bars().findIndex((b) => b.classList.contains('is-center'));
const barW = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['width']));

/** 真滚动：改 scrollTop + 派发 scroll，再跑完 rail 的 rAF 节流。 */
function scrollTo(msgs: MsgsEl, top: number): void {
  msgs.scrollTop = top;
  msgs.dispatchEvent(new Ev('scroll', { bubbles: false }));
  vi.advanceTimersByTime(50); // rail 的 queueMid/queueSync rAF
}

/** 在 #main 上推一次指针（rail 的 onMove → rAF → applyMove fisheye）。 */
function moveTo(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  vi.advanceTimersByTime(200);
}

describe('W872 · rail 中间判定（视口中间指示）', () => {
  beforeEach(() => { resetHarness(); resetHeights(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 初始/滚到顶：指示线存在且落在第一根条附近；端点之外不停用、不越界、不抖动', async () => {
    const { rail, msgs, pane } = await bootRail();
    const mid = midEl();
    expect(mid, '中间指示线必须存在（' + rail.RAIL_MID_SEL + '）').not.toBeNull();
    expect(mid?.style?.['visibility'], '有条可判时不得隐藏').not.toBe('hidden');
    expect(bars().length, '夹具 4 轮').toBe(ROUNDS);
    // scrollTop = 0 ⇒ 视口中央 yDoc 300 落在第 1 轮（yDoc 208）与第 2 轮（608）之间，
    // 离第 1 轮最近 ⇒ 命中第 1 轮；线在两条心之间（首条心之上、第二条心之下）。
    expect(centerIdx(), '滚到顶时视口中央在第 1 轮上').toBe(0);
    expect(midY(), '线不早于第 1 根条心').toBeGreaterThanOrEqual(barY(0) - 0.001);
    expect(midY(), '线不越过第 2 根条心').toBeLessThanOrEqual(barY(1) + 0.001);
    const atTop = midY(); // 线位置由 transform 的 toFixed(1) 写入，读数取整到 0.1px
    scrollTo(msgs, 0); // 再滚一次（同为顶）→ 位置必须稳定，不回跳
    expect(midY(), '顶部的重复读数稳定').toBe(atTop);
    expect(centerIdx()).toBe(0);
    // 「刚进页」的另一种常见形态：第一轮比视口还高（长回答）⇒ 视口中央落在
    // **第一根条之前**：线如实停在第一根条上，且此时没有任何一轮被标成居中。
    heights[0] = 1600;
    rail.railSync(pane);
    vi.advanceTimersByTime(50); // queueSync → layout
    scrollTo(msgs, 0);
    expect(midEl()?.style?.['visibility'], '端点之外也不得隐藏').not.toBe('hidden');
    expect(midY(), '线停在第一根条上').toBeCloseTo(barY(0), 5);
    expect(midEl()?.classList.contains('is-out'), '端点态：线降一档对比（不是消失）').toBe(true);
    expect(centerIdx(), '端点之外没有「居中」条').toBe(-1);
  });

  it('② 滚到中间某轮：指示线随滚动更新，命中条拿到「居中」态与用户语言提示', async () => {
    const { msgs } = await bootRail();
    const y0 = midY();
    scrollTo(msgs, toCenter(2));
    expect(midY(), '指示线跟着滚动走').not.toBeCloseTo(y0, 5);
    expect(midY(), '正中第 3 轮时线就在第 3 根条心').toBeCloseTo(barY(2), 5);
    expect(centerIdx(), '第 3 轮拿到 .is-center').toBe(2);
    // 提示走注册缝（data-hint），不是原生 title；文案是用户语言且含轮次
    expect(midEl()?.getAttribute('data-hint') ?? '').toContain('第 3 轮');
    expect(midEl()?.getAttribute('data-hint') ?? '').toContain('视口中间');
    expect(midEl()?.getAttribute('title'), '不得挂原生 title（会与卡片双弹）').toBeNull();
    // 逐轮推进：再滚到第 4 轮（线落在第 3/第 4 条心之间 ⇒ 指示「在两轮之间」）
    scrollTo(msgs, toCenter(3) - 100);
    expect(centerIdx(), '视口中央仍最近第 4 轮').toBe(3);
    expect(midY()).toBeGreaterThan(barY(2));
    expect(midY()).toBeLessThan(barY(3));
    expect(bars()[2]?.classList.contains('is-center'), '旧命中条必须摘掉').toBe(false);
    scrollTo(msgs, toCenter(3));
    expect(midY(), '正中第 4 轮时线回到第 4 根条心').toBeCloseTo(barY(3), 5);
    expect(centerIdx()).toBe(3);
  });

  it('③ 滚到底：指示线落在最后一根条附近（不是消失、不是越界）', async () => {
    const { msgs } = await bootRail();
    // 真实底部：scrollHeight − clientHeight（夹具内容高 = 2*PAD + ROUNDS*ROUND_H）
    Object.defineProperty(msgs, 'scrollHeight', { value: DOC_PAD * 2 + ROUNDS * ROUND_H, configurable: true });
    Object.defineProperty(msgs, 'clientHeight', { value: PANE_H, configurable: true });
    scrollTo(msgs, Number(msgs.scrollHeight) - PANE_H);
    expect(midEl(), '到底时指示线仍在').not.toBeNull();
    expect(midEl()?.style?.['visibility'], '到底时不得隐藏').not.toBe('hidden');
    expect(centerIdx(), '到底时视口中央在最后一轮上').toBe(ROUNDS - 1);
    expect(midY(), '线落在最后一根条附近（末两条心之间）').toBeGreaterThan(barY(ROUNDS - 2) - 0.001);
    expect(midY(), '线不越过最后一根条心').toBeLessThanOrEqual(barY(ROUNDS - 1) + 0.001);
    // 极端越界（惯性滚动 / 拉伸）：仍如实停在末条心，且没有任何一轮被标成居中
    scrollTo(msgs, 100000);
    expect(midY(), '越过端点后夹在末条心').toBeCloseTo(barY(ROUNDS - 1), 5);
    expect(midEl()?.style?.['visibility']).not.toBe('hidden');
    expect(midEl()?.classList.contains('is-out'), '端点态：线降一档对比').toBe(true);
    expect(centerIdx(), '端点之外没有「居中」条').toBe(-1);
    // 反向端点：滚到负值（回弹）同样夹在首条心
    scrollTo(msgs, -500);
    expect(midY(), '越过起点后夹在首条心').toBeCloseTo(barY(0), 5);
    expect(centerIdx()).toBe(-1);
    // 最后一轮比视口还高（底部仍「还没读到最后一轮」）：同样夹在末条心
    heights[ROUNDS - 1] = 1600;
    Object.defineProperty(msgs, 'scrollHeight', { value: DOC_PAD * 2 + ROUND_H * (ROUNDS - 1) + 1600, configurable: true });
    scrollTo(msgs, Number(msgs.scrollHeight) - PANE_H);
    expect(midY(), '底部仍在端点之外 ⇒ 线停在末条心').toBeCloseTo(barY(ROUNDS - 1), 5);
    expect(centerIdx(), '「还没读到最后一轮」时没有「居中」条').toBe(-1);
  });

  it('④ 「居中」态不改变条长：命中条与邻居宽度不受影响（与 fisheye 解耦）', async () => {
    const { main, msgs } = await bootRail();
    // 先让所有条都经过一次 fisheye 写入（宽度全为静止刻度 4px）
    moveTo(main, 20, barY(0));
    moveTo(main, MAIN_W - 5, 5); // 横向出带 → collapse()
    const before = bars().map((_, i) => barW(i));
    const tops = bars().map((b) => String(b.style?.['top']));
    expect(before.every((w) => w === before[0]), '静止态宽度一致').toBe(true);
    expect(before[0], '静止刻度 = rail-geom 的 RAIL_BASE_W').toBe(4);
    scrollTo(msgs, toCenter(1));
    expect(centerIdx()).toBe(1);
    expect(bars().map((_, i) => barW(i)), '「居中」态一个像素都不改条长').toEqual(before);
    expect(bars().map((b) => String(b.style?.['top'])), '也不改条位').toEqual(tops);
    // 换一轮居中：命中条、邻居、其余条的宽度照样一字不动
    scrollTo(msgs, toCenter(3));
    expect(centerIdx()).toBe(3);
    expect(bars().map((_, i) => barW(i))).toEqual(before);
    // fisheye 仍照常工作：指针悬停第 1 条 → 它变长，且换「居中」条不影响它的长度
    moveTo(main, 20, barY(0));
    const hoverW = bars().map((_, i) => barW(i));
    expect(hoverW[0]).toBeGreaterThan(before[0]!);
    scrollTo(msgs, toCenter(2));
    expect(centerIdx()).toBe(2);
    expect(bars().map((_, i) => barW(i)), '悬停长度不因「居中」条变化而变').toEqual(hoverW);
  });

  it('⑤ 纯函数口径：最近命中 / 相邻插值 / 端点兜底 / 空轨道（ui/rail-center.ts）', async () => {
    const c = (await import(/* @vite-ignore */ at('ui/rail-center.ts'))) as CenterMod;
    const items = [{ y: 10, yDoc: 0 }, { y: 20, yDoc: 100 }];
    expect(c.railCenterHit([], 50), '空轨道没有判定结果').toBeNull();
    expect(c.railCenterHit(items, 0), '正中第一根').toMatchObject({ y: 10, clamped: false, round: 1 });
    expect(c.railCenterHit(items, 100), '正中最后一根').toMatchObject({ y: 20, clamped: false, round: 2 });
    expect(c.railCenterHit(items, 50), '两根之间：线在中间插值，同距取靠上的一根').toMatchObject({ y: 15, clamped: false, round: 1 });
    expect(c.railCenterHit(items, 60), '过中点后换命中').toMatchObject({ y: 16, clamped: false, round: 2 });
    expect(c.railCenterHit(items, -50), '第一根之前：夹在首条心').toMatchObject({ item: null, y: 10, clamped: true, round: -1 });
    expect(c.railCenterHit(items, 999), '最后一根之后：夹在末条心').toMatchObject({ item: null, y: 20, clamped: true, round: -1 });
    expect(c.railCenterLabel({ round: 3, clamped: false })).toBe('第 3 轮附近（视口中间）');
    expect(c.railCenterLabel({ round: -1, clamped: true }, 0)).toBe('视口中间 · 在这几轮之外');
    expect(c.railCenterLabel({ round: 1, clamped: false }, 7), '折叠条另有文案').toContain('更早的 7 轮');
  });
});
