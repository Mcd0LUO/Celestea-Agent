// @vitest-environment jsdom
/**
 * win32 非路径类审计：
 *   ① 文件管理器在盘符根 C:\ 时「上一级」禁用（后端把 parent 回成 C:\ 自身），非根启用；
 *   ② 终端面板占位符**平台中立**（不再写死 POSIX 的 ls -la）；
 *   ③ 源码级：apps/web/src 无 process.platform / navigator.platform / child_process / spawn。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const upBtn = (): ElLike => doc.querySelector('.wb-crumb') as ElLike;
const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];

describe('win32 非路径类审计', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(workspace: string, listPath: string): Promise<{ wb: WbMod; listCalls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    ctxMod.setPaneMeta('ws/s1', { workspace });
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
    store.setWsList([]);
    const listCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        listCalls.push(p);
        return reply(200, { path: listPath, parent: null, entries: [{ name: 'Users', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
      }
      return reply(200, { ok: true });
    });
    const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
    wb.resetPanels();
    wb.initWorkbench();
    return { wb, listCalls };
  }

  it('盘符根 C:\\：上一级禁用 + title 说明；点击不发新请求', async () => {
    const { wb, listCalls } = await boot('C:\\', 'C:\\');
    wb.openPanel('files', 'right');
    await flush();
    const before = listCalls.length;
    expect(upBtn().disabled, 'C:\\ 是根 ⇒ 上一级禁用').toBe(true);
    expect(upBtn().title).toBe('已在根目录');
    upBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(listCalls.length, '根上点上一级不得产生新请求').toBe(before);
    expect(rows().length).toBeGreaterThan(0);
  });

  it('非根 C:\\Users：上一级启用；点击导航到 C:\\', async () => {
    const { wb, listCalls } = await boot('C:\\Users', 'C:\\Users');
    wb.openPanel('files', 'right');
    await flush();
    expect(upBtn().disabled).toBe(false);
    upBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(listCalls[listCalls.length - 1]).toBe('C:\\');
  });

  /**
   * W1528：终端面板改成真 PTY 后**没有占位符了**（输入由 xterm 自己接管），
   * 但这条用例的本意是「终端面板不得写死 POSIX 专属示例」—— 它依然成立，只是
   * 检查对象从 placeholder 换成面板上的说明文案。删掉这条会丢掉那层保护。
   */
  it('终端面板文案平台中立（不含 POSIX 专属示例 ls -la）', async () => {
    const { wb } = await boot('C:\\', 'C:\\');
    wb.openPanel('terminal', 'right');
    await flush();
    const note = String(doc.querySelector('.wb-term-note')?.textContent ?? '');
    const hint = String(doc.querySelector('.wb-term-hint')?.textContent ?? '');
    expect(note.length).toBeGreaterThan(0);
    expect(note + ' ' + hint, '不得写死 POSIX 示例 ls').not.toMatch(/\bls\b/);
  });

  it('源码级：apps/web/src 无 process.platform / navigator.platform / child_process / spawn', () => {
    const files: string[] = [];
    (function walk(d: string): void {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) files.push(p);
      }
    })(join(process.cwd(), 'apps', 'web', 'src'));
    const offenders = files.filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /process\.platform|navigator\.platform|child_process|spawnSync|\bspawn\(/.test(s);
    });
    expect(offenders, '前端不得用宿主平台分支，也不得自己 spawn 进程').toEqual([]);
  });
});
