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
  resetPanels(): void;
  listPanels(): { id: string; kind: string; dock: string }[];
}

const panelBodies = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-panel .wb-body')) as ElLike[];

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

  async function setup(): Promise<{ wb: WbMod; execCalls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    const execCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      if (u.includes('/api/exec')) {
        execCalls.push(String(init?.body ?? ''));
        return reply(200, { ok: true, exit_code: 0, signal: null, stdout: 'hello\n', stderr: '', duration_ms: 7, sandbox: {} });
      }
      return reply(200, { ok: true });
    });
    const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
    wb.resetPanels();
    wb.initWorkbench();
    return { wb, execCalls };
  }

  it('终端：一次性执行渲染输出（命令 + stdout + 退出码/耗时），不假装 TTY', async () => {
    const { wb, execCalls } = await setup();
    wb.openPanel('terminal', 'right');
    await flush();
    const body = panelBodies()[0] as ElLike;
    expect(body.querySelector('.wb-term-note')?.textContent ?? '', '明确声明不是交互式终端').toContain('不是交互式终端');
    const input = body.querySelector('.wb-term-input') as ElLike;
    input.value = 'echo hi';
    key(input, 'Enter');
    await flush();
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain('echo hi');
    expect(body.querySelector('.wb-term-out')?.textContent).toContain('hello');
    expect(body.querySelector('.wb-term-meta')?.textContent ?? '').toContain('退出码 0');
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
