// @vitest-environment jsdom
/**
 * W896 测试收敛：合并 2 个同环境、同夹具的分域测试文件。
 * 来源（纯搬运，用例与断言逐字未改）：
 *   - tests/w872-rail-center.test.ts
 *   - tests/w872-rail-indicator-unique.test.ts
 *
 * 为什么合并：这些小文件各只装 3–8 条用例，却各自付一次 fork 启动 + 环境构建
 * （实测 ~426ms/文件）。合并后仍由同一 vitest project 收集，覆盖不变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, doc, Ev, resetHarness, type ElLike } from "./lib/w795-dom.js";

/* ===== w872-rail-center.test.ts ===== */
/**
 * W872/W886 · thread-rail「中间判定」（视口中间的常驻指示）。
 *
 * 语义（与 ui/rail-center.ts 的文件头口径一致）：
 *   · 消息滚动内容坐标 yDoc(轮) = 该轮 f0_rect.top − 消息区 f0_rect.top + scrollTop + 半高；
 *   · 视口中央 = scrollTop + 视口高 / 2（与轨道几何同源）；
 *   · 命中 = 与视口中央最近的那一根长条（拿到 .is-center），且**任何时刻最多一条**；
 *   · 命中的那一条同时携带用户语言提示（data-hint 含「视口中间」与轮次）；
 *   · 视口中央落在第一轮之前 / 最后一轮之后 ⇒ **没有** .is-center（端点兜底）。
 *
 * W886：用户否掉了 W872 的中间指示线（那条细横线）本身，判定保留 —— 因此这里不再
 * 断言线的存在/位置，改为断言「线不存在」+「命中条正确」+「换条时旧高亮摘掉」。
 *
 * 夹具沿用 tests/w867-rail-hit.test.ts 的写实桩（每轮一个 f0_rect，滚动时 f0_rect 跟着
 * scrollTop 走），因此「滚动」是真的滚动、不是改内部字段。几何刻意选成天然节距：
 * 4 轮 × 400px、视口 600px ⇒ 条心间隔恰为 9px（pitch = RAIL_PITCH_NATURAL）。
 *
 * 读数口径：条心 = 条 top + 半条高（与 w867 的 barY 同式）；命中条 = 条元素上的
 * .is-center 类。
 */

const f0_MAIN_W = 900;
const f0_PANE_H = 600;
const f0_GUTTER = 100;
const ROUNDS = 4;
const f0_ROUND_H = 400;
const f0_DOC_PAD = 8;
const BAR_H = 5;

/** 第 i 轮（0 起）条心在「消息滚动内容坐标」里的 Y —— 夹具造的就是这个值。 */
const yDoc = (i: number): number => f0_DOC_PAD + i * f0_ROUND_H + f0_ROUND_H / 2;
/** 让第 i 轮正好落在视口中央所需的 scrollTop。 */
const toCenter = (i: number): number => yDoc(i) - f0_PANE_H / 2;

interface f0_RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface f0_RectHost { getBoundingClientRect(): f0_RectLike }
/** 消息容器要用到的滚动字段（根 tsconfig 无 DOM lib，测试一律最小结构类型）。 */
type f0_MsgsEl = ElLike & { scrollTop: number; scrollHeight: number; clientHeight: number };
interface f0_RailMod {
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
interface f0_ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}

const f0_rect = (l: number, t: number, r: number, b: number): f0_RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 每轮高（可改：用来造「第一轮比视口还高」的刚进页形态；beforeEach 复位）。 */
const heights = [f0_ROUND_H, f0_ROUND_H, f0_ROUND_H, f0_ROUND_H];
const resetHeights = (): void => { for (let i = 0; i < heights.length; i++) heights[i] = f0_ROUND_H; };
/** 每轮内容顶（累加高度），用来算第 i 轮的 f0_rect。 */
function topOf(i: number): number {
  let y = f0_DOC_PAD;
  for (let k = 0; k < i; k++) y += heights[k] ?? f0_ROUND_H;
  return y;
}
/** 每轮的 f0_rect 跟着 msgs.scrollTop 走（= 真的滚动了这些轮）。 */
function roundRect(i: number, scrollTop: number): f0_RectLike {
  const t = topOf(i) - scrollTop;
  return f0_rect(f0_GUTTER, t, f0_MAIN_W, t + (heights[i] ?? f0_ROUND_H));
}

interface Boot { rail: f0_RailMod; main: ElLike; msgs: f0_MsgsEl; pane: { el: ElLike } }

/** 装一个「有条带、有留白、有 ROUNDS 轮真实 f0_rect」的会话容器（同 w867 夹具）。 */
async function bootRail(): Promise<Boot> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as f0_ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');
  const main = doc.getElementById('main') as ElLike;
  (main as unknown as f0_RectHost).getBoundingClientRect = () => f0_rect(0, 0, f0_MAIN_W, f0_PANE_H);
  const msgs = pane.el as unknown as f0_MsgsEl;
  (msgs as unknown as f0_RectHost).getBoundingClientRect = () => f0_rect(0, 0, f0_MAIN_W, f0_PANE_H);
  const gutterCol = doc.createElement('div') as unknown as ElLike;
  gutterCol.className = 'mcol';
  (gutterCol as unknown as f0_RectHost).getBoundingClientRect = () => f0_rect(f0_GUTTER, 0, f0_MAIN_W, f0_PANE_H);
  msgs.appendChild(gutterCol);
  const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as f0_RailMod;
  rail.initRail();
  for (let i = 0; i < ROUNDS; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    (round as unknown as f0_RectHost).getBoundingClientRect = () => roundRect(i, Number(msgs.scrollTop));
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

const f0_bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(f0_bars()[i]?.style?.['top'])) + BAR_H / 2;
const f0_centerIdx = (): number => f0_bars().findIndex((b) => b.classList.contains('is-center'));
/** 命中条数量：会话切换/换条后都不得残留多条。 */
const f0_centerCount = (): number => doc.querySelectorAll('#main .is-center').length;
/** W886：中间指示线必须彻底不存在。 */
const f0_midCount = (): number => doc.querySelectorAll('#main .railv3-mid').length;
const barW = (i: number): number => Number.parseFloat(String(f0_bars()[i]?.style?.['width']));

/** 真滚动：改 scrollTop + 派发 scroll，再跑完 rail 的 rAF 节流。 */
function f0_scrollTo(msgs: f0_MsgsEl, top: number): void {
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
    expect(f0_midCount(), 'W886：中间指示线必须已不存在').toBe(0);
    expect(doc.querySelector('#main .railv3-mid'), '选择器查询也为 null').toBeNull();
    expect(f0_bars().length, '夹具 4 轮').toBe(ROUNDS);
    // scrollTop = 0 ⇒ 视口中央 yDoc 300 离第 1 轮（yDoc 208）最近 ⇒ 命中第 1 轮
    expect(f0_centerIdx(), '滚到顶时视口中央在第 1 轮上').toBe(0);
    expect(f0_centerCount(), '同一时刻最多一条 .is-center').toBe(1);
    f0_scrollTo(msgs, 0); // 再滚一次（同为顶）→ 判定必须稳定，不回跳
    expect(f0_centerIdx()).toBe(0);
    expect(f0_centerCount()).toBe(1);
    // 「刚进页」的另一种常见形态：第一轮比视口还高（长回答）⇒ 视口中央落在
    // **第一根条之前**：此时没有任何一轮被标成居中（端点兜底）。
    heights[0] = 1600;
    rail.railSync(pane);
    vi.advanceTimersByTime(50); // queueSync → layout
    f0_scrollTo(msgs, 0);
    expect(f0_centerIdx(), '端点之外没有「居中」条').toBe(-1);
    expect(f0_centerCount(), '端点之外没有 .is-center').toBe(0);
    expect(f0_midCount()).toBe(0);
  });

  it('② 滚到中间某轮：命中条跟着换，且提示文案挂在命中条上', async () => {
    const { msgs } = await bootRail();
    f0_scrollTo(msgs, toCenter(2));
    expect(f0_centerIdx(), '第 3 轮拿到 .is-center').toBe(2);
    expect(f0_centerCount(), '最多一条').toBe(1);
    // 提示走注册缝（data-hint），挂在**命中条自身**（不是已删除的线）；用户语言且含轮次
    const hitHint = f0_bars()[2]?.getAttribute('data-hint') ?? '';
    expect(hitHint, '命中条提示含轮次').toContain('第 3 轮');
    expect(hitHint, '命中条提示含「视口中间」').toContain('视口中间');
    expect(f0_bars()[2]?.getAttribute('title'), '不得挂原生 title（会与卡片双弹）').toBeNull();
    // 逐轮推进：再滚到第 4 轮 → 命中条换成第 4 条，旧命中条摘掉高亮并复位文案
    f0_scrollTo(msgs, toCenter(3) - 100);
    expect(f0_centerIdx(), '视口中央最近第 4 轮').toBe(3);
    expect(f0_bars()[2]?.classList.contains('is-center'), '旧命中条必须摘掉').toBe(false);
    expect(f0_centerCount(), '换条后仍最多一条').toBe(1);
    expect(f0_bars()[2]?.getAttribute('data-hint') ?? '', '旧命中条文案复位为常驻文案').not.toContain('视口中间');
    f0_scrollTo(msgs, toCenter(3));
    expect(f0_centerIdx(), '正中第 4 轮').toBe(3);
    expect(f0_centerCount()).toBe(1);
    expect(f0_bars()[3]?.getAttribute('data-hint') ?? '').toContain('第 4 轮');
  });

  it('③ 滚到底：命中最后一条；越过任一端点后没有 .is-center', async () => {
    const { msgs } = await bootRail();
    // 真实底部：scrollHeight − clientHeight（夹具内容高 = 2*PAD + ROUNDS*f0_ROUND_H）
    Object.defineProperty(msgs, 'scrollHeight', { value: f0_DOC_PAD * 2 + ROUNDS * f0_ROUND_H, configurable: true });
    Object.defineProperty(msgs, 'clientHeight', { value: f0_PANE_H, configurable: true });
    f0_scrollTo(msgs, Number(msgs.scrollHeight) - f0_PANE_H);
    expect(f0_centerIdx(), '到底时视口中央在最后一轮上').toBe(ROUNDS - 1);
    expect(f0_centerCount()).toBe(1);
    expect(f0_midCount(), '到底也没有指示线').toBe(0);
    // 极端越界（惯性滚动 / 拉伸）：端点之外 ⇒ 没有任何一轮被标成居中
    f0_scrollTo(msgs, 100000);
    expect(f0_centerIdx(), '越过端点后没有「居中」条').toBe(-1);
    expect(f0_centerCount(), '端点之外没有 .is-center').toBe(0);
    // 反向端点：滚到负值（回弹）同样没有命中条
    f0_scrollTo(msgs, -500);
    expect(f0_centerIdx()).toBe(-1);
    expect(f0_centerCount()).toBe(0);
    // 最后一轮比视口还高（底部仍「还没读到最后一轮」）：同样没有命中条
    heights[ROUNDS - 1] = 1600;
    Object.defineProperty(msgs, 'scrollHeight', { value: f0_DOC_PAD * 2 + f0_ROUND_H * (ROUNDS - 1) + 1600, configurable: true });
    f0_scrollTo(msgs, Number(msgs.scrollHeight) - f0_PANE_H);
    expect(f0_centerIdx(), '「还没读到最后一轮」时没有「居中」条').toBe(-1);
    expect(f0_centerCount()).toBe(0);
  });

  it('④ 「居中」态不改变条长：命中条与邻居宽度不受影响（与 fisheye 解耦）', async () => {
    const { main, msgs } = await bootRail();
    // 先让所有条都经过一次 fisheye 写入（宽度全为静止刻度 4px）
    moveTo(main, 20, barY(0));
    moveTo(main, f0_MAIN_W - 5, 5); // 横向出带 → collapse()
    const before = f0_bars().map((_, i) => barW(i));
    const tops = f0_bars().map((b) => String(b.style?.['top']));
    expect(before.every((w) => w === before[0]), '静止态宽度一致').toBe(true);
    expect(before[0], '静止刻度 = rail-geom 的 RAIL_BASE_W').toBe(4);
    f0_scrollTo(msgs, toCenter(1));
    expect(f0_centerIdx()).toBe(1);
    expect(f0_bars().map((_, i) => barW(i)), '「居中」态一个像素都不改条长').toEqual(before);
    expect(f0_bars().map((b) => String(b.style?.['top'])), '也不改条位').toEqual(tops);
    // 换一轮居中：命中条、邻居、其余条的宽度照样一字不动
    f0_scrollTo(msgs, toCenter(3));
    expect(f0_centerIdx()).toBe(3);
    expect(f0_bars().map((_, i) => barW(i))).toEqual(before);
    // fisheye 仍照常工作：指针悬停第 1 条 → 它变长，且换「居中」条不影响它的长度
    moveTo(main, 20, barY(0));
    const hoverW = f0_bars().map((_, i) => barW(i));
    expect(hoverW[0]).toBeGreaterThan(before[0]!);
    f0_scrollTo(msgs, toCenter(2));
    expect(f0_centerIdx()).toBe(2);
    expect(f0_bars().map((_, i) => barW(i)), '悬停长度不因「居中」条变化而变').toEqual(hoverW);
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

/* ===== w872-rail-indicator-unique.test.ts ===== */
/**
 * W872/W886 · 中间判定命中条的**整轨唯一性**（会话来回切换不得残留多条 .is-center）。
 *
 * 这条用例来自 W872 自查时的一次真实发现，不是补充装饰：`railActivate` 的会话切换是
 * 「整批搬轨道子节点」。W872 时代被搬走的是那条指示线（.railv3-mid），会攒出第二条；
 * W886 线没了，同一个搬运动作现在作用于**命中条的高亮**：切走的会话里若有一条
 * .is-center，引用被复位（centerItem = null）后高亮却留在节点上 —— 切回该会话时，
 * 新命中的条会与它同时带着 .is-center（同一轨出现两条高亮 = 判定自相矛盾）。
 * 修复：`railActivate` 在整批搬家前先摘掉旧命中条的高亮。
 *
 * 本用例同时覆盖两条摘除路径（任一被去掉都会红）：
 *   ① 同一会话内换命中：syncCenter 必须摘掉上一条的 .is-center；
 *   ② 跨会话切换：railActivate 必须摘掉即将被搬走的命中条的高亮。
 */

const f1_MAIN_W = 900;
const f1_PANE_H = 600;
const f1_GUTTER = 100;
const f1_ROUND_H = 400;
const f1_DOC_PAD = 8;

interface f1_RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface f1_RectHost { getBoundingClientRect(): f1_RectLike }
type f1_MsgsEl = ElLike & { scrollTop: number; scrollHeight: number; clientHeight: number };
interface f1_RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railActivate(p: unknown): void;
}
interface PaneLike { el: ElLike }
interface f1_ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
const f1_rect = (l: number, t: number, r: number, b: number): f1_RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

const f1_bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const f1_centerCount = (): number => doc.querySelectorAll('#main .is-center').length;
const f1_centerIdx = (): number => f1_bars().findIndex((b) => b.classList.contains('is-center'));
const f1_midCount = (): number => doc.querySelectorAll('#main .railv3-mid').length;

/** 真滚动：改 scrollTop + 派发 scroll，再跑完 rail 的 rAF 节流。 */
function f1_scrollTo(host: ElLike, top: number): void {
  (host as unknown as f1_MsgsEl).scrollTop = top;
  host.dispatchEvent(new Ev('scroll', { bubbles: false }));
  vi.advanceTimersByTime(50);
}

describe('W872/W886 · 中间判定命中条整轨唯一（会话切换不攒第二条高亮）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('A→B→A 之后任何时刻最多一条 .is-center', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
    hint.initHints();
    const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as f1_ViewCtxMod;
    ctx.initViewCtx();
    const a = ctx.ensurePane('ws/s1', 'session', 'jia');
    ctx.activatePane('ws/s1', 'session', 'jia');
    const main = doc.getElementById('main') as ElLike;
    (main as unknown as f1_RectHost).getBoundingClientRect = () => f1_rect(0, 0, f1_MAIN_W, f1_PANE_H);
    const wirePane = (pane: PaneLike): void => {
      (pane.el as unknown as f1_RectHost).getBoundingClientRect = () => f1_rect(0, 0, f1_MAIN_W, f1_PANE_H);
      const col = doc.createElement('div') as unknown as ElLike;
      col.className = 'mcol';
      (col as unknown as f1_RectHost).getBoundingClientRect = () => f1_rect(f1_GUTTER, 0, f1_MAIN_W, f1_PANE_H);
      pane.el.appendChild(col);
    };
    wirePane(a);
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as f1_RailMod;
    rail.initRail();
    /** 一轮的 f1_rect 跟着它所属容器的 scrollTop 走（与 w872 主夹具同口径）。 */
    const mkRound = (host: ElLike, i: number): ElLike => {
      const el = doc.createElement('div') as unknown as ElLike;
      el.className = 'mcol';
      (el as unknown as f1_RectHost).getBoundingClientRect = () => {
        const st = Number((host as unknown as f1_MsgsEl).scrollTop);
        return f1_rect(f1_GUTTER, f1_DOC_PAD + i * f1_ROUND_H - st, f1_MAIN_W, f1_DOC_PAD + (i + 1) * f1_ROUND_H - st);
      };
      const c = doc.createElement('div') as unknown as ElLike;
      c.className = 'content';
      c.textContent = 'round ' + String(i + 1);
      el.appendChild(c);
      host.appendChild(el);
      return el;
    };
    // 甲会话两轮：滚到顶时视口中央（yDoc 300）最近第 1 轮（yDoc 208）⇒ 第 1 轮居中
    rail.railAdd(a, mkRound(a.el, 0), 'user');
    rail.railAdd(a, mkRound(a.el, 1), 'user');
    vi.advanceTimersByTime(50);
    expect(f1_midCount(), 'W886：指示线必须已不存在').toBe(0);
    expect(f1_centerIdx(), '甲会话滚到顶命中第 1 轮').toBe(0);
    expect(f1_centerCount(), '甲会话恰好一条高亮').toBe(1);

    // ① 同一会话内换命中（滚到第 2 轮）：旧条必须摘掉高亮
    f1_scrollTo(a.el, 308);
    expect(f1_centerIdx(), '甲会话改命中第 2 轮').toBe(1);
    expect(f1_centerCount(), '换条后仍恰好一条').toBe(1);

    // 切到乙会话（也有两轮、也会产生一条高亮）
    const b = ctx.ensurePane('ws/s2', 'session', 'yi');
    wirePane(b);
    ctx.activatePane('ws/s2', 'session', 'yi');
    rail.railActivate(b);
    rail.railAdd(b, mkRound(b.el, 0), 'user');
    rail.railAdd(b, mkRound(b.el, 1), 'user');
    vi.advanceTimersByTime(50);
    expect(f1_centerCount(), '乙会话上最多一条高亮').toBeLessThanOrEqual(1);
    expect(f1_centerCount(), '乙会话恰好一条高亮').toBe(1);

    // ② 切回甲会话：activatePane 会把甲的滚动位置复位（贴底 ⇒ scrollHeight=0）
    //    ⇒ 视口中央重新命中第 1 轮。若搬家时没摘掉第 2 轮的旧高亮，此时会有两条。
    ctx.activatePane('ws/s1', 'session', 'jia');
    rail.railActivate(a);
    vi.advanceTimersByTime(50);
    expect(f1_centerIdx(), '切回甲会话命中第 1 轮').toBe(0);
    expect(f1_centerCount(), '来回切换后仍恰好一条 .is-center').toBe(1);
    expect(f1_midCount(), '来回切换也不会冒出指示线').toBe(0);
  });
});