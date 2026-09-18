// @vitest-environment jsdom
/**
 * W867 · 用户 6②：Q/A 渲染「近似立即 + 短 debounce」—— 两条路径都测。
 *
 * ① live 流（ui/messages/assistant.ts）：事件到达即渲染（**同一调用栈内**，不再等 60ms 节拍）；
 *    同一合并窗口内的突发多帧并成一次尾部重排（绝不逐字节重排）。
 * ② 历史恢复（ui/restore.ts）：整段历史在**纯微任务**里渲染完（0ms 内），且离屏构建期间
 *    不写滚动位（恢复结束时自己贴底一次）。
 *
 * 计时探针：对真实气泡的 .content 打 DOM 变更计数 —— renderTextView 每次渲染必定至少写一次
 * （首帧/reset 走 replaceChildren，增量尾部走 insertBefore/appendChild），所以计数 = 重排次数。
 * 本仓根 tsconfig 没有 DOM lib（见 tests/lib/w795-dom.ts 的夹具口径），故这里全部用最小结构类型。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

/** 只声明用到的成员（运行时就是真实 jsdom 节点）。 */
interface ContentEl {
  textContent: string | null;
  appendChild(n: unknown): unknown;
  insertBefore(n: unknown, ref: unknown): unknown;
  replaceChildren(...nodes: unknown[]): void;
}
interface PaneEl {
  textContent: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelectorAll(sel: string): ArrayLike<unknown>;
}
interface Pane {
  el: PaneEl;
}
interface MessagesMod {
  appendText(ctx: unknown, view: unknown, delta: string): void;
  ensureAssistant(ctx: unknown): unknown;
}
interface AssistantMod {
  RENDER_DEBOUNCE: number;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface RestoreMod {
  restoreSessionHistory(pane: unknown): Promise<void>;
}

/** 排空微任务（不推进任何定时器）。 */
async function microtasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** 装一个真实会话容器 + 真实助手气泡（容器对象内建 renderTimer/renderDeadline）。 */
async function bootAssistant(): Promise<{
  mod: MessagesMod;
  view: ContentEl & { content: ContentEl };
  ctx: Pane;
}> {
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  const ctx = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  const mod = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
  const view = mod.ensureAssistant(ctx) as ContentEl & { content: ContentEl };
  return { mod, view, ctx };
}

/** .content 上的 DOM 变更调用次数（= 真正发生重排的次数）。 */
function countAppends(content: ContentEl): () => number {
  let n = 0;
  const append = content.appendChild.bind(content);
  const insert = content.insertBefore.bind(content);
  const replace = content.replaceChildren.bind(content);
  content.appendChild = (node: unknown) => {
    n += 1;
    return append(node);
  };
  content.insertBefore = (node: unknown, ref: unknown) => {
    n += 1;
    return insert(node, ref);
  };
  content.replaceChildren = (...nodes: unknown[]) => {
    n += 1;
    replace(...nodes);
  };
  return () => n;
}

/** 给容器装一个「写盘计数」的 scrollTop（粘性自动滚动的唯一写出口）。 */
function countScrollWrites(pane: Pane): () => number {
  let writes = 0;
  let top = 0;
  Object.defineProperty(pane.el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      writes += 1;
      top = v;
    },
  });
  return () => writes;
}

describe('W867 · 用户 6②：live 流渲染（近似立即 + 短 debounce）', () => {
  beforeEach(() => {
    resetHarness();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('合并窗口必须是短 debounce（≈1 帧），不再是 60ms 节拍', async () => {
    const assistant = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as AssistantMod;
    expect(assistant.RENDER_DEBOUNCE, '模块必须导出合并窗口常量').toBeTypeOf('number');
    expect(assistant.RENDER_DEBOUNCE).toBeGreaterThan(0);
    expect(assistant.RENDER_DEBOUNCE, '必须显著短于旧的 60ms').toBeLessThanOrEqual(16);
  });

  it('单帧到达：同一调用栈内就渲染（不推进任何定时器）', async () => {
    const { mod, view, ctx } = await bootAssistant();
    const calls = countAppends(view.content);
    mod.appendText(ctx, view, '第一段正文');
    expect(calls(), '文本已进 DOM —— 事件到达即渲染，不等节拍').toBeGreaterThan(0);
    expect(view.content.textContent).toContain('第一段正文');
  });

  it('突发 40 帧：合并成少数几次重排（既快又不逐字节重排）', async () => {
    const { mod, view, ctx } = await bootAssistant();
    const calls = countAppends(view.content);
    for (let i = 0; i < 40; i++) mod.appendText(ctx, view, 'chunk' + i + ' ');
    expect(calls(), '第一帧立即渲染').toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(100);
    const total = calls();
    expect(total, '40 帧不得变成 40 次重排').toBeLessThanOrEqual(3);
    expect(total, '也不得把整个突发吞掉').toBeGreaterThanOrEqual(2);
    expect(view.content.textContent, '最终文本必须完整').toContain('chunk39');
  });

  it('窗口内合并、窗口外立即：连续流每过一个窗口就出一次字', async () => {
    const { mod, view, ctx } = await bootAssistant();
    mod.appendText(ctx, view, 'A');
    expect(view.content.textContent, '第一帧同一调用栈内可见').toContain('A');
    await vi.advanceTimersByTimeAsync(60); // 远超合并窗口：尾部已落下、上下文空闲
    mod.appendText(ctx, view, 'B'); // 距上次渲染 > 窗口 → 又是 leading
    expect(view.content.textContent, '空闲后的下一帧同样立即可见').toContain('B');
    expect(view.content.textContent).toContain('AB');
  });
});

describe('W867 · 用户 6②：历史恢复（restore.ts）', () => {
  beforeEach(() => {
    resetHarness();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  /** 造一个「内容比视口高」的会话容器（否则 autoscroll 本来就什么都不写）。 */
  async function bootPane(): Promise<{ pane: Pane }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    Object.defineProperty(pane.el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(pane.el, 'clientHeight', { value: 500, configurable: true });
    return { pane };
  }

  const HISTORY = {
    messages: [
      { role: 'user', content: '历史问题一' },
      { role: 'assistant', content: '历史回答一' },
      { role: 'user', content: '历史问题二' },
      { role: 'assistant', content: '历史回答二' },
    ],
  };

  it('整段历史在 0ms（纯微任务）内渲染完 —— 不再等 60ms 节拍', async () => {
    const { pane } = await bootPane();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => HISTORY }));
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const running = restore.restoreSessionHistory(pane);
    await microtasks();
    expect(pane.el.querySelectorAll('.msg.user').length, '两条用户消息').toBe(2);
    expect(pane.el.querySelectorAll('.msg.assistant').length, '两条助手消息').toBe(2);
    expect(pane.el.textContent).toContain('历史回答二');
    await running;
  });

  it('离屏构建期间不写滚动位：整段恢复只允许末尾那一次贴底', async () => {
    const { pane } = await bootPane();
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => HISTORY }));
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as RestoreMod;
    const writes = countScrollWrites(pane);
    await restore.restoreSessionHistory(pane);
    expect(writes(), '旧实现 = 每条助手消息写一次 + 末尾一次；现在只写末尾那一次').toBe(1);
    expect(pane.el.scrollTop, '末尾仍然贴底').toBe(1000);
  });
});
