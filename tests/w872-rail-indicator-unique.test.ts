// @vitest-environment jsdom
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUND_H = 400;
const DOC_PAD = 8;

interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
type MsgsEl = ElLike & { scrollTop: number; scrollHeight: number; clientHeight: number };
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railActivate(p: unknown): void;
}
interface PaneLike { el: ElLike }
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): PaneLike;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const centerCount = (): number => doc.querySelectorAll('#main .is-center').length;
const centerIdx = (): number => bars().findIndex((b) => b.classList.contains('is-center'));
const midCount = (): number => doc.querySelectorAll('#main .railv3-mid').length;

/** 真滚动：改 scrollTop + 派发 scroll，再跑完 rail 的 rAF 节流。 */
function scrollTo(host: ElLike, top: number): void {
  (host as unknown as MsgsEl).scrollTop = top;
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
    const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctx.initViewCtx();
    const a = ctx.ensurePane('ws/s1', 'session', 'jia');
    ctx.activatePane('ws/s1', 'session', 'jia');
    const main = doc.getElementById('main') as ElLike;
    (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
    const wirePane = (pane: PaneLike): void => {
      (pane.el as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
      const col = doc.createElement('div') as unknown as ElLike;
      col.className = 'mcol';
      (col as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
      pane.el.appendChild(col);
    };
    wirePane(a);
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    rail.initRail();
    /** 一轮的 rect 跟着它所属容器的 scrollTop 走（与 w872 主夹具同口径）。 */
    const mkRound = (host: ElLike, i: number): ElLike => {
      const el = doc.createElement('div') as unknown as ElLike;
      el.className = 'mcol';
      (el as unknown as RectHost).getBoundingClientRect = () => {
        const st = Number((host as unknown as MsgsEl).scrollTop);
        return rect(GUTTER, DOC_PAD + i * ROUND_H - st, MAIN_W, DOC_PAD + (i + 1) * ROUND_H - st);
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
    expect(midCount(), 'W886：指示线必须已不存在').toBe(0);
    expect(centerIdx(), '甲会话滚到顶命中第 1 轮').toBe(0);
    expect(centerCount(), '甲会话恰好一条高亮').toBe(1);

    // ① 同一会话内换命中（滚到第 2 轮）：旧条必须摘掉高亮
    scrollTo(a.el, 308);
    expect(centerIdx(), '甲会话改命中第 2 轮').toBe(1);
    expect(centerCount(), '换条后仍恰好一条').toBe(1);

    // 切到乙会话（也有两轮、也会产生一条高亮）
    const b = ctx.ensurePane('ws/s2', 'session', 'yi');
    wirePane(b);
    ctx.activatePane('ws/s2', 'session', 'yi');
    rail.railActivate(b);
    rail.railAdd(b, mkRound(b.el, 0), 'user');
    rail.railAdd(b, mkRound(b.el, 1), 'user');
    vi.advanceTimersByTime(50);
    expect(centerCount(), '乙会话上最多一条高亮').toBeLessThanOrEqual(1);
    expect(centerCount(), '乙会话恰好一条高亮').toBe(1);

    // ② 切回甲会话：activatePane 会把甲的滚动位置复位（贴底 ⇒ scrollHeight=0）
    //    ⇒ 视口中央重新命中第 1 轮。若搬家时没摘掉第 2 轮的旧高亮，此时会有两条。
    ctx.activatePane('ws/s1', 'session', 'jia');
    rail.railActivate(a);
    vi.advanceTimersByTime(50);
    expect(centerIdx(), '切回甲会话命中第 1 轮').toBe(0);
    expect(centerCount(), '来回切换后仍恰好一条 .is-center').toBe(1);
    expect(midCount(), '来回切换也不会冒出指示线').toBe(0);
  });
});
