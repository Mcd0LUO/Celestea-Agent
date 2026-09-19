// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件打开 F2 预览面板（GET /api/fs/read）。
 * 覆盖：文本文件出内容、binary/读取失败给可读降级、truncated 标记、目录仍进入、
 * 以及**可见性**（祖先链无 hidden/display:none —— 存在 ≠ 可见）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface PreviewMod { previewIsOpen(): boolean }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
const bodyText = (): string => (doc.querySelector('.preview-body') as ElLike | null)?.textContent ?? '';
const visibleInDom = (node: ElLike | null): boolean => {
  if (!node) return false;
  let n: ElLike | null = node;
  while (n) {
    if (n.classList.contains('hidden')) return false;
    if ((n as unknown as { style?: { display?: string } }).style?.display === 'none') return false;
    n = n.parentElement as ElLike | null;
  }
  return node.isConnected === true;
};

describe('文件管理器 · 点文件打开预览（F2 P1）', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function setup(readReply: unknown, readStatus = 200): Promise<{ wb: WbMod; readCalls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    ctxMod.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' });
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
    store.setWsList([{ name: 'celestea_studio-ts', path: '/src/celestea_studio-ts' }]);
    const readCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/src')) return reply(200, { path: p, parent: '/src/celestea_studio-ts', entries: [{ name: 'main.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
        return reply(200, { path: p, parent: null, entries: [{ name: 'README.md', type: 'file', size: 2048, mtime: null }, { name: 'src', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) { readCalls.push(u); return readStatus === 200 ? readReply : reply(readStatus, readReply); }
      return reply(200, { ok: true });
    });
    const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
    wb.resetPanels();
    wb.initWorkbench();
    return { wb, readCalls };
  }

  async function clickFile(wb: WbMod, name: string): Promise<void> {
    wb.openPanel('files', 'right');
    await flush();
    const row = rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
    expect(row, '目录列表里应有 ' + name).not.toBeUndefined();
    row!.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
  }

  it('点文本文件 → 预览面板打开、标题=文件名、内容非空、可见', async () => {
    const { wb, readCalls } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 2048, kind: 'text', text: '# Hello\nworld', offset: 1, limit: 2000, totalLines: 2, truncated: false }));
    await clickFile(wb, 'README.md');
    const pv = (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PreviewMod;
    expect(readCalls.length, '应打 GET /api/fs/read').toBe(1);
    expect(readCalls[0]).toContain('path=%2Fsrc%2Fcelestea_studio-ts%2FREADME.md');
    expect(pv.previewIsOpen()).toBe(true);
    expect((doc.querySelector('.preview-title') as ElLike | null)?.textContent).toBe('README.md');
    expect((doc.querySelector('.preview-path') as ElLike | null)?.textContent).toBe('/src/celestea_studio-ts/README.md');
    expect(bodyText(), '预览内容非空').toContain('Hello');
    // 可见性：存在 ≠ 可见（祖先链无 hidden/display:none）
    expect(visibleInDom(doc.querySelector('.preview-host') as ElLike | null), '预览面板必须真的可见').toBe(true);
  });

  it('binary → 可读降级原因（不白屏）', async () => {
    const { wb } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 10, kind: 'binary', text: '', offset: 1, limit: 2000, totalLines: 0, truncated: false }));
    await clickFile(wb, 'README.md');
    expect(bodyText()).toContain('二进制');
    expect(visibleInDom(doc.querySelector('.preview-degrade') as ElLike | null)).toBe(true);
  });

  it('读取失败（4xx）→ 可读降级原因', async () => {
    const { wb } = await setup(reply(400, { error: 'not a regular file' }), 400);
    await clickFile(wb, 'README.md');
    expect(bodyText().length, '降级原因不能为空').toBeGreaterThan(0);
    expect(visibleInDom(doc.querySelector('.preview-degrade') as ElLike | null)).toBe(true);
  });

  it('truncated → 显示「已截断」标记', async () => {
    const { wb } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 999999, kind: 'text', text: 'line', offset: 1, limit: 2000, totalLines: 99999, truncated: true }));
    await clickFile(wb, 'README.md');
    const note = doc.querySelector('.preview-note') as ElLike | null;
    expect(note?.textContent ?? '').toContain('已截断');
    expect(visibleInDom(note)).toBe(true);
  });

  it('点目录仍然进入目录（不打开预览）', async () => {
    const { wb } = await setup(reply(200, { path: '', size: 0, kind: 'text', text: '', offset: 1, limit: 2000, totalLines: 0, truncated: false }));
    wb.openPanel('files', 'right');
    await flush();
    const dirRow = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'src')!;
    dirRow.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect((doc.querySelector('.wb-crumb-cur') as ElLike | null)?.textContent).toBe('/src/celestea_studio-ts/src');
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['main.ts']);
  });
});
