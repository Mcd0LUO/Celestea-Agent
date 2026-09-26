// @vitest-environment jsdom
/**
 * W867 · 用户 6①：thread-rail 的吸附/命中距离收短（真实 rail 模块 + 真实 DOM 事件路径）。
 *
 * 旧口径 Math.max(pitch / 2, 8)：pitch ∈ [4, 9]（PITCH_MIN / PITCH_NATURAL）时 pitch/2 ≤ 4.5
 * 永远压不过下限 8 ⇒ 命中半径**恒为 8px**，而相邻条心只隔一个 pitch（9px）⇒ 条与条之间的
 * 空隙（离最近条最远 4.5px）也在命中圈里：鼠标一进条带就吸附并弹预览 —— 这就是「吸附距离
 * 太长」。新口径 = 落在长条上（条半高 + 1px 缓冲，夹进 [2, pitch/2]）：pitch=9 → 3.5px。
 *
 * 判别点取**两条之间的中点**（离最近条 4.5px）：旧口径命中、新口径不命中；条心则两边都命中
 * （防止「把阈值改成 0 = 谁也吸不上」这种假修复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flushRaf, rafStub, resetHarness, type ElLike } from './lib/w795-dom.js';

const MAIN_W = 900;
const PANE_H = 600;
const GUTTER = 100;
const ROUNDS = 6;

interface HintMod {
  initHints(): void;
  hintCardEl(): ElLike | null;
  hideHint(): void;
}
interface RailMod {
  initRail(): void;
  railAdd(p: unknown, c: unknown, role: string): void;
  railHitRadius(pitch: number): number;
}
interface RailGeomMod {
  RAIL_BASE_W: number;
  RAIL_MAX_W: number;
  railBarWidth(grow: number, railW: number): number;
  railLane(gutter: number): { thin: boolean; width: number };
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
}

/** 只用到 rail 读的那几个字段（根 tsconfig 没有 DOM lib，测试一律用结构化最小类型）。 */
interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
interface RectHost {
  getBoundingClientRect(): RectLike;
}

const rect = (left: number, top: number, right: number, bottom: number): RectLike =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top });

/** 装一个「有条带、有留白、有 N 轮消息」的会话容器（几何全用固定 rect 桩，不依赖 jsdom 布局）。 */
async function bootRail(): Promise<{ rail: RailMod; main: ElLike; msgs: ElLike }> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // W9204：rAF 单独接管成显式队列（见 tests/lib/w795-dom.ts 的 rafStub）。
  vi.stubGlobal('requestAnimationFrame', rafStub);
  const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hint.initHints();
  const ctx = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctx.initViewCtx();
  const pane = ctx.ensurePane('ws/s1', 'session', '甲会话');
  ctx.activatePane('ws/s1', 'session', '甲会话');

  const main = doc.getElementById('main') as ElLike; // 夹具骨架里的 #main
  (main as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  const msgs = pane.el as unknown as ElLike;
  (msgs as unknown as RectHost).getBoundingClientRect = () => rect(0, 0, MAIN_W, PANE_H);
  // rail 的 gutterWidth() = .mcol 左缘 − #main 左缘 ⇒ 用 .mcol 的 rect 控制留白带宽
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
  // W9204：建列走 rAF 合并（railAdd → queueSync）—— 帧跑完长条才有 top/宽度可断言。
  flushRaf();
  return { rail, main, msgs };
}

const bars = (): ElLike[] => Array.from(doc.querySelectorAll('#main .railv3-item')) as ElLike[];
const barY = (i: number): number => Number.parseFloat(String(bars()[i]?.style?.['top'])) + 2.5;
const cardText = (hint: HintMod): string => hint.hintCardEl()?.textContent ?? '';

/**
 * 在 #main 上推一次指针（rail 的 onMove → rAF → applyMove），再等过提示停留的 150ms。
 *
 * W9204：先 flushRaf() 把 rail 自己的帧跑完，再推进定时器让提示引擎的停留到期 ——
 * 两件事分开做，rail 的 rAF 不再与 150ms 停留耦合（本仓 jsdom 里 rAF = setTimeout 0）。
 */
function moveTo(main: ElLike, x: number, y: number): void {
  const e = new Ev('pointermove', { bubbles: true });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  main.dispatchEvent(e);
  flushRaf();
  vi.advanceTimersByTime(200); // 提示引擎的 150ms 停留
}

describe('W867 · 用户 6①：rail 吸附/命中距离收短', () => {
  beforeEach(() => {
    resetHarness();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('命中半径 = 条半高 + 1px 缓冲，且必须小于旧的恒 8px；也要吸得住条心', async () => {
    const { rail } = await bootRail();
    expect(typeof rail.railHitRadius, 'rail 必须导出可测的命中半径纯函数').toBe('function');
    expect(rail.railHitRadius(9), '自然节距下 3.5px（旧口径恒 8px）').toBe(3.5);
    expect(rail.railHitRadius(9)).toBeLessThan(Math.max(9 / 2, 8));
    expect(rail.railHitRadius(4), '最密节距仍有下限 2px，不至于点不中').toBe(2);
    for (const p of [4, 5, 6, 7, 8, 9]) {
      const r = rail.railHitRadius(p);
      expect(r).toBeGreaterThanOrEqual(2); // 点得中
      expect(r).toBeLessThanOrEqual(p / 2); // 不抢邻条
      expect(r).toBeLessThan(Math.max(p / 2, 8)); // 一律比旧口径短
    }
  });

  it('条长刻度 ×0.6：静止 7→4、吸附上限 110→66（用户 6 澄清「条太长，缩减 40%」）', async () => {
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as RailGeomMod;
    // 机械证据 1：两个常量本身
    expect(geom.RAIL_MAX_W, '吸附上限 = 110 × 0.6 = 66').toBe(66);
    expect(geom.RAIL_BASE_W, '静止细条 = 7 × 0.6 ≈ 4').toBe(4);
    expect(geom.RAIL_MAX_W / 110, '相对旧刻度正好 −40%').toBeCloseTo(0.6, 10);
    // 机械证据 2：满吸附（k=1）时的实际宽度 = min(上限, 留白−26) + 命中加成
    const wide = geom.railLane(400).width; // 留白充裕 → 取 RAIL_MAX_W
    expect(wide, '留白充裕时轨道宽度被上限收住').toBe(66);
    expect(geom.railBarWidth(1, wide), '满吸附 = 66 + 命中加成 6').toBe(72);
    expect(geom.railBarWidth(0, wide), '未悬停 = 静止 4').toBe(4);
    // 旧刻度满吸附 = 110 + 6 = 116 ⇒ 新刻度必须显著更短（缩减 40% 的落点）
    expect(geom.railBarWidth(1, wide)).toBeLessThan(116);
    expect((geom.railBarWidth(1, wide) - 6) / 110, '去掉命中加成后的净条长比').toBeCloseTo(0.6, 10);
    // 条高 / 节距不受影响（用户没要求变细变密）
    expect(geom.railBarWidth(0.5, wide), '中间刻度按同一比例插值').toBeCloseTo(4 + 0.5 * (66 - 4), 10);
  });

  it('两条之间的中点：旧口径会吸附弹卡，新口径不再吸附/提示（W1546：改为点亮最近条 .is-near）', async () => {
    const { main } = await bootRail();
    const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
    const y0 = barY(0);
    const y1 = barY(1);
    const mid = (y0 + y1) / 2; // 离最近条 4.5px：旧 hitR=8 → 命中；新 hitR=3.5 → 不命中
    expect(y1 - y0, '自然节距 9px（5px 条 + 4px 间隙）').toBeCloseTo(9, 5);
    expect(Math.abs(mid - y0), '探针必须落在旧阈值内').toBeLessThan(8);
    expect(Math.abs(mid - y0), '探针必须落在新阈值外').toBeGreaterThan(3.5);

    moveTo(main, 20, mid);
    expect(bars().some((b) => b.classList.contains('is-hover')), '中点不得吸附任何一条').toBe(false);
    expect(hint.hintCardEl(), '中点不得弹预览卡').toBeNull();
    // W1546 的唯一改动：死区里**最近的**那根条点亮 .is-near（描边态，不是吸附态）。
    // 原断言「中点不得吸附/不得弹卡」逐字保留 —— 它守的是 W867 的防跨条误吸，仍然吃劲。
    expect(bars()[0]?.classList.contains('is-near'), '同距取靠上的一根（railCenterHit 同口径）').toBe(true);
    expect(bars()[1]?.classList.contains('is-near'), '另一根不得同时点亮').toBe(false);
    expect(bars()[0]?.classList.contains('is-hover'), '点亮 ≠ 吸附：is-hover 只属于半径内').toBe(false);
    // 「吸附」= setGrow(hit, 1) 的满刻度（RAIL_MAX_W + 命中加成）；死区里只有**连续**的
    // fisheye 增益（railGrow(4.5)），绝不跳到满刻度 —— 这正是 W867 要的「不误吸」。
    const geom = (await import(/* @vite-ignore */ at('ui/rail-geom.ts'))) as RailGeomMod & {
      railBarHeight(p: number): number;
      railGrow(d: number): number;
      RAIL_MAX_W: number;
      RAIL_HIT_BOOST: number;
    };
    const w = Number.parseFloat(String(bars()[0]?.style?.['width']));
    const cont = geom.railBarWidth(geom.railGrow(4.5), 66); // setGrow 写的是 toFixed(1)
    expect(Math.abs(w - cont), '死区宽度 = 连续 fisheye 增益（不是满刻度 72）').toBeLessThanOrEqual(0.05);
    expect(w, '远小于满吸附刻度').toBeLessThan(geom.railBarWidth(1, 66));
  });

  it('条心：仍然吸附并弹出该轮的预览卡（不是把阈值改成 0 的假修复）', async () => {
    const { main } = await bootRail();
    const hint = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
    moveTo(main, 20, barY(3));
    expect(bars()[3]?.classList.contains('is-hover'), '第 4 轮长条吸附').toBe(true);
    expect(cardText(hint)).toContain('第 4 轮提问');
    // W867 返工：吸附后的**真实 DOM 宽度**必须落在新刻度内（旧刻度是 110+6=116）。
    const w = Number.parseFloat(String(bars()[3]?.style?.['width']));
    expect(w, '吸附态条长 = 上限 66 + 命中加成 6 = 72').toBeCloseTo(72, 5);
    expect(w, '不再可能到旧刻度 116').toBeLessThan(116);
    expect(w, '比未吸附细条（4px）长得多 ⇒ 仍是正常的 fisheye 展开').toBeGreaterThan(4);
  });

  it('离开条带：吸附与预览立刻撤掉（不留粘住的提示）', async () => {
    const { main } = await bootRail();
    moveTo(main, 20, barY(2));
    moveTo(main, 20, 5); // 条带上方的空白（仍在条带内，但离最近条 > 半径）
    expect(bars().some((b) => b.classList.contains('is-hover'))).toBe(false);
    moveTo(main, 20, barY(2));
    moveTo(main, MAIN_W - 5, barY(2)); // 横向出带
    expect(bars().some((b) => b.classList.contains('is-hover'))).toBe(false);
  });
});
