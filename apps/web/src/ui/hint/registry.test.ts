// ============================================================================
// W1479 · hint 缝的失败隔离：一个提供者抛错不得废掉整条链。
//
// WHY: `resolveHint` 走的是「谁认领谁渲染」的优先级链。原先循环体里没有 try/catch，
// 于是任意一个提供者抛错 ⇒ 后面的候选全部得不到机会，且异常冒到 card.ts 的 hover
// 处理器里 —— 表现为「悬浮提示整个不工作了」，而真因只是某一个提供者坏了。
// 新契约（对齐 DSH 的「退位」语义）：坏的那条让位，链继续，失败带 id 报出来。
// ============================================================================
import { describe, expect, it, vi } from "vitest";
import { registerHintPlugin, resolveHint } from "./registry";
import type { HintHandle, HintPlugin } from "./registry";

const TARGET = {} as unknown as HTMLElement;

/** A provider that never claims (returns null), recording that it was asked. */
function asked(id: string, log: string[], priority = 0): HintPlugin {
  return { id, priority, claim: () => { log.push(id); return null; } };
}

/** A provider that claims with a handle whose build() returns a plain node. */
function claiming(id: string, log: string[], priority = 0): HintPlugin {
  const handle: HintHandle = { build: () => null };
  return { id, priority, claim: () => { log.push(id); return handle; } };
}

describe("W1479 hint seam: failure isolation", () => {
  it("a throwing provider steps aside and the next candidate still gets its turn", () => {
    const log: string[] = [];
    const boom: HintPlugin = { id: "t.boom", priority: 10, claim: () => { throw new Error("boom"); } };
    const after = claiming("t.after", log, 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const offBoom = registerHintPlugin(boom);
    const offAfter = registerHintPlugin(after);
    try {
      // 不抛：调用方（card.ts 的 hover 处理器）拿到的是「下一个提供者的结果」。
      const got = resolveHint(TARGET, "text");
      expect(got).not.toBeNull();
      expect(log).toEqual(["t.after"]);
      // 失败不是静默的：带 id 报到 console。
      const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join(" | ");
      expect(said).toContain("t.boom");
    } finally {
      warn.mockRestore();
      offBoom();
      offAfter();
    }
  });

  /**
   * W9106：停留阈值是**提供者的属性**（handle 级 > provider 级 > 引擎缺省）。
   * 这条用例钉住「合并」这一步真的发生了 —— 引擎只读 handle.delayMs，如果 registry
   * 不把 provider 级的值带下来，rail 的零停留就会被静默丢掉（表现为回到 150ms）。
   */
  it("W9106 carries the provider delayMs onto the handle (handle-level wins)", () => {
    const instant = registerHintPlugin({ id: "t.instant", priority: 5, delayMs: 0, claim: () => ({ build: () => null }) });
    try {
      expect(resolveHint(TARGET, "text")?.delayMs, "provider 级 0 必须带到 handle（0 不是「没写」）").toBe(0);
    } finally { instant(); }
    // handle 级更具体：与 provider 级同时存在时以 handle 为准
    const mixed = registerHintPlugin({
      id: "t.mixed", priority: 5, delayMs: 150,
      claim: () => ({ build: () => null, delayMs: 7 }),
    });
    try {
      expect(resolveHint(TARGET, "text")?.delayMs).toBe(7);
    } finally { mixed(); }
    // 两级都没写 → undefined（引擎据此回落 HINT_DELAY_MS，内置文本卡的 150ms 手感）
    const plain = registerHintPlugin({ id: "t.plain", priority: 5, claim: () => ({ build: () => null }) });
    try {
      expect(resolveHint(TARGET, "text")?.delayMs).toBeUndefined();
    } finally { plain(); }
  });

  it("keeps asking providers when nobody claims (null = pass, not a failure)", () => {
    const log: string[] = [];
    const offA = registerHintPlugin(asked("t.a", log, 5));
    const offB = registerHintPlugin(asked("t.b", log, 1));
    try {
      expect(resolveHint(TARGET, "text")).toBeNull();
      // 优先级降序：两个都被问过，且高的先问。
      expect(log).toEqual(["t.a", "t.b"]);
    } finally { offA(); offB(); }
  });
});
