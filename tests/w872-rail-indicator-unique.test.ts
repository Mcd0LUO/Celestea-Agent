// @vitest-environment jsdom
/**
 * W872 · 中间指示线的**整轨唯一性**（会话来回切换不得攒出第二条）。
 *
 * 这条用例来自 W872 自查时的一次真实发现，不是补充装饰：`railActivate` 的会话切换是
 * 「整批搬轨道子节点」，指示线作为轨道自己的 chrome 会被一起搬进旧会话的 holder；而
 * `ensureMid` 只按 isConnected 判在不在（holder 是游离节点 ⇒ false）⇒ 每切一次会话就
 * 再造一条，实测 A→B→A 后轨道里有两条 .railv3-mid（多条线同时显示 = 指示错乱）。
 * 修复：`railActivate` 只搬长条、不搬指示线，`ensureMid` 再兜底清掉轨道上多余的那条。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

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

describe('W872 · 中间指示线整轨唯一（会话切换不攒第二条）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('A→B→A 之后轨道里只有一条 .railv3-mid', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
    hint.initHints();
    const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctx.initViewCtx();
    const a = ctx.ensurePane('ws/s1', 'session', 'jia');
    ctx.activatePane('ws/s1', 'session', 'jia');
    const main = doc.getElementById('main') as ElLike;
    (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
    (a.el as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
    const acol = doc.createElement('div') as unknown as ElLike;
    acol.className = 'mcol';
    (acol as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
    a.el.appendChild(acol);
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    rail.initRail();
    const mkRound = (host: ElLike, i: number): ElLike => {
      const el = doc.createElement('div') as unknown as ElLike;
      el.className = 'mcol';
      (el as unknown as RectHost).getBoundingClientRect =
        () => rect(GUTTER, DOC_PAD + i * ROUND_H, MAIN_W, DOC_PAD + (i + 1) * ROUND_H);
      const c = doc.createElement('div') as unknown as ElLike;
      c.className = 'content';
      c.textContent = 'round ' + String(i + 1);
      el.appendChild(c);
      host.appendChild(el);
      return el;
    };
    rail.railAdd(a, mkRound(a.el, 0), 'user');
    const b = ctx.ensurePane('ws/s2', 'session', 'yi');
    (b.el as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
    const bcol = doc.createElement('div') as unknown as ElLike;
    bcol.className = 'mcol';
    (bcol as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
    b.el.appendChild(bcol);
    ctx.activatePane('ws/s2', 'session', 'yi');
    rail.railActivate(b);
    rail.railAdd(b, mkRound(b.el, 0), 'user');
    vi.advanceTimersByTime(50);
    const inTrack = (): number => {
      const track = doc.querySelector('#main .railv3');
      return track ? track.querySelectorAll('.railv3-mid').length : -1;
    };
    rail.railActivate(a); vi.advanceTimersByTime(50);
    rail.railActivate(b); vi.advanceTimersByTime(50);
    expect(inTrack(), '轨道里必须恰好一条指示线').toBe(1);
    expect(doc.querySelectorAll('#main .railv3-mid').length, '#main 里也只有一条').toBe(1);
  });
});
