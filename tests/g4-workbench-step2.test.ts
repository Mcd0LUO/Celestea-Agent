// @vitest-environment jsdom
/**
 * G4 第二步 · 终端 + 浏览器 + dock 拖拽切换：
 * 终端一次执行渲染（不假装 TTY）、浏览器 iframe + 被拒可读提示、拖动标题栏切 dock。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown }
interface WbMod {
  initWorkbench(): void;
  openPanel(kind: string, dock?: string): { id: string };
  closePanel(id: string): void;
  resetPanels(): void;
  listPanels(): { id: string; kind: string; dock: string }[];
}

const panelBodies = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-panel .wb-body')) as ElLike[];
/** W1528：注入的假帧源（每条用例各自一份，用来断言输出真的写进了 xterm）。 */
const frameSinks: Array<Array<(f: unknown) => void>> = [];

function key(el: ElLike, k: string): void {
  const ev = new Ev('keydown', { bubbles: true });
  Object.defineProperty(ev, 'key', { value: k });
  el.dispatchEvent(ev);
}
function mouse(el: ElLike, type: string, x: number, y: number): void {
  const ev = new Ev(type, { bubbles: true });
  Object.defineProperty(ev, 'clientX', { value: x });
  Object.defineProperty(ev, 'clientY', { value: y });
  el.dispatchEvent(ev);
}

describe('G4 · 多面板工作区（第二步）', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  /**
   * W1528：xterm 是**懒加载**的（\`await import('@xterm/xterm')\`），jsdom 里既
   * 没有 canvas 也不该真去加载它。用 \`setXtermLoader\` 注入一个最小假 Terminal ——
   * 这样这条用例验的是**我们自己的接线**（打开走哪个端点、pty id 怎么用），
   * 而不是 xterm 的内部实现。
   */
  async function injectFakeXterm(): Promise<{ writes: string[]; disposed: number }> {
    const mod = (await import(/* @vite-ignore */ at('ui/workbench/terminal-pty.ts'))) as {
      setXtermLoader(l: () => Promise<unknown>): void;
      setFrameSource(s: ((h: (f: unknown) => void) => () => void) | null): void;
    };
    // jsdom 没有 EventSource；注入一个记录型假源，让接线走**成功**分支。
    const frames: Array<(f: unknown) => void> = [];
    mod.setFrameSource((h) => { frames.push(h); return () => undefined; });
    frameSinks.push(frames);
    const state = { writes: [] as string[], disposed: 0 };
    // 形状必须与真包一致：\`{ term: { Terminal }, fit: { FitAddon } }\` —— 两个都是
    // **构造函数**，不是实例。写成实例会让 openPty 在 \`new\` 处抛，测出来的
    // 是「装配失败」而不是「接线正确」（第一版就是这么写的，断言因此假绿）。
    class FakeTerminal {
      cols = 80;
      rows = 24;
      open(): void { /* jsdom 无 canvas：挂载是空操作 */ }
      dispose(): void { state.disposed += 1; }
      write(d: string): void { state.writes.push(d); }
      onData(): { dispose(): void } { return { dispose: () => undefined }; }
      loadAddon(): void { /* no-op */ }
    }
    class FakeFit { fit(): void { /* no-op */ } }
    mod.setXtermLoader(async () => ({ term: { Terminal: FakeTerminal }, fit: { FitAddon: FakeFit } }));
    return state;
  }

  async function setup(): Promise<{ wb: WbMod; execCalls: string[]; terminalCalls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const execCalls: string[] = [];
    const terminalCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      if (u.includes('/api/terminal')) {
        terminalCalls.push(u);
        return reply(200, { ok: true, id: 'term-test', pid: 4242, cols: 80, rows: 24, sandbox: {} });
      }
      if (u.includes('/api/exec')) {
        execCalls.push(String(init?.body ?? ''));
        return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hello\n', stderr: '', duration_ms: 7, sandbox: {} });
      }
      return reply(200, { ok: true });
    });
    const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
    wb.resetPanels();
    wb.initWorkbench();
    return { wb, execCalls, terminalCalls };
  }

  /**
   * W1528：终端不再是「一次性执行」。这条用例的**旧断言**是「明确声明不是交互式
   * 终端」—— 那正是本波要删掉的谎。现在断言的是反面：面板说的是真终端，而且
   * 打开的入口是 POST /api/terminal（pty），不是 POST /api/exec（跑完才返回）。
   */
  it('终端：声明是真终端，打开走 POST /api/terminal（pty），不再走 /api/exec', async () => {
    const fake = await injectFakeXterm();
    const { wb, execCalls, terminalCalls } = await setup();
    wb.openPanel('terminal', 'right');
    await flush();
    const body = panelBodies()[0] as ElLike;
    const note = body.querySelector('.wb-term-note')?.textContent ?? '';
    expect(note, '声明是真终端').toContain('真终端');
    expect(note, '不得再自称一次性执行').not.toContain('不是交互式终端');
    expect(body.querySelector('.wb-term-input'), '不再有一次性命令输入框').toBeNull();
    const open = body.querySelector('.wb-term-open') as ElLike;
    expect(open, '未连上时给「打开终端」入口').not.toBeNull();
    open.click();
    await flush(20);
    expect(terminalCalls.length, '打开终端 = 一次 POST /api/terminal').toBe(1);
    expect(terminalCalls[0]).toContain('/api/terminal');
    expect(execCalls.length, '不得回落到一次性执行').toBe(0);
    // 连上之后画的是 xterm 宿主（.wb-term-xterm），不再有「打开」按钮。
    expect(body.querySelector('.wb-term-xterm'), 'pty 连上后挂 xterm 宿主').not.toBeNull();
    expect(body.querySelector('.wb-term-open'), '连上后入口消失').toBeNull();
    void fake;
  });

  /**
   * W1528 生命周期：**关面板必须杀掉 pty**（进程泄漏 = 真 bug）。
   * 断言的是「发出了一次 POST /api/terminal/{id}/close」—— 那条不变量在渲染层
   * 成立；服务端真的杀进程由 tests/w1528-real-terminal.test.ts 用 ps 证。
   */
  it('终端：关闭面板发出 close（进程不泄漏）', async () => {
    await injectFakeXterm();
    const { wb, terminalCalls } = await setup();
    const p = wb.openPanel('terminal', 'right');
    await flush();
    (panelBodies()[0] as ElLike).querySelector('.wb-term-open')?.click();
    await flush(20);
    expect(terminalCalls.length).toBe(1);
    // 关闭面板 → 渲染层重画 → 集合差发现它没了 → 发出 close。
    wb.closePanel(p.id);
    await flush(20);
    const closes = terminalCalls.filter((u) => u.includes('/close'));
    expect(closes.length, '关面板必须关闭 pty').toBe(1);
    expect(closes[0]).toContain('term-test');
  });

  it('浏览器：iframe 指向输入的 URL；加载超时给可读提示 + 新标签出口', async () => {
    const { wb } = await setup();
    const browserMod = (await import(/* @vite-ignore */ at('ui/workbench/browser.ts'))) as { setLoadTimeout(ms: number): void };
    browserMod.setLoadTimeout(10); // 缩短加载超时，测试快速触发「被拒」分支
    wb.openPanel('browser', 'right');
    await flush();
    const body = panelBodies()[0] as ElLike;
    const input = body.querySelector('.wb-url-input') as ElLike;
    input.value = 'example.com';
    key(input, 'Enter');
    const frame = body.querySelector('.wb-frame') as ElLike;
    expect(String(frame.getAttribute('src') ?? ''), '自动补 https://').toBe('https://example.com');
    await new Promise((r) => setTimeout(r, 30)); // 等过缩短后的加载超时
    await flush();
    expect(body.querySelector('.wb-notice')?.textContent ?? '', '被拒/超时要可读提示').toContain('不允许被嵌入');
    expect(body.querySelector('.wb-url-external')?.classList.contains('hidden')).toBe(false);
  });

  it('dock 拖拽切换：拖标题栏到下方 ⇒ bottom；到上方 ⇒ right', async () => {
    const { wb } = await setup();
    const p = wb.openPanel('terminal', 'right');
    await flush();
    const host = doc.querySelector('.wb-host') as ElLike;
    (host as unknown as { getBoundingClientRect(): { top: number; height: number; left: number; width: number; right: number; bottom: number } }).getBoundingClientRect = () => ({ top: 0, height: 600, left: 0, width: 900, right: 900, bottom: 600 });
    const head = doc.querySelector('.wb-panel .wb-head') as ElLike;
    mouse(head, 'mousedown', 10, 10);
    mouse(doc.body as ElLike, 'mousemove', 10, 500); // 下 1/3
    await flush();
    mouse(doc.body as ElLike, 'mouseup', 10, 500);
    await flush();
    expect(wb.listPanels()[0]?.dock, '拖到下方 ⇒ bottom').toBe('bottom');
    // 再拖回上方 ⇒ right
    const head2 = doc.querySelector('.wb-panel .wb-head') as ElLike;
    mouse(head2, 'mousedown', 10, 10);
    mouse(doc.body as ElLike, 'mousemove', 10, 50);
    await flush();
    mouse(doc.body as ElLike, 'mouseup', 10, 50);
    await flush();
    expect(wb.listPanels()[0]?.dock, '拖到上方 ⇒ right').toBe('right');
    void p;
  });
});
