// @vitest-environment jsdom
/**
 * 目录选择器面包屑在 **win32 路径**下的实际 DOM：根按钮标签 = 'C:\\'、段 = Users/me/proj；
 * 点根按钮导航到 'C:\\'（不是假 '/'）。另证 POSIX 侧不回归。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface FsBrowserMod { openFsBrowser(opts: { title: string; confirmLabel: string; busyLabel: string; onPick: (p: string) => void }): void }

const crumbs = (): string[] => Array.from(doc.querySelectorAll('.ws-fs-crumb')).map((n) => n.textContent ?? '');
const dirNames = (): string[] => Array.from(doc.querySelectorAll('.ws-fs-dir-name')).map((n) => n.textContent ?? '');

describe('目录选择器 · win32 面包屑', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(browse: (p: string) => unknown): Promise<{ calls: string[] }> {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/browse')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        calls.push(p);
        return reply(200, browse(p));
      }
      return reply(200, { ok: true });
    });
    const mod = (await import(/* @vite-ignore */ at('ui/fsbrowser.ts'))) as FsBrowserMod;
    mod.openFsBrowser({ title: '选择目录', confirmLabel: '确定', busyLabel: '处理中', onPick: () => {} });
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    return { calls };
  }

  it('win32：根按钮 = C:\，段 = Users/me/proj；点根 ⇒ loadDirs(C:\)', async () => {
    const { calls } = await boot((p) => (p === 'C:\\' ? { path: 'C:\\', dirs: ['Users'] } : { path: 'C:\\Users\\me\\proj', dirs: ['sub'] }));
    expect(crumbs()).toEqual(['C:\\', 'Users', 'me', 'proj']);
    expect(dirNames()).toEqual(['sub']);
    const rootBtn = doc.querySelector('.ws-fs-crumb') as ElLike;
    rootBtn.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls[calls.length - 1]).toBe('C:\\');
  });

  it('POSIX 不回归：根按钮 = /，段 = a/b', async () => {
    await boot(() => ({ path: '/a/b', dirs: ['c'] }));
    expect(crumbs()).toEqual(['/', 'a', 'b']);
  });
});
