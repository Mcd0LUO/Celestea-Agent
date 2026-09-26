// @vitest-environment node
/**
 * W9208 · W9206-31 的聚焦测试：`configure()` 只在配置**真的变了**时才 bump epoch。
 *
 * 背景：`RealRuntimeAdapter.configure(patch)` 过去无条件 `bumpEpoch()`
 * （`baseEpoch += 1` + `registry.invalidateAll()`），于是 `POST /api/config {}`
 * 或重发当前值的客户端（保存按钮、脚本）会拆掉**每一个空闲会话实例**，
 * 下一轮重建（关/开日志、重读 grants、重挂 watchdog）。
 *
 * 不变量：
 *   ① 空 patch / 同值 patch ⇒ epoch 不动；
 *   ② 真的改了一个字段 ⇒ epoch +1；
 *   ③ 归一化后等价的 patch（`max_steps: 0` 被抬到 MIN_STEPS、浮点被截断）⇒ 不动；
 *   ④ `max_retries` 不在 `Profile` 里，但它是活配置，变了也必须 bump。
 *
 * 变异负控制（报告里有红/绿记录）：把
 * `real-runtime-adapter.ts` 的 `if (!sameProfile(before, next) || ...)` 改回无条件
 * `this.bumpEpoch()` ⇒ 本文件 ①②③ 全红。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "@celestea/runtime";
import { makeHarness, type StudioHarness } from "../apps/studio/src/harness.test-util.js";
import { engineOf, makeEngineHarness } from "../apps/studio/src/runtime/test-util.js";

const harnesses: StudioHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

function harness(): StudioHarness {
  const h = makeEngineHarness({ sessions: { s1: [] } });
  harnesses.push(h);
  return h;
}

/** The epoch of the live adapter (never re-derived from the profile). */
function epochOf(h: StudioHarness): number {
  return engineOf(h).generationEpoch();
}

describe("W9206-31 — configure() only bumps the epoch when the config really moved", () => {
  it("an EMPTY patch is a no-op (POST /api/config {})", async () => {
    const h = harness();
    const before = epochOf(h);
    const res = await engineOf(h).configure({});
    expect(res.model).toBeTruthy();
    expect(epochOf(h)).toBe(before);
  });

  it("re-sending the CURRENT values is a no-op (a Save button / a script)", async () => {
    const h = harness();
    const engine = engineOf(h);
    const current = engine.profile();
    const before = epochOf(h);

    await engine.configure({
      model: current.model,
      base_url: current.base_url,
      max_steps: current.max_steps,
      context_window: current.context_window,
      system_prompt: current.system_prompt,
      reasoning_effort: current.reasoning_effort,
      max_output_tokens: current.max_output_tokens,
      max_retries: current.max_retries,
    });

    expect(epochOf(h)).toBe(before);
  });

  it("a REAL change still bumps exactly once", async () => {
    const h = harness();
    const engine = engineOf(h);
    const before = epochOf(h);
    const res = await engine.configure({ model: "swapped-model" });
    expect(res.model).toBe("swapped-model");
    expect(epochOf(h)).toBe(before + 1);
  });

  it("a patch that NORMALIZES to the current value is a no-op", async () => {
    const h = harness();
    const engine = engineOf(h);
    const current = engine.profile();
    const before = epochOf(h);

    // `max_steps: 0` is floored to MIN_STEPS by applyProfilePatch; a fractional
    // context_window is truncated. Neither may count as a change.
    await engine.configure({ max_steps: 0, context_window: current.context_window + 0.4 });

    expect(engine.profile().max_steps).toBe(current.max_steps);
    expect(engine.profile().context_window).toBe(current.context_window);
    expect(epochOf(h)).toBe(before);
  });

  it("max_retries is live config: a change bumps, a same value does not", async () => {
    const h = harness();
    const engine = engineOf(h);
    const before = epochOf(h);
    const current = engine.profile().max_retries ?? 1;

    await engine.configure({ max_retries: current });
    expect(epochOf(h)).toBe(before);

    await engine.configure({ max_retries: current === 3 ? 2 : 3 });
    expect(epochOf(h)).toBe(before + 1);
  });

  it("a real change is still visible on the next GET /api/config", async () => {
    const h = harness();
    const engine = engineOf(h);
    await engine.configure({ system_prompt: "a new identity prompt" });
    expect(engine.profile().system_prompt).toBe("a new identity prompt");
  });
});
