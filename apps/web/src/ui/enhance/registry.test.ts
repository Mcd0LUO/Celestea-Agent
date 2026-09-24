// ============================================================================
// W895 · P0 验收 A2/A3/A4：增强缝的注册语义。纯逻辑，不需要 DOM。
// ============================================================================
import { describe, expect, it, vi } from "vitest";
import { enhancerIds, registerEnhancer, runEnhancers } from "./registry";
import type { Enhancer } from "./registry";

/** 缝是纯的：它只把容器转交给增强遍，自己不看容器 —— 所以测试不需要 DOM。 */
const FAKE_CONTAINER = {} as unknown as Element;

function spyEnhancer(id: string): { enhancer: Enhancer; calls: () => number } {
  let n = 0;
  return { enhancer: { id, enhance: () => { n += 1; } }, calls: () => n };
}

describe("W895 enhance seam", () => {
  it("runs every registered enhancer once per run, in registration order", () => {
    const a = spyEnhancer("t.a");
    const b = spyEnhancer("t.b");
    const offA = registerEnhancer(a.enhancer);
    const offB = registerEnhancer(b.enhancer);
    try {
      expect(enhancerIds()).toContain("t.a");
      expect(enhancerIds().indexOf("t.a")).toBeLessThan(enhancerIds().indexOf("t.b"));
      runEnhancers(FAKE_CONTAINER);
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
      // 每个节拍都会重跑：缝不缓存、不去重（幂等由实现方负责）。
      runEnhancers(FAKE_CONTAINER);
      expect(a.calls()).toBe(2);
    } finally { offA(); offB(); }
  });

  it("A3: the disposer really unregisters (a disabled component stops running)", () => {
    const a = spyEnhancer("t.off");
    const off = registerEnhancer(a.enhancer);
    runEnhancers(FAKE_CONTAINER);
    expect(a.calls()).toBe(1);
    off();
    runEnhancers(FAKE_CONTAINER);
    expect(a.calls()).toBe(1);
    expect(enhancerIds()).not.toContain("t.off");
  });

  it("same id = replace, never a duplicate entry (re-mount semantics)", () => {
    const first = spyEnhancer("t.dup");
    const second = spyEnhancer("t.dup");
    const offFirst = registerEnhancer(first.enhancer);
    const offSecond = registerEnhancer(second.enhancer);
    try {
      expect(enhancerIds().filter((id) => id === "t.dup")).toHaveLength(1);
      runEnhancers(FAKE_CONTAINER);
      expect(first.calls()).toBe(0);
      expect(second.calls()).toBe(1);
    } finally { offFirst(); offSecond(); }
  });

  // W1479 修订 A4。原契约是「抛出去，让 caller 回滚」，但复核发现它的前提不成立：
  //   · 两个调用点（assistant.ts / preview/panel.ts）**都没有 try/catch**，没人回滚；
  //   · 抛错反而跳过了调用点之后的**无关代码** —— assistant 的 autoscrollView /
  //     railSync（消息不跟随、rail 不同步），preview 的 is-degraded 与截断提示；
  //   · 上游 SSE handler 反正会 console.warn 兜住，所以「surface」并没有多给谁信息。
  // 新契约：**逐条隔离 + 具名上报**。一个坏组件不再禁用其余组件、不再弄坏下游，
  // 且失败带 id 报出来（不静默）。这正是 DSH 的「退位」语义。
  it("A4: a throwing enhancer is ISOLATED — the chain continues and the failure is named", () => {
    const calls: string[] = [];
    const boom: Enhancer = { id: "t.boom", enhance: () => { throw new Error("boom"); } };
    const after: Enhancer = { id: "t.after", enhance: () => { calls.push("t.after"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const offBoom = registerEnhancer(boom);
    const offAfter = registerEnhancer(after);
    try {
      // 不抛：runEnhancers 本身不失败，调用点的后续代码照常执行。
      expect(() => runEnhancers(FAKE_CONTAINER)).not.toThrow();
      // 抛错的那条之后的增强遍仍然跑。
      expect(calls).toEqual(["t.after"]);
      // 失败不是静默的：带 id 报到 console。
      const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join(" | ");
      expect(said).toContain("t.boom");
    } finally {
      warn.mockRestore();
      offBoom();
      offAfter();
    }
  });

  it("a disposer from a REPLACED registration does not remove the replacement", () => {
    const first = spyEnhancer("t.swap");
    const second = spyEnhancer("t.swap");
    const offFirst = registerEnhancer(first.enhancer);
    const offSecond = registerEnhancer(second.enhancer);
    try {
      offFirst();
      runEnhancers(FAKE_CONTAINER);
      expect(second.calls()).toBe(1);
    } finally { offSecond(); }
  });
});
