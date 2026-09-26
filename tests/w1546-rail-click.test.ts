// @vitest-environment jsdom
/**
 * W1546 · 用户：「thread-rail 灵动条中间不能点击，应该判为中间也可点击」。
 *
 * 根因（几何死区）：rail-geom 的命中半径 max(2, min(barH/2 + 1, pitch/2)) 在
 * pitch ∈ {5,6,7,8,9} 上恒 < pitch/2 ⇒ 相邻条心之间留下 2.0px 既点不到也悬停不到的
 * 空隙（pitch=4 时半高 1px 恰好相接 ⇒ 0）。旧 onClick 开头「!hoverItem 就 return」，
 * 且再用 railHitRadius 复核一次 ⇒ 那 2px 直接 return。
 *
 * 本文件钉四件事（口径见 ui/rail-geom.ts 的 railHit 注释）：
 *   ① **无死区**：带内任意 y（含端点之外）都能归属一根条 —— 点击归属 = 最近者胜；
 *   ② **点击真的滚动**：死区里点一下，目标轮的 scrollIntoView 必须被调用（真事件路径）；
 *   ③ **不误吸**：点第 k 条条心命中第 k 条（最近者胜，不越界抢邻条）；
 *   ④ 悬停口径未被放宽：railHitRadius 一个数字都没动，死区仍不吸附、不弹卡。
 *
 * 坐标：railTop = 0（夹具里 #main 与消息区 rect 同顶），y 直接就是事件 clientY。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flushRaf, rafStub, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUNDS = 12;
const PITCH = 9;

interface GeomMod {
  RAIL_PAD_Y: number;
  railBarHeight(pitch: number): number;
  railHitRadius(pitch: number): number;
  railHit<T extends { y: number }>(
    items: readonly T[],
    y: number,
    railTop: number,
    pitch: number,
  ): { item: T; hover: boolean; distance: number } | null;
}
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }

const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 被点击的轮次（夹具给每轮装了 scrollIntoView 探针）。 */
const calls: number[] = [];

/** 夹具：N 轮、视口 600px。N=12 ⇒ pitch 被自然节距 9 收住（条间死区 2px）；N=100 ⇒ 密集 + 折叠条。 */
async function bootRail(rounds = ROUNDS): Promise<{ main: ElLike }> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  // W9204：rAF 单独接管成显式队列（见 tests/lib/w795-dom.ts 的 rafStub）。
  vi.stubGlobal('requestAnimationFrame', rafStub);
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', 'jia');
  ctx.activatePane('ws/s1', 'session', 'jia');
  const main = doc.getElementById('main') as ElLike;
  (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const msgs = pane.el as unknown as ElLike;
  (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const col = doc.createElement('div') as unknown as ElLike;
  col.className = 'mcol';
  (col as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
  msgs.appendChild(col);
  const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
  rail.initRail();
  for (let i = 0; i < rounds; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    (round as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
    (round as unknown as { scrollIntoView(): void }).scrollIntoView = (): void => { calls.push(i); };
    msgs.appendChild(round);
    rail.railAdd(pane, round, 'user');
  }
  // W9204：建列走 rAF 合并（railAdd → queueSync）—— 帧跑完长条才有 top 可点。
  flushRaf();
  return { main };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['top'])) + 2.5;

/** 在 #main 上派发一次真实 click（rail 的 onClick 挂在 #main 上）。 */
function clickAt(main: ElLike, x: number, y: number): void {
  const e = new Ev('click', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
}

/**
 * 在 #main 上推一次指针（rail 的 onMove → rAF → applyMove）。
 *
 * W9204：先 flushRaf() 跑完 rail 自己的帧，再推进定时器让提示引擎的停留到期 ——
 * 两件事分开做（本仓 jsdom 里 requestAnimationFrame = setTimeout 0）。
 */
function moveTo(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  flushRaf();
  vi.advanceTimersByTime(200); // 提示引擎的 150ms 停留
}

describe('W1546 · rail 点击无死区（点击归属 vs 悬停半径）', () => {
  beforeEach(() => { resetHarness(); calls.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 逐 px 扫全带：pitch ∈ {4,5,6,7,8,9} 上命中数 == 带高（0 个 miss）', async () => {
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as GeomMod;
    const rows: string[] = [];
    for (const p of [4, 5, 6, 7, 8, 9]) {
      // 三根条心在 0 / p / 2p：扫 y = 0 .. 2p（逐 px）
      const items = [{ y: 0 }, { y: p }, { y: 2 * p }];
      const railH = 2 * p;
      let miss = 0;
      for (let y = 0; y <= railH; y++) if (geom.railHit(items, y, 0, p) === null) miss += 1;
      const gap = 2 * (p / 2 - geom.railHitRadius(p)); // 条心之间的死区宽度（px）
      rows.push('pitch=' + p + ' barH=' + geom.railBarHeight(p) + ' hitR=' + geom.railHitRadius(p) +
        ' dead=' + gap.toFixed(2) + 'px scan=' + (railH + 1) + 'px miss=' + miss);
      expect(miss, 'pitch=' + p + '：带内必须 0 个 miss').toBe(0);
      // 判别力自检：这条断言必须真的在测「死区」—— pitch ≥ 5 时死区 > 0（旧口径会红）
      if (p >= 5) expect(gap, 'pitch=' + p + ' 存在真实死区').toBeGreaterThan(0);
    }
    expect(rows.length, '六个节距都扫过').toBe(6);
    // 端点之外（y < 第一条 / y > 最后一条）也必须有归属（首/末条），不是 null
    expect(geom.railHit([{ y: 20 }], -50, 0, PITCH)?.item.y, '上方越界 → 第一条').toBe(20);
    expect(geom.railHit([{ y: 20 }], 999, 0, PITCH)?.item.y, '下方越界 → 最后一条').toBe(20);
    expect(geom.railHit([], 20, 0, PITCH), '空集合 → null').toBeNull();
  });

  it('② 最近者胜：点第 k 条条心命中第 k 条；中垂线两侧各归其主', async () => {
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as GeomMod;
    const items = [{ y: 0 }, { y: 9 }, { y: 18 }];
    for (let k = 0; k < items.length; k++) {
      const at0 = geom.railHit(items, items[k]!.y, 0, PITCH);
      expect(at0?.item, '第 ' + k + ' 条条心 → 第 ' + k + ' 条').toBe(items[k]);
      expect(at0?.hover, '条心在悬停半径内').toBe(true);
      expect(at0?.distance).toBe(0);
    }
    // 中垂线两侧：4 → 上（同距取靠上），5 → 下
    expect(geom.railHit(items, 4, 0, PITCH)?.item.y, '中点上方归上条').toBe(0);
    expect(geom.railHit(items, 5, 0, PITCH)?.item.y, '中点下方归下条').toBe(9);
    // 死区（离最近条 > hitR）仍归属最近条，但 hover = false（悬停口径不放宽）
    expect(geom.railHit(items, 4, 0, PITCH)?.hover, '死区不吸附').toBe(false);
    expect(geom.railHit(items, 5, 0, PITCH)?.hover, '死区不吸附').toBe(false);
  });

  it('③ 真事件路径：死区里点一下 → 目标轮 scrollIntoView（指针从未移动过）', async () => {
    const { main } = await bootRail();
    expect(bars().length, '夹具 ' + ROUNDS + ' 轮').toBe(ROUNDS);
    const y0 = barY(0);
    const y1 = barY(1);
    const mid = (y0 + y1) / 2; // 死区正中：离两条各 4.5px
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as GeomMod;
    expect(y1 - y0, '自然节距 9px').toBeCloseTo(9, 5);
    expect(Math.abs(mid - y0), '探针落在死区里（旧口径会 return）').toBeGreaterThan(geom.railHitRadius(PITCH));

    // 不派发任何 pointermove ⇒ hoverItem 恒为 null（旧写法在这里直接 return）
    clickAt(main, 20, mid);
    expect(calls, '死区点击必须滚动到最近的一轮').toEqual([0]);
    // 第 k 条条心 → 第 k 轮（不越界抢邻条）
    for (const k of [1, 5, ROUNDS - 1]) {
      calls.length = 0;
      clickAt(main, 20, barY(k));
      expect(calls, '第 ' + (k + 1) + ' 条条心 → 第 ' + (k + 1) + ' 轮').toEqual([k]);
    }
    // 端点之外 → 首/末条（不是 null，也不静默丢弃）
    calls.length = 0;
    clickAt(main, 20, 1);
    expect(calls, '带顶之上 → 第 1 轮').toEqual([0]);
    calls.length = 0;
    clickAt(main, 20, 599);
    expect(calls, '带底之下 → 最后一轮').toEqual([ROUNDS - 1]);
    // 横向出带：不命中任何一轮（保持原容差：左 −6 / 右 +14）
    calls.length = 0;
    clickAt(main, MAIN_W - 5, mid);
    clickAt(main, -50, mid);
    expect(calls, '横向出带不滚动').toEqual([]);
  });

  it('④ 悬停口径未被放宽：死区仍不吸附、不弹卡，只点亮最近条 .is-near', async () => {
    const { main } = await bootRail();
    const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { hintCardEl(): ElLike | null };
    const mid = (barY(0) + barY(1)) / 2;
    moveTo(main, 20, mid);
    expect(bars().some((b) => b.classList.contains('is-hover')), '死区不吸附').toBe(false);
    expect(hint.hintCardEl(), '死区不弹卡').toBeNull();
    expect(bars()[0]?.classList.contains('is-near'), '最近条点亮').toBe(true);
    expect(bars().filter((b) => b.classList.contains('is-near')).length, '只点亮一根').toBe(1);
    // 离开条带 → .is-near 一并撤掉（不留粘住的描边）
    moveTo(main, MAIN_W - 5, mid);
    expect(bars().some((b) => b.classList.contains('is-near')), '出带后不得残留 .is-near').toBe(false);
  });

  it('⑤ 密集节距 + 折叠条：带内逐 px 点击都命中**恰好**一轮；折叠条本身可点', async () => {
    const DENSE_ROUNDS = 100;
    const { main } = await bootRail(DENSE_ROUNDS); // 100 轮 ⇒ 折叠条(80 轮) + 100 条 = 101 根，pitch ≈ 5.78
    const list = bars();
    expect(list.length, '折叠条 + 100 条').toBe(101);
    const topOf = (b: ElLike): number => Number.parseFloat(String(b.style?.['top']));
    // ★ DOM 顺序 ≠ 视觉顺序：折叠条是第 21 条时才 append 进 track 的，此后不再搬家
    //   （parentNode 仍是 track），所以它在 DOM 里停在第 21 位，而纵向最靠上。
    //   位置断言一律按 **top 排序**（= 用户看到的顺序 = allItems 的顺序）。
    const vis = [...list].sort((a, b) => topOf(a) - topOf(b));
    expect(list.filter((b) => b.classList.contains('railv3-fold')).length, '恰好一根折叠条').toBe(1);
    expect(vis[0]?.classList.contains('railv3-fold'), '视觉第一根是折叠条').toBe(true);
    expect(vis[0]?.getAttribute('data-hint') ?? '', '折叠条文案（注册缝的 data-hint）').toContain('80');
    // 折叠条本身可点：恰好命中一轮，且命中的就是**它指向的那一轮**。
    // W9204：折叠条 = 「更早 80 轮已折叠」，它指向的必须是当前边界那一轮（0 起 80 =
    // 第 81 轮，也就是最早还看得见的那一根）。旧实现只在创建时取一次 startCol、
    // 此后永不刷新 —— 本用例原先断言的 1 就是那个漂移值（把错误行为固化成了期望）。
    clickAt(main, 20, topOf(vis[0]!) + 2.5);
    expect(calls.length, '折叠条可点（旧写法：死区里 0 次）').toBe(1);
    expect(calls[0], '命中的是折叠条指向的当前边界轮（0 起 ' + (DENSE_ROUNDS - 20) + '）').toBe(DENSE_ROUNDS - 20);
    // 带内逐 px 扫：每一 px 都必须命中**恰好**一轮（0 个死区、0 次「一次点多根」）
    const miss: number[] = [];
    const multi: number[] = [];
    for (let y = 0; y <= PANE_H; y++) {
      calls.length = 0;
      clickAt(main, 20, y);
      if (calls.length === 0) miss.push(y);
      if (calls.length > 1) multi.push(y);
    }
    expect(miss, '带内不得有死区（px）').toEqual([]);
    expect(multi, '一次点击只命中一根').toEqual([]);
    // 不误吸：每条普通条的条心点到的是它自己（视觉第 k 根 = 第 k 轮，k ≥ 1）
    for (const k of [1, 2, 50, 100]) {
      calls.length = 0;
      clickAt(main, 20, topOf(vis[k]!) + 2.5);
      expect(calls, '第 ' + k + ' 根条心 → 第 ' + k + ' 轮').toEqual([k - 1]);
    }
  });
});
