// @vitest-environment jsdom
/**
 * G4 第一步 · 多面板工作区：入口菜单、开/关面板、多开、dock 切换、
 * 文件管理器（进入目录 / 选中文件 / truncated+错误降级）、关闭不重建背景。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
  setPaneMeta(id: string, meta: { workspace?: string }): void;
}
interface WbMod {
  initWorkbench(): void;
  openPanel(kind: string, dock?: string): { id: string };
  closePanel(id: string): void;
  listPanels(): { id: string; kind: string; dock: string; size: number }[];
  setPanelDock(id: string, dock: string): void;
  toggleWorkbenchMenu(): void;
  openWorkbenchPanel(kind: string): void;
  resetPanels(): void;
}
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const panels = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-panel')) as ElLike[];
const panelIds = (): string[] => panels().map((p) => p.dataset['panelId'] ?? '');
const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
const menuVisible = (): boolean => (doc.getElementById('wbMenu') as ElLike | null)?.classList.contains('hidden') === false;

function boot(): void {
  resetHarness();
  // 夹具骨架没有 topbar：补一个入口按钮（真实 index.html 里它在 .topbar-right）。
  const btn = doc.createElement('button') as unknown as ElLike;
  btn.id = 'btnWorkbench';
  doc.body.appendChild(btn);
}

describe('G4 · 多面板工作区（第一步）', () => {
  beforeEach(() => { boot(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function setup(): Promise<{ wb: WbMod; msgs: ElLike; urls: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    ctxMod.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' });
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
    store.setWsList([{ name: 'celestea_studio-ts', path: '/src/celestea_studio-ts' }]);
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/src')) return reply(200, { path: p, parent: '/', entries: [ { name: 'ui', type: 'dir', size: null, mtime: null }, { name: 'main.ts', type: 'file', size: 1234, mtime: '2026-09-19T00:00:00.000Z' } ], roots: [], truncated: false });
        return reply(200, { path: p, parent: null, entries: [ { name: 'src', type: 'dir', size: null, mtime: null }, { name: 'README.md', type: 'file', size: 2048, mtime: null } ], roots: [], truncated: false });
      }
      return reply(200, { ok: true });
    });
    const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
    wb.resetPanels();
    wb.initWorkbench();
    return { wb, msgs: doc.getElementById('messages') as ElLike, urls };
  }

  it('入口按钮弹出菜单（文件管理器 / 终端 / 浏览器）', async () => {
    const { wb } = await setup();
    (doc.getElementById('btnWorkbench') as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    expect(menuVisible()).toBe(true);
    const labels = Array.from(doc.querySelectorAll('#wbMenu .wb-menu-label')).map((n) => n.textContent);
    expect(labels).toEqual(['文件管理器', '终端', '浏览器']);
    void wb;
  });

  it('开面板：文件管理器渲染当前工作区；可多开；关闭后背景节点身份不变', async () => {
    const { wb, msgs } = await setup();
    const marker = doc.createElement('div') as unknown as ElLike;
    marker.className = 'bg-marker';
    msgs.appendChild(marker);
    // 回归守卫（用户实测报「面板打不开」）：光有面板节点不够，**宿主必须真的可见**。
    // 曾经的 bug：installWorkbench 给 .wb-host 加了 'hidden' 防闪烁，renderWorkbench 只切了
    // dock 的 hidden，宿主永远 display:none ⇒ 面板建出来了却完全看不见。
    // 既有用例只数节点个数，测不出这种「存在但不可见」，所以这条断言必须留着。
    const hostVisible = (): boolean =>
      (doc.querySelector('.wb-host') as ElLike | null)?.classList.contains('hidden') === false;
    expect(hostVisible(), '没有面板时宿主应隐藏（不占位、不挡点击）').toBe(false);
    const a = wb.openPanel('files', 'right');
    await flush();
    expect(panels().length).toBe(1);
    expect(hostVisible(), '开面板后宿主必须可见').toBe(true);
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['src', 'README.md']);
    const b = wb.openPanel('files', 'right');
    await flush();
    expect(panels().length, '同一种可多开').toBe(2);
    expect(new Set(panelIds()).size).toBe(2);
    wb.closePanel(a.id);
    await flush();
    expect(panels().length).toBe(1);
    expect(msgs.querySelector('.bg-marker'), '关闭面板不得重建背景').toBe(marker);
    expect(hostVisible(), '还有面板时宿主仍可见').toBe(true);
    wb.closePanel(b.id);
    await flush();
    expect(panels().length).toBe(0);
    expect(hostVisible(), '全部关闭后宿主必须重新隐藏').toBe(false);
    void b;
  });

  it('dock 切换：right ↔ bottom', async () => {
    const { wb } = await setup();
    const p = wb.openPanel('files', 'right');
    await flush();
    expect(doc.querySelector('.wb-zone.right')).not.toBeNull();
    expect(doc.querySelector('.wb-zone.bottom')).toBeNull();
    wb.setPanelDock(p.id, 'bottom');
    await flush();
    expect(doc.querySelector('.wb-zone.bottom')).not.toBeNull();
    expect(doc.querySelector('.wb-zone.right')).toBeNull();
    expect(wb.listPanels()[0]?.dock).toBe('bottom');
  });

  it('文件管理器：进入目录、选中文件、面包屑/上级', async () => {
    const { wb } = await setup();
    wb.openPanel('files', 'right');
    await flush();
    const srcRow = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'src') as ElLike;
    srcRow.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['ui', 'main.ts']);
    const fileRow = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'main.ts') as ElLike;
    fileRow.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(fileRow.classList.contains('sel'), '点文件进入选中态').toBe(true);
    // 上级回到工作区根
    (doc.querySelector('.wb-crumb') as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['src', 'README.md']);
  });

  it('降级：truncated 与目录错误都显式提示', async () => {
    const { wb } = await setup();
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/bad')) return reply(400, { path: p, entries: [], truncated: false, error: 'not an existing directory' });
        return reply(200, { path: p, parent: null, entries: [], roots: [], truncated: true });
      }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    expect(doc.querySelector('.wb-notice')?.textContent ?? '').toContain('只显示了前一部分');
    // 端点报错 → 可读提示
    vi.stubGlobal('fetch', async () => reply(400, { error: 'boom' }));
    wb.openPanel('files', 'right');
    await flush();
    const notices = Array.from(doc.querySelectorAll('.wb-notice')).map((n) => n.textContent ?? '');
    expect(notices.some((t) => t.includes('打不开') || t.includes('暂不可用'))).toBe(true);
  });
});
