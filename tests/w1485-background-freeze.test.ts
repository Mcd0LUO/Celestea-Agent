// @vitest-environment jsdom
// ============================================================================
// tests/w1485-background-freeze.test.ts — W1485「切后台一段时间后切回，页面卡死」
// 的机械门禁（P0 用户报障）。
//
// 四条断言各自钉住一层根因：
//   A. 单条消息的**渲染上限**：超长正文只渲染前缀 + 一行提示，原文不丢（展开后全文）；
//   B. 后台标签页**不排渲染**，切回时由 flushVisible() 一次性对齐（不再攒成巨型 parse）；
//   C. 消息容器的 **DOM 上限**：超出部分从头部回收，且 rail 上对应的长条同步摘掉
//      （否则长条会按空 rect 缩在轨道顶端骗人）；
//   D. 历史恢复**分片**：大历史片间让出事件循环，单片历史仍在同一个微任务里建完
//      （W867 的「0ms 内到位」不回归）。
//
// 变异负控制（每条都实测先红后绿，见报告）：
//   A1 去掉 clampForRender 调用 → A 红；A2 去掉展开回调 → A 红；
//   B  去掉 document.hidden 早退 → B 红；B2 flushVisible 不渲染 → B 红；
//   C  去掉 prunePaneDom 调用 → C 红；C2 去掉 railDropCols → C 红；
//   D  去掉 yieldToBrowser → D 红。
// ============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface El {
  textContent: string | null;
  className: string;
  parentElement: El | null;
  childElementCount: number;
  children: ArrayLike<El>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  hidden: boolean;
  isConnected?: boolean;
  appendChild(n: unknown): unknown;
  insertBefore(n: unknown, ref: unknown): unknown;
  replaceChildren(...nodes: unknown[]): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  remove(): void;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
}
interface Pane {
  el: El;
  render: { timer: number | null; deadline: number };
}
interface View {
  content: El;
  bubble: El;
  root: El;
  text: string;
}
interface AssistantMod {
  appendText(ctx: unknown, view: unknown, delta: string): void;
  flushVisible(): void;
  RENDER_DEBOUNCE: number;
}
interface MessagesMod {
  ensureAssistant(ctx: unknown): View;
}
interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): Pane;
  activatePane(id: string, kind?: string, title?: string): unknown;
}
interface OversizeMod {
  MESSAGE_RENDER_LIMIT: number;
  clampForRender(text: string, limit: number): { text: string; omitted: number };
}
interface DomCapMod {
  MAX_DOM_COLS: number;
  DOM_PRUNE_BATCH: number;
  prunePaneDom(ctx: unknown, force?: boolean): number;
}

const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
const msgMod = (await import(/* @vite-ignore */ at('ui/messages.ts'))) as MessagesMod;
const asstMod = (await import(/* @vite-ignore */ at('ui/messages/assistant.ts'))) as AssistantMod;
const overMod = (await import(/* @vite-ignore */ at('ui/messages/oversize.ts'))) as OversizeMod;
const capMod = (await import(/* @vite-ignore */ at('ui/messages/dom-cap.ts'))) as DomCapMod;
// ★ 与上面几条一样**必须在顶层**导入：vitest 的顶层动态 import 与用例体内的
//   import 会拿到**两个不同的模块实例**（实测 railTop !== railIn），混用会让
//   dom-cap 里的 railDropCols 与用例里的 rail 各持一份 WeakMap —— 断言会看到
//   「裁剪没摘长条」这种假红。
const railMod = (await import(/* @vite-ignore */ at('ui/rail.ts'))) as {
  initRail(): void;
  railAdd(ctx: unknown, col: unknown, role: string): void;
};
// 条数是**只读查询**，家就在记账层（rail.ts 受模块体积棘轮约束，不再加薄壳）。
const railStateMod = (await import(/* @vite-ignore */ at('ui/rail-state.ts'))) as {
  barCountOf(ctx: unknown): number;
};

async function microtasks(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/**
 * 装一个**已挂载**的会话容器 + 助手气泡。
 *
 * ★ 必须把 #messages 重新挂回 body：afterEach 的 `doc.body.replaceChildren()` 会把
 *   它摘下来，而 initViewCtx 是幂等的（不会再找一次宿主），于是第二个用例起容器
 *   就在文档之外 —— 那时 `view.root.isConnected === false`，渲染路径会**正确地**
 *   跳过 DOM 裁剪（那是给离屏历史恢复留的优化），断言会看到「没裁」这种假红。
 *   这里显式断言前提，避免门禁静默退化成空转。
 */
function boot(id: string): { pane: Pane; view: View } {
  ctxMod.initViewCtx();
  const pane = ctxMod.ensurePane(id, 'session', '甲会话');
  ctxMod.activatePane(id, 'session', '甲会话');
  const host = pane.el.parentElement as unknown as El | null;
  if (host !== null && host.isConnected === false) doc.body.appendChild(host as never);
  const view = msgMod.ensureAssistant(pane);
  if (view.root.isConnected === false) throw new Error('boot: 容器必须在文档里（见上）');
  return { pane, view };
}

/** 设成后台（document.hidden = true）—— jsdom 的 visibilityState 是 getter，故用 defineProperty。 */
function setHidden(hidden: boolean): void {
  // 本文件不引 DOM lib（与 tests/w847-turn-lane-dom.test.ts 同一取舍），
  // 所以 `document` 走 globalThis 取，而不是裸用全局名。
  const d = (globalThis as unknown as { document: object }).document;
  Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(d, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

describe('W1485 · A：单条消息的渲染上限', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); doc.body.replaceChildren(); });

  it('clampForRender 是纯函数：不超限原样返回，超限截断并报出省略字数', () => {
    expect(overMod.clampForRender('abc', 10)).toEqual({ text: 'abc', omitted: 0 });
    expect(overMod.clampForRender('abcdefghij', 4)).toEqual({ text: 'abcd', omitted: 6 });
    expect(overMod.MESSAGE_RENDER_LIMIT, '上限必须远大于正常消息').toBeGreaterThan(16384);
  });

  it('超长正文：DOM 只拿到前缀，提示行给出省略字数；点「展开全部」后全文到位', async () => {
    const { pane, view } = boot('ws/A');
    const limit = overMod.MESSAGE_RENDER_LIMIT;
    const tail = 'TAIL-MARKER-结尾';
    view.text = 'x'.repeat(limit + 500) + tail;
    asstMod.appendText(pane as unknown, view as unknown, '');
    await vi.advanceTimersByTimeAsync(60);
    expect(view.content.textContent, '超出上限的部分不得进 DOM').not.toContain(tail);
    const note = view.content.querySelector('.oversize-note');
    expect(note, '必须有省略提示行').not.toBeNull();
    expect(note!.textContent, '提示行要报出省略字数').toContain(String(514));
    // 展开：全文渲染一次。真实路径是「点击 → d.expanded=true → renderTextView」；
    // 这里直接驱动同一个渲染入口（jsdom 的 click 不派发到 addEventListener 之外的
    // 路径上，按钮本身的可点性由真机 CDP 那条断言覆盖）。
    const btn = view.content.querySelector('.oversize-more')!;
    expect(btn, '展开按钮必须在 DOM 里（可点性见真机证据）').not.toBeNull();
    // ★ 点**真实按钮**（不是直接调渲染入口）：这样「按钮回调里漏了置 expanded /
    //   漏了清短路哨兵」这类真 bug 才会被抓到 —— 直接调入口会让按钮回调变成死代码。
    (btn as unknown as { click(): void }).click();
    expect(view.content.textContent, '展开后全文到位').toContain(tail);
    expect(view.content.querySelector('.oversize-note'), '展开后提示行撤掉').toBeNull();
  });

  it('未超限的普通消息不产生提示行（这条路径对正常内容不可达）', async () => {
    const { pane, view } = boot('ws/A2');
    view.text = '一句普通回答';
    asstMod.appendText(pane as unknown, view as unknown, '');
    await vi.advanceTimersByTimeAsync(60);
    expect(view.content.querySelector('.oversize-note')).toBeNull();
    expect(view.content.textContent).toContain('一句普通回答');
  });
});

describe('W1485 · B：后台不排渲染，切回一次性对齐', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); doc.body.replaceChildren(); });

  it('document.hidden 期间不渲染（只累积），变可见后 flushVisible 一次到位', async () => {
    const { pane, view } = boot('ws/B');
    setHidden(true);
    asstMod.appendText(pane as unknown, view as unknown, '后台累积的第一段');
    await vi.advanceTimersByTimeAsync(500);
    expect(pane.render.timer, '后台不得留下排队的渲染定时器').toBeNull();
    expect(view.content.textContent, '后台期间 DOM 不动').not.toContain('后台累积的第一段');

    setHidden(false);
    asstMod.flushVisible();
    expect(view.content.textContent, '切回后同一调用栈内对齐').toContain('后台累积的第一段');
  });

  it('可见时的正常节拍不受影响（leading 立即渲染）', async () => {
    const { pane, view } = boot('ws/B2');
    setHidden(false);
    asstMod.appendText(pane as unknown, view as unknown, '前台第一段');
    expect(view.content.textContent).toContain('前台第一段');
  });
});

describe('W1485 · C：消息容器的 DOM 上限', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); doc.body.replaceChildren(); });

  it('超过上限时从头部回收，且回收条数 = 超出量（批量上限内）', async () => {
    const { pane, view } = boot('ws/C');
    const over = capMod.MAX_DOM_COLS + 5;
    for (let i = 0; i < over; i += 1) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      pane.el.appendChild(col);
    }
    // boot() 里已经建过一个助手气泡（也是 .mcol）→ 总数比手工造的条数多 1。
    const base = pane.el.querySelectorAll('.mcol').length - over;
    expect(base, 'boot 的助手气泡').toBe(1);
    expect(pane.el.querySelectorAll('.mcol').length).toBe(over + base);
    // ★ 通过**真实渲染路径**触发裁剪（不是直接调 prunePaneDom）：这样「渲染后忘了
    //   调裁剪」这条变异才会被抓到。appendText 的 trailing 渲染会走到那里。
    view.text = '触发一次渲染';
    asstMod.appendText(pane as unknown, view as unknown, '');
    await vi.advanceTimersByTimeAsync(60);
    // 一次回收 = min(超出量, 批量上限)；真实路径只裁一批，剩下的留给下一次扫描。
    expect(pane.el.querySelectorAll('.mcol').length, '真实路径必须裁掉一批').toBe(
      over + base - Math.min(over + base - capMod.MAX_DOM_COLS, capMod.DOM_PRUNE_BATCH),
    );
    // 再强制裁到上限，验证「反复扫描最终收敛」。
    while (capMod.prunePaneDom(pane, true) > 0) { /* 收敛到上限 */ }
    expect(pane.el.querySelectorAll('.mcol').length).toBe(capMod.MAX_DOM_COLS);
  });

  /** rail 的装配要 ResizeObserver（与 tests/w867-rail-hit.test.ts 同一桩）。 */
  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  }

  it('未超上限时一条都不裁（阈值是安全阀，不是每帧不变量）', async () => {
    const rail = railMod;
    stubResizeObserver();
    rail.initRail();
    const { pane } = boot('ws/C2');
    // boot() 的助手气泡自己也起了一根条（一问一答合并的轮起点），故先记基线。
    const before = railStateMod.barCountOf(pane as unknown);
    for (let i = 0; i < 4; i += 1) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      pane.el.appendChild(col);
      rail.railAdd(pane as unknown, col as unknown, 'user');
    }
    expect(railStateMod.barCountOf(pane as unknown), '新增四根条').toBe(before + 4);
    capMod.prunePaneDom(pane, true); // 未超上限 → 一条都不裁
    expect(railStateMod.barCountOf(pane as unknown), '未超上限不得摘条').toBe(before + 4);
  });

  it('裁剪触发时 rail 条数与 DOM 列数保持一致', async () => {
    const rail = railMod;
    stubResizeObserver();
    rail.initRail();
    const { pane } = boot('ws/C3');
    for (let i = 0; i < capMod.MAX_DOM_COLS + 3; i += 1) {
      const col = doc.createElement('div');
      col.className = 'mcol';
      pane.el.appendChild(col);
      rail.railAdd(pane as unknown, col as unknown, 'user');
    }
    while (capMod.prunePaneDom(pane, true) > 0) { /* 收敛到上限 */ }
    expect(pane.el.querySelectorAll('.mcol').length).toBe(capMod.MAX_DOM_COLS);
    expect(railStateMod.barCountOf(pane as unknown), '条数必须跟着列数走').toBe(capMod.MAX_DOM_COLS);
  });
});

describe('W1485 · E：工具结果的渲染上限', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); doc.body.replaceChildren(); });

  it('超长工具结果只渲染前缀 + 提示行；展开后全文到位', async () => {
    const tools = (await import(/* @vite-ignore */ at('ui/toolcards.ts'))) as {
      buildToolCard(d: Record<string, unknown>): {
        col: El; card: El; label: El; resultPv: El; body: El; subs: El; toolName: string;
      };
      setToolResult(ref: unknown, text: string, failed: boolean, value?: unknown): void;
    };
    const over = (await import(/* @vite-ignore */ at('ui/messages/oversize.ts'))) as {
      TOOL_RESULT_RENDER_LIMIT: number;
    };
    const ref = tools.buildToolCard({ step: 1, name: 'read_file', argsText: '{}', desc: '读文件' });
    const tail = 'TOOL-TAIL-结尾';
    const text = 'y'.repeat(over.TOOL_RESULT_RENDER_LIMIT + 300) + tail;
    tools.setToolResult(ref as unknown, text, false);
    const out = ref.body.querySelector('.tool-out')!;
    expect(out, '结果正文在 DOM 里').not.toBeNull();
    expect(out.textContent, '超出上限的部分不得进 DOM').not.toContain(tail);
    expect(ref.body.querySelector('.oversize-note'), '必须有省略提示行').not.toBeNull();
    const btn = ref.body.querySelector('.oversize-more')!;
    (btn as unknown as { click(): void }).click();
    expect(ref.body.querySelector('.tool-out')!.textContent, '展开后全文到位').toContain(tail);
  });
});

describe('W1485 · D：历史恢复分片', () => {
  beforeEach(() => { resetHarness(); vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  function history(n: number): unknown {
    const messages: Array<Record<string, string>> = [];
    for (let i = 0; i < n; i += 1) messages.push({ role: 'user', content: '问 ' + i });
    return { messages };
  }

  it('大历史片间让出事件循环：同步段不建完全部列，排空定时器后才齐', async () => {
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as {
      restoreSessionHistory(pane: unknown): Promise<void>;
    };
    const { pane } = boot('ws/D');
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => history(120) }));
    const running = restore.restoreSessionHistory(pane as unknown);
    await microtasks();
    const early = pane.el.querySelectorAll('.mcol').length;
    expect(early, '第一片之后不得建完全部 120 条').toBeLessThan(120);
    await vi.runAllTimersAsync();
    await running;
    expect(pane.el.querySelectorAll('.mcol').length, '全部到位').toBe(120);
  });

  it('小历史（单片）仍在纯微任务里建完 —— W867 的「0ms 内到位」不回归', async () => {
    const restore = (await import(/* @vite-ignore */ at('ui/restore.ts'))) as {
      restoreSessionHistory(pane: unknown): Promise<void>;
    };
    const { pane } = boot('ws/D2');
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => history(6) }));
    const running = restore.restoreSessionHistory(pane as unknown);
    await microtasks();
    expect(pane.el.querySelectorAll('.mcol').length, '同一微任务内建完').toBe(6);
    await running;
  });
});
