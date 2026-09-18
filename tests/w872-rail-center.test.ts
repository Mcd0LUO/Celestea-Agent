// @vitest-environment jsdom
/**
 * W872/W886 · thread-rail「中间判定」（视口中间的常驻指示）。
 *
 * 语义（与 ui/rail-center.ts 的文件头口径一致）：
 *   · 消息滚动内容坐标 yDoc(轮) = 该轮 rect.top − 消息区 rect.top + scrollTop + 半高；
 *   · 视口中央 = scrollTop + 视口高 / 2（与轨道几何同源）；
 *   · 命中 = 与视口中央最近的那一根长条（拿到 .is-center），且**任何时刻最多一条**；
 *   · 命中的那一条同时携带用户语言提示（data-hint 含「视口中间」与轮次）；
 *   · 视口中央落在第一轮之前 / 最后一轮之后 ⇒ **没有** .is-center（端点兜底）。
 *
 * W886：用户否掉了 W872 的中间指示线（那条细横线）本身，判定保留 —— 因此这里不再
 * 断言线的存在/位置，改为断言「线不存在」+「命中条正确」+「换条时旧高亮摘掉」。
 *
 * 夹具沿用 tests/w867-rail-hit.test.ts 的写实桩（每轮一个 rect，滚动时 rect 跟着
 * scrollTop 走），因此「滚动」是真的滚动、不是改内部字段。几何刻意选成天然节距：
 * 4 轮 × 400px、视口 600px ⇒ 条心间隔恰为 9px（pitch = RAIL_PITCH_NATURAL）。
 *
 * 读数口径：条心 = 条 top + 半条高（与 w867 的 barY 同式）；命中条 = 条元素上的
 * .is-center 类。
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
}
interface CenterMod {
  railCenterHit(
    items: readonly { yDoc: number }[],
    yMid: number,
  ): { item: { yDoc: number } | null; clamped: boolean; round: number } | null;
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
const centerIdx = (): number => bars().findIndex((b) => b.classList.contains('is-center'));
/** 命中条数量：会话切换/换条后都不得残留多条。 */
const centerCount = (): number => doc.querySelectorAll('#main .is-center').length;
/** W886：中间指示线必须彻底不存在。 */
const midCount = (): number => doc.querySelectorAll('#main .railv3-mid').length;
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

describe('W872/W886 · rail 中间判定（视口中间指示，无指示线）', () => {
  beforeEach(() => { resetHarness(); resetHeights(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 线不存在：滚到顶时命中第 1 轮；端点之外没有 .is-center', async () => {
    const { rail, msgs, pane } = await bootRail();
    expect(midCount(), 'W886：中间指示线必须已不存在').toBe(0);
    expect(doc.querySelector('#main .railv3-mid'), '选择器查询也为 null').toBeNull();
    expect(bars().length, '夹具 4 轮').toBe(ROUNDS);
    // scrollTop = 0 ⇒ 视口中央 yDoc 300 离第 1 轮（yDoc 208）最近 ⇒ 命中第 1 轮
    expect(centerIdx(), '滚到顶时视口中央在第 1 轮上').toBe(0);
    expect(centerCount(), '同一时刻最多一条 .is-center').toBe(1);
    scrollTo(msgs, 0); // 再滚一次（同为顶）→ 判定必须稳定，不回跳
    expect(centerIdx()).toBe(0);
    expect(centerCount()).toBe(1);
    // 「刚进页」的另一种常见形态：第一轮比视口还高（长回答）⇒ 视口中央落在
    // **第一根条之前**：此时没有任何一轮被标成居中（端点兜底）。
    heights[0] = 1600;
    rail.railSync(pane);
    vi.advanceTimersByTime(50); // queueSync → layout
    scrollTo(msgs, 0);
    expect(centerIdx(), '端点之外没有「居中」条').toBe(-1);
    expect(centerCount(), '端点之外没有 .is-center').toBe(0);
    expect(midCount()).toBe(0);
  });

  it('② 滚到中间某轮：命中条跟着换，且提示文案挂在命中条上', async () => {
    const { msgs } = await bootRail();
    scrollTo(msgs, toCenter(2));
    expect(centerIdx(), '第 3 轮拿到 .is-center').toBe(2);
    expect(centerCount(), '最多一条').toBe(1);
    // 提示走注册缝（data-hint），挂在**命中条自身**（不是已删除的线）；用户语言且含轮次
    const hitHint = bars()[2]?.getAttribute('data-hint') ?? '';
    expect(hitHint, '命中条提示含轮次').toContain('第 3 轮');
    expect(hitHint, '命中条提示含「视口中间」').toContain('视口中间');
    expect(bars()[2]?.getAttribute('title'), '不得挂原生 title（会与卡片双弹）').toBeNull();
    // 逐轮推进：再滚到第 4 轮 → 命中条换成第 4 条，旧命中条摘掉高亮并复位文案
    scrollTo(msgs, toCenter(3) - 100);
    expect(centerIdx(), '视口中央最近第 4 轮').toBe(3);
    expect(bars()[2]?.classList.contains('is-center'), '旧命中条必须摘掉').toBe(false);
    expect(centerCount(), '换条后仍最多一条').toBe(1);
    expect(bars()[2]?.getAttribute('data-hint') ?? '', '旧命中条文案复位为常驻文案').not.toContain('视口中间');
    scrollTo(msgs, toCenter(3));
    expect(centerIdx(), '正中第 4 轮').toBe(3);
    expect(centerCount()).toBe(1);
    expect(bars()[3]?.getAttribute('data-hint') ?? '').toContain('第 4 轮');
  });

  it('③ 滚到底：命中最后一条；越过任一端点后没有 .is-center', async () => {
    const { msgs } = await bootRail();
    // 真实底部：scrollHeight − clientHeight（夹具内容高 = 2*PAD + ROUNDS*ROUND_H）
    Object.defineProperty(msgs, 'scrollHeight', { value: DOC_PAD * 2 + ROUNDS * ROUND_H, configurable: true });
    Object.defineProperty(msgs, 'clientHeight', { value: PANE_H, configurable: true });
    scrollTo(msgs, Number(msgs.scrollHeight) - PANE_H);
    expect(centerIdx(), '到底时视口中央在最后一轮上').toBe(ROUNDS - 1);
    expect(centerCount()).toBe(1);
    expect(midCount(), '到底也没有指示线').toBe(0);
    // 极端越界（惯性滚动 / 拉伸）：端点之外 ⇒ 没有任何一轮被标成居中
    scrollTo(msgs, 100000);
    expect(centerIdx(), '越过端点后没有「居中」条').toBe(-1);
    expect(centerCount(), '端点之外没有 .is-center').toBe(0);
    // 反向端点：滚到负值（回弹）同样没有命中条
    scrollTo(msgs, -500);
    expect(centerIdx()).toBe(-1);
    expect(centerCount()).toBe(0);
    // 最后一轮比视口还高（底部仍「还没读到最后一轮」）：同样没有命中条
    heights[ROUNDS - 1] = 1600;
    Object.defineProperty(msgs, 'scrollHeight', { value: DOC_PAD * 2 + ROUND_H * (ROUNDS - 1) + 1600, configurable: true });
    scrollTo(msgs, Number(msgs.scrollHeight) - PANE_H);
    expect(centerIdx(), '「还没读到最后一轮」时没有「居中」条').toBe(-1);
    expect(centerCount()).toBe(0);
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

  it('⑤ 纯函数口径：最近命中 / 端点兜底 / 空轨道；不再产出线位置 y（ui/rail-center.ts）', async () => {
    const c = (await import(/* @vite-ignore */ at('ui/rail-center.ts'))) as CenterMod;
    const items = [{ yDoc: 0 }, { yDoc: 100 }];
    expect(c.railCenterHit([], 50), '空轨道没有判定结果').toBeNull();
    expect(c.railCenterHit(items, 0), '正中第一根').toMatchObject({ clamped: false, round: 1 });
    expect(c.railCenterHit(items, 0)?.item, 'item 就是命中的那一条').toBe(items[0]);
    expect(c.railCenterHit(items, 100), '正中最后一根').toMatchObject({ clamped: false, round: 2 });
    expect(c.railCenterHit(items, 50), '两根之间：同距取靠上的一根').toMatchObject({ clamped: false, round: 1 });
    expect(c.railCenterHit(items, 60), '过中点后换命中').toMatchObject({ clamped: false, round: 2 });
    expect(c.railCenterHit(items, -50), '第一根之前：无命中').toMatchObject({ item: null, clamped: true, round: -1 });
    expect(c.railCenterHit(items, 999), '最后一根之后：无命中').toMatchObject({ item: null, clamped: true, round: -1 });
    // W886：线没了 ⇒ 判定结果不再含线位置字段（防止死代码回流）
    expect(c.railCenterHit(items, 50), '不得再有 y 字段').not.toHaveProperty('y');
    expect(c.railCenterLabel({ round: 3, clamped: false })).toBe('第 3 轮附近（视口中间）');
    expect(c.railCenterLabel({ round: -1, clamped: true }, 0)).toBe('视口中间 · 在这几轮之外');
    expect(c.railCenterLabel({ round: 1, clamped: false }, 7), '折叠条另有文案').toContain('更早的 7 轮');
  });
});
