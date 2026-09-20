// ============================================================================
// W895 · P0 验收 A2/A3/A4：增强缝的注册语义。纯逻辑，不需要 DOM。
// ============================================================================
import { describe, expect, it } from "vitest";
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

  it("A4: a throwing enhancer surfaces the error (caller can roll back), never half-runs silently", () => {
    const boom: Enhancer = { id: "t.boom", enhance: () => { throw new Error("boom"); } };
    const off = registerEnhancer(boom);
    try {
      expect(() => runEnhancers(FAKE_CONTAINER)).toThrow("boom");
    } finally { off(); }
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
