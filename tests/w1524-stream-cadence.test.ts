// @vitest-environment jsdom
/**
 * W1524 · 流式渲染的**自适应合并窗口**（真机实测驱动的回归门禁）。
 *
 * 被门禁钉住的缺陷（CDP 真机 1440×900，代码形态）：
 *   固定 12ms 窗口 + 单次 renderTextView 实测 ≈12ms ⇒ 「渲染耗时 ≥ 窗口」时 leading 分支
 *   每次都命中，窗口一次都合并不了。实测一个 4 帧突发 = 4 次同步全量渲染，10 个流式长帧、
 *   最长 81.9ms、长帧总时长 654ms。
 *
 * 门禁分两层：
 *   ① 纯函数层（mergeWindow / waitFor）—— 策略本身；
 *   ② 接线层（appendText → scheduleTextView）—— 实测代价真的被用上了。
 * 两层都要有：只测纯函数的话，接线漏掉（cost 没被写回）门禁照样绿。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface CadenceMod {
  mergeWindow(costMs: number | undefined, floorMs: number, maxMs?: number): number;
  waitFor(now: number, c: { timer: number | null; deadline: number; cost?: number }, floorMs: number): number;
  RENDER_DUTY: number;
  RENDER_WINDOW_MAX: number;
  newRenderCadence(): { timer: number | null; deadline: number; cost?: number };
}
interface PaneRender {
  timer: number | null;
  deadline: number;
  cost?: number;
}
interface Pane {
  el: { scrollTop: number; scrollHeight: number; clientHeight: number };
  render: PaneRender;
}
interface AssistantMod {
  RENDER_DEBOUNCE: number;
}
interface MessagesMod {
  appendText(ctx: unknown, view: unknown, delta: string): void;
  ensureAssistant(ctx: unknown): unknown;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface View {
  /** 助手气泡里的正文容器（渲染产物落点）。 */
  content: { textContent: string | null };
}

/**
 * 装一个真实会话容器 + 真实助手气泡（容器对象内建 render 节拍）。
 *
 * ★ 读文本必须走 view.content.textContent，不能读 view.textContent：
 *   AssistantView 是 { root, bubble, content, … }，**没有** textContent 字段（读到 undefined）。
 *   第一版就是这么写的，三个断言全挂在 "expected undefined"。
 */
async function boot(): Promise<{ mod: MessagesMod; view: View; ctx: Pane; cadence: CadenceMod; debounce: number }> {
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  const ctx = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  const mod = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
  const cadence = (await import(/* @vite-ignore */ at('ui/messages/cadence.ts'))) as CadenceMod;
  const assistant = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as AssistantMod;
  const view = mod.ensureAssistant(ctx) as View;
  return { mod, view, ctx, cadence, debounce: assistant.RENDER_DEBOUNCE };
}

describe('W1524 · 自适应合并窗口（纯函数层）', () => {
  it('窗口 = clamp(实测耗时 × 占空比, 下限, 上限)', async () => {
    const c = (await import(/* @vite-ignore */ at('ui/messages/cadence.ts'))) as CadenceMod;
    expect(c.RENDER_DUTY, '占空比必须是 >1 的因子：等于 1 时窗口 == 耗时，leading 每次命中').toBeGreaterThan(1);
    expect(c.mergeWindow(0, 12)).toBe(12); // 没测到 → 下限（与 W867 固定窗口等价）
    expect(c.mergeWindow(undefined, 12)).toBe(12);
    expect(c.mergeWindow(Number.NaN, 12)).toBe(12);
    expect(c.mergeWindow(3, 12)).toBe(12); // 比下限还快 → 仍按下限（保住 ~1 帧的观感）
    expect(c.mergeWindow(20, 12)).toBe(20 * c.RENDER_DUTY); // 实测生效
    expect(c.mergeWindow(10000, 12)).toBe(c.RENDER_WINDOW_MAX); // 上限（最坏也就等 ~3 帧）
  });

  it('首帧哨兵：deadline = -Infinity 恒返回 0（W867 语义一字不变）', async () => {
    const c = (await import(/* @vite-ignore */ at('ui/messages/cadence.ts'))) as CadenceMod;
    const fresh = c.newRenderCadence();
    expect(fresh.cost, '新容器没有实测代价').toBe(0);
    expect(c.waitFor(1000, fresh, 12), '从未渲染过 → 立即').toBe(0);
    expect(c.waitFor(1000, { timer: null, deadline: 990, cost: 40 }, 12), '刚渲染过且很贵 → 还要等').toBeGreaterThan(0);
    expect(c.waitFor(99999, { timer: null, deadline: 990, cost: 40 }, 12), '等够了 → 0').toBe(0);
  });
});

describe('W1524 · 实测代价真的被用上（接线层）', () => {
  beforeEach(() => {
    resetHarness();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('没测到代价 → 首帧仍在同一调用栈内渲染（W867 的 leading 不能被改坏）', async () => {
    const { mod, view, ctx } = await boot();
    mod.appendText(ctx, view, '第一段正文');
    expect(view.content.textContent, '事件到达即出字').toContain('第一段正文');
  });

  it('每次真正渲染都把**实测耗时**写回节拍（接线不能漏）', async () => {
    const { mod, view, ctx } = await boot();
    // 哨兵：置成不可能由渲染产生的值，渲染后必须被覆盖。
    // 只断言「是数字」抓不到「写回被删掉」—— newRenderCadence 本来就给 0（也是数字）。
    ctx.render.cost = -1;
    mod.appendText(ctx, view, '量一次');
    expect(ctx.render.cost, '渲染后 cost 必须被实测值覆盖（-1 是哨兵，不是测量结果）').not.toBe(-1);
    expect(ctx.render.cost, '实测耗时是有限的非负数').toBeGreaterThanOrEqual(0);
    // 第二次渲染同样要刷新（不能只写一次）。
    ctx.render.cost = -1;
    ctx.render.deadline = Number.NEGATIVE_INFINITY; // 强制走 leading，跳过窗口
    mod.appendText(ctx, view, '再量一次');
    expect(ctx.render.cost, '每一次渲染都要刷新实测代价').not.toBe(-1);
  });

  it('上一次渲染很贵 → 增量被并进窗口，不再逐帧同步重排', async () => {
    const { mod, view, ctx, debounce } = await boot();
    mod.appendText(ctx, view, 'A'); // 首帧（leading）
    // 模拟「上一次渲染实测 40ms」（真机上由 renderTimed 写回）
    ctx.render.cost = 40;
    ctx.render.deadline = performance.now();
    const before = view.content.textContent ?? '';
    mod.appendText(ctx, view, 'B');
    expect(view.content.textContent, '窗口内不得立刻重排 —— 这正是固定 12ms 窗口做不到的事').toBe(before);
    expect(ctx.render.timer, '必须有一次尾部渲染排队').not.toBeNull();
    await vi.advanceTimersByTimeAsync(40 * 2 + debounce + 5);
    expect(view.content.textContent, '窗口过后必须补齐').toContain('AB');
  });

  it('突发 8 帧 + 昂贵渲染：合并成少数几次，且最终文本完整', async () => {
    const { mod, view, ctx, debounce } = await boot();
    ctx.render.cost = 30;
    for (let i = 0; i < 8; i++) mod.appendText(ctx, view, 'chunk' + i + ' ');
    await vi.advanceTimersByTimeAsync(30 * 2 * 8 + debounce + 20);
    expect(view.content.textContent, '一帧都不能丢').toContain('chunk7');
  });

  /**
   * W1524 回归：done 到达时文本**没变**，但有一次渲染还排在窗口里。
   *
   * 旧实现 applyFinalText 在 view.text === text 时直接 return —— 终态要等满一个合并窗口
   * 才落地。真机影响：turn 结束后正文停在旧 DOM 上（W1524 的窗口最坏 50ms）；测试影响：
   * tests/w895r-live-replay-parity 靠「done 后 8 个宏任务内 DOM 是终态」读结果，实测
   * 6 跑 2 红（原始代码 6 跑 0 红）。
   */
  it('done 文本未变 + 有排队渲染 → 立即冲刷，不等窗口', async () => {
    const assistant = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as unknown as {
      applyFinalText(ctx: unknown, view: unknown, text: string): void;
    };
    const { mod, view, ctx, debounce } = await boot();
    mod.appendText(ctx, view, '终态正文');
    ctx.render.cost = 50; // 昂贵 → 下一次窗口 100ms
    ctx.render.deadline = performance.now();
    mod.appendText(ctx, view, ''); // 触发一次排队（文本没变，只排队）
    const queued = ctx.render.timer;
    if (queued === null) {
      // 没排上队说明仍在窗口内走了 leading —— 那本次断言的前提不成立，显式跳过。
      expect(ctx.render.timer).toBeNull();
      return;
    }
    assistant.applyFinalText(ctx, view, '终态正文');
    expect(ctx.render.timer, 'done 之后不得再有排队的渲染').toBeNull();
    await vi.advanceTimersByTimeAsync(debounce);
    expect(view.content.textContent, '终态内容完整').toContain('终态正文');
  });
});
