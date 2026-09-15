/**
 * W789 · 前端修复批 A（p0）：吞吐近期均值 + 权限面板自然高度 —— **纯函数**守护。
 *
 * 为什么这两块放这里：它们是本轮唯一可以脱离浏览器机械断言的「判据本体」。
 *   · statusline/tps.ts      —— 会话 inactive 时服务端把 tokens_per_sec 归零/省略，
 *     状态栏必须显示**近期均值**（带 `≈`）而不是「0.0 tok/s」；口径错了不报错，
 *     只会静默显示一个错误的数字。
 *   · ui/grants/geom.ts 的 panelNaturalHeight —— 它是权限面板「不可滚动」这个 p0 的
 *     修复本体：旧实现靠清空内联 max-height 去实测自然高度，清空会让面板内部滚动容器
 *     的 scrollTop 被夹回 0（headless Blink 实测 scroll 序列 120 → 0），于是滚轮滚一格
 *     就被弹回顶部。这里断言推算口径，位置/上限的落位仍由 panelGeom 的既有断言守护。
 *
 * 只加载纯模块（零 DOM、零网络）；DOM/几何层见 tests/frontend-batch-a-dom.test.ts。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface TpsSamples {
  values: readonly number[];
  capacity: number;
}
interface TpsDisplay {
  text: string;
  title: string;
  approximate: boolean;
  samples: number;
}
interface TpsMod {
  TPS_WINDOW: number;
  createTpsSamples(capacity?: number): TpsSamples;
  isTpsSample(v: unknown): boolean;
  pushTpsSamples(state: TpsSamples, value: unknown): TpsSamples;
  meanTps(state: TpsSamples): number | null;
  tpsDisplay(
    state: TpsSamples,
    current: unknown,
    busy: boolean,
    format: (v: number) => string,
  ): TpsDisplay;
}
interface Geom {
  top: number;
  left: number;
  maxHeight: number;
}
interface GeomMod {
  PANEL_GAP: number;
  PANEL_MARGIN: number;
  panelNaturalHeight(input: {
    panelHeight: number;
    bodyClientHeight: number;
    bodyScrollHeight: number;
  }): number;
  panelGeom(input: {
    anchor: { top: number; right: number; bottom: number; left: number; width: number; height: number };
    panel: { width: number; height: number };
    viewport: { width: number; height: number };
  }): Geom;
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "src");
const at = (rel: string): string => pathToFileURL(join(SRC, rel)).href;

const tps = (await import(/* @vite-ignore */ at("statusline/tps.ts"))) as TpsMod;
const geom = (await import(/* @vite-ignore */ at("ui/grants/geom.ts"))) as GeomMod;

/** 与 statusline/icons.ts 的 fixed1 同口径（小数值格式化，单一真源仍在 icons.ts）。 */
const fixed1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "—");

describe("W789 · tok/s 近期均值（statusline/tps.ts 纯函数）", () => {
  it("只把有限的 > 0 采样计入缓冲（0 / 负数 / NaN / Infinity / 非数字都不算）", () => {
    expect(tps.isTpsSample(42.5)).toBe(true);
    expect(tps.isTpsSample(0.5)).toBe(true);
    const bad: unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "9", null, undefined, {}];
    expect(bad.filter((v) => tps.isTpsSample(v))).toEqual([]);
    let s = tps.createTpsSamples();
    for (const v of [42.5, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, "x", undefined, 7.5]) {
      s = tps.pushTpsSamples(s, v);
    }
    expect(s.values).toEqual([42.5, 7.5]);
  });

  it("环形缓冲只保留最近 N 次（N = TPS_WINDOW），且 push 不修改入参", () => {
    expect(tps.TPS_WINDOW).toBe(8);
    let s = tps.createTpsSamples();
    for (let i = 1; i <= 10; i++) s = tps.pushTpsSamples(s, i);
    expect(s.values).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(tps.meanTps(s)).toBeCloseTo(6.5, 10);
    const before = tps.createTpsSamples();
    const after = tps.pushTpsSamples(before, 5);
    expect(before.values).toEqual([]); // 不可变：原缓冲不动
    expect(after.values).toEqual([5]);
    // 容量非法 → 回落 TPS_WINDOW（不抛错、不放任 0 容量吞掉全部采样）
    expect(tps.createTpsSamples(0).capacity).toBe(tps.TPS_WINDOW);
    expect(tps.createTpsSamples(Number.NaN).capacity).toBe(tps.TPS_WINDOW);
    expect(tps.createTpsSamples(3).capacity).toBe(3);
    expect(tps.pushTpsSamples(tps.createTpsSamples(2), 1).capacity).toBe(2);
  });

  it("有效采样 → 原样显示（title 保持空，与既有行为逐字一致）", () => {
    const s = tps.pushTpsSamples(tps.createTpsSamples(), 42.5);
    const d = tps.tpsDisplay(s, 42.5, true, fixed1);
    expect(d).toEqual({ text: "42.5 tok/s", title: "", approximate: false, samples: 1 });
  });

  it("会话 inactive（服务端给 0/缺省）→ 显示近期均值并带可区分的 ≈ 前缀", () => {
    let s = tps.createTpsSamples();
    for (const v of [30, 40, 50]) s = tps.pushTpsSamples(s, v);
    for (const idle of [0, undefined, null]) {
      const d = tps.tpsDisplay(s, idle, false, fixed1);
      expect(d.text).toBe("≈ 40.0 tok/s"); // 不是 "0.0 tok/s"
      expect(d.approximate).toBe(true);
      expect(d.samples).toBe(3);
      expect(d.title).toContain("会话当前未运行");
      expect(d.title).toContain("均值");
    }
    // 运行中但本轮暂无新采样（stalled）：同样给均值，但说明措辞不同
    expect(tps.tpsDisplay(s, 0, true, fixed1).title).toContain("本轮暂无新采样");
  });

  it("从未采到过 → 占位符（绝不编造一个 0.0）", () => {
    const d = tps.tpsDisplay(tps.createTpsSamples(), undefined, false, fixed1);
    expect(d).toEqual({ text: "— tok/s", title: "", approximate: false, samples: 0 });
    expect(tps.meanTps(tps.createTpsSamples())).toBeNull();
  });
});

describe("W789 · 权限面板自然高度（geom.panelNaturalHeight 纯函数）", () => {
  it("不受限时（滚动容器无溢出）就是当前外框高", () => {
    expect(geom.panelNaturalHeight({ panelHeight: 400, bodyClientHeight: 364, bodyScrollHeight: 364 })).toBe(400);
    expect(geom.panelNaturalHeight({ panelHeight: 0, bodyClientHeight: 0, bodyScrollHeight: 0 })).toBe(0);
    // 负值/脏数据一律按 0 处理（不产生负高度去喂 panelGeom）
    expect(geom.panelNaturalHeight({ panelHeight: -5, bodyClientHeight: -1, bodyScrollHeight: -9 })).toBe(0);
  });

  it("受 max-height 夹住时，由「外框 − 可视 + 内容」推算自然高度（不清 max-height）", () => {
    // headless Blink 实测样本：面板被夹到 563，body 可视 527、内容 986 → 自然 1022
    expect(geom.panelNaturalHeight({ panelHeight: 563, bodyClientHeight: 527, bodyScrollHeight: 986 })).toBe(1022);
    // 没有内部滚动容器（老结构）→ 退回当前外框高
    expect(geom.panelNaturalHeight({ panelHeight: 300, bodyClientHeight: 0, bodyScrollHeight: 0 })).toBe(300);
  });

  it("推算出的自然高度喂给 panelGeom：面板仍被夹进「盾牌上方空间」，且不顶出视口顶部", () => {
    const anchor = { top: 600, right: 1240, bottom: 618, left: 1222, width: 18, height: 18 };
    const natural = geom.panelNaturalHeight({ panelHeight: 563, bodyClientHeight: 527, bodyScrollHeight: 986 });
    const g = geom.panelGeom({ anchor, panel: { width: 460, height: natural }, viewport: { width: 1280, height: 800 } });
    expect(g.maxHeight).toBe(600 - geom.PANEL_GAP - geom.PANEL_MARGIN); // 584
    expect(g.top).toBe(geom.PANEL_MARGIN); // 8：面板下沿贴盾牌上沿，顶部留 margin
    expect(g.top + g.maxHeight).toBeLessThanOrEqual(anchor.top - geom.PANEL_GAP);
    expect(g.top).toBeGreaterThanOrEqual(0);
  });
});
