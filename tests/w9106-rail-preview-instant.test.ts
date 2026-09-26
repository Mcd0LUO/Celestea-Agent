// @vitest-environment jsdom
/**
 * W9106 · 用户：「thread-rail 灵动条，的预览对话应该几乎立即渲染才对」。
 *
 * 现状差（改动前）：预览卡与全站纯文本提示共用引擎里的**一个** 150ms 停留阈值，而且
 * 每次换目标都重新起计时 —— 用户拿 5px 细条来回扫动时几乎永远看不到卡。
 *
 * 本文件钉四件事（真实模块 + 真实 rail 事件路径；断言口径见 ui/hint/registry.ts 的
 * delayMs 注释与 ui/hint/card.ts 的 hintDelayOf）：
 *   ① **按提供者区分**：rail 预览 = 0ms，内置纯文本卡 = 引擎缺省 150ms（同一份引擎）；
 *   ② 条带内换条**就地换内容**：不撤卡、不重新计时、不空窗（DOM 原子替换）；
 *   ③ 离开条带**立即**撤卡；键盘路径（focusin 直接弹）行为不变；
 *   ④ 延迟不靠「把全站阈值改成 0」实现 —— 密集控件仍是 149ms 不弹 / 150ms 弹。
 *
 * 夹具沿用 tests/w867-rail-hit.test.ts 的写实桩（几何全用固定 rect，不依赖 jsdom 排版）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUNDS = 4;
/** 一根 rAF 帧（rail 的 pointermove 走 rAF 节流）。 */
const FRAME = 16;

interface HintMod {
  initHints(): void;
  setHint(t: ElLike, s: string | null): void;
  hoverHint(t: ElLike | null): void;
  hintCardEl(): ElLike | null;
  hintPlugins(): readonly { id: string; delayMs?: number }[];
}
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railHintPlugin(): { id: string; priority?: number; delayMs?: number };
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }
interface RectHost { getBoundingClientRect(): RectLike }
/** 根 tsconfig 没有 DOM lib：变更观察者用最小结构类型 + 从全局取构造器。 */
interface MutRec { addedNodes: ArrayLike<unknown>; removedNodes: ArrayLike<unknown> }
interface MutObs { observe(n: unknown, o: unknown): void; takeRecords(): MutRec[]; disconnect(): void }
const MO = (globalThis as unknown as { MutationObserver: new (cb: (records: MutRec[]) => void) => MutObs }).MutationObserver;

const rect = (l: number, t: number, r: number, b: number): RectLike =>
  ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });

/** 装一个「有条带、有留白、有 ROUNDS 轮」的会话容器（同 w867 夹具）。 */
async function bootRail(): Promise<{ main: ElLike; hint: HintMod }> {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
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
  for (let i = 1; i <= ROUNDS; i++) {
    const round = doc.createElement('div') as unknown as ElLike;
    round.className = 'mcol';
    (round as unknown as RectHost).getBoundingClientRect = () => rect(GUTTER, 0, MAIN_W, PANE_H);
    const content = doc.createElement('div') as unknown as ElLike;
    content.className = 'content';
    content.textContent = '第 ' + i + ' 轮提问';
    round.appendChild(content);
    msgs.appendChild(round);
    rail.railAdd(pane, round, 'user');
  }
  return { main, hint };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['top'])) + 2.5;
const cardCount = (): number => doc.querySelectorAll('.hint-card').length;

/** 推一次指针并跑**恰好一帧**（不推进提示停留的 150ms）。 */
function moveOneFrame(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  vi.advanceTimersByTime(FRAME);
}

describe('W9106 · 条带预览零停留（延迟按提供者区分，不是全站一刀切）', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('① 提供者级口径：rail 声明 0ms，内置纯文本卡不声明（= 引擎缺省 150ms）', async () => {
    const { hint } = await bootRail();
    const rail = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as RailMod;
    const builtin = (await import(/* @vite-ignore */ at('ui/hint/builtin.ts'))) as {
      textCardPlugin(): { delayMs?: number };
    };
    const card = (await import(/* @vite-ignore */ at('ui/hint/card.ts'))) as { HINT_DELAY_MS: number };
    expect(card.HINT_DELAY_MS, '引擎缺省仍是 150ms（密集控件的既有手感）').toBe(150);
    expect(rail.railHintPlugin().delayMs, 'rail 提供者 = 零停留').toBe(0);
    expect(rail.railHintPlugin().priority, '优先级不变（仍压过内置文本卡）').toBe(10);
    expect(builtin.textCardPlugin().delayMs, '内置文本卡不覆盖 → 走引擎缺省').toBeUndefined();
    // 真实注册表里两个提供者都在，且只有 rail 声明了零停留
    const byId = new Map(hint.hintPlugins().map((p) => [p.id, p]));
    expect(byId.get('rail-preview')?.delayMs).toBe(0);
    expect(byId.get('hint-text-card')?.delayMs).toBeUndefined();
  });

  it('② 条带：指针落到长条上，**当帧**（0ms 停留）卡已在 DOM；密集控件同刻仍不弹', async () => {
    const { main, hint } = await bootRail();
    const text = doc.createElement('div') as unknown as ElLike;
    doc.getElementById('main')?.appendChild(text);
    hint.setHint(text, '运行中');
    hint.hoverHint(text); // 先悬停一个纯文本目标（150ms 缺省，还没到点）
    moveOneFrame(main, 20, barY(0)); // 再扫到第 1 根条：rail 目标接管
    const card = hint.hintCardEl();
    expect(card, 'rail 预览在 rAF 帧内就出现（旧实现要等 150ms）').not.toBeNull();
    expect(card?.textContent, '内容取自消息 DOM').toContain('第 1 轮提问');
    expect(card?.className).toContain('railv3-card');
    expect(card?.className, '零停留的卡不播入场动画（观感上的「立即」）').toContain('hint-card-instant');
    expect(cardCount(), '同一时刻只有一张卡').toBe(1);
    // 反证：同一刻若换成内置文本卡（150ms），它不该弹 —— 证明零停留是 rail 专有
    hint.hoverHint(text);
    vi.advanceTimersByTime(149);
    expect(hint.hintCardEl(), '纯文本卡 149ms 仍不弹').toBeNull();
    vi.advanceTimersByTime(1);
    expect(hint.hintCardEl()?.textContent, '150ms 才弹').toContain('运行中');
    expect(hint.hintCardEl()?.className, '文本卡仍播入场动画（手感不变）').not.toContain('hint-card-instant');
  });

  it('③ 条带内换条：就地换内容 —— 不撤卡、不重新计时、无空窗（DOM 原子替换）', async () => {
    const { main, hint } = await bootRail();
    moveOneFrame(main, 20, barY(0));
    const first = hint.hintCardEl();
    expect(first?.textContent).toContain('第 1 轮提问');

    // 记录 body 上的卡片增删批次：原子替换 = **同一条**变更里既有移除又有添加
    const batches: { added: string[]; removed: string[] }[] = [];
    const cls = (n: unknown): string => (n as ElLike).className ?? '';
    const collect = (records: MutRec[]): void => {
      for (const r of records) {
        batches.push({ added: Array.from(r.addedNodes, cls), removed: Array.from(r.removedNodes, cls) });
      }
    };
    const obs = new MO((records) => collect(records));
    obs.observe(doc.body, { childList: true, subtree: true });

    moveOneFrame(main, 20, barY(1)); // 换到第 2 根条：不推进任何停留时间
    collect(obs.takeRecords()); // 同步取出（微任务可能还没跑）
    const second = hint.hintCardEl();
    expect(second, '换条后卡仍在（不撤卡、不空窗）').not.toBeNull();
    expect(second?.textContent, '内容立刻换成 B 的预览').toContain('第 2 轮提问');
    expect(second, '是新节点（内容重建）').not.toBe(first);
    expect(first?.isConnected, '旧节点已被换下').toBe(false);
    expect(cardCount(), '换条过程后仍恰好一张卡').toBe(1);
    // 「不重新计时」：整段没有推进 150ms，卡却已经在新内容上 —— 重新计时会一直不弹
    expect(second?.textContent).toContain('第 2 轮提问');
    // 原子替换：至少有一条变更同时含「移除一张卡 + 添加一张卡」（撤卡再建会是两条）
    const atomic = batches.filter(
      (b) => b.removed.some((c) => c.includes('hint-card')) && b.added.some((c) => c.includes('hint-card')),
    );
    expect(atomic.length, '换条是原子替换，不是「先摘后挂」的空窗').toBeGreaterThan(0);
    obs.disconnect();
  });

  it('④ 离开条带立即撤卡；键盘路径（focusin 直接弹）行为不变', async () => {
    const { main, hint } = await bootRail();
    moveOneFrame(main, 20, barY(2));
    expect(hint.hintCardEl()).not.toBeNull();
    moveOneFrame(main, MAIN_W - 5, barY(2)); // 横向出带 → collapse()
    expect(hint.hintCardEl(), '出带立即撤卡（0ms）').toBeNull();

    // 键盘路径：focusin 由引擎直接 show()，不等待停留（改动前后一致）
    const text = doc.createElement('div') as unknown as ElLike;
    doc.getElementById('main')?.appendChild(text);
    hint.setHint(text, '键盘可达');
    text.dispatchEvent(new Ev('focusin', { bubbles: true }));
    expect(hint.hintCardEl()?.textContent, 'focusin 当帧弹（不等 150ms）').toContain('键盘可达');
  });
});
