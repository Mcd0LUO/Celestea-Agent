// @vitest-environment jsdom
/**
 * H · @提及工作区文件（只传路径）：打 @ 弹出、逐级进入、前缀过滤、选中插入**路径文本**、
 * Esc 关闭；负例：绝不能把文件内容读进来（断言请求里只有路径、且没有读内容的调用）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike, WEB } from './lib/w795-dom.js';

interface ViewCtxMod {
  initViewCtx(): unknown;
  ensurePane(id: string, kind?: string, title?: string): { el: ElLike };
  activatePane(id: string, kind?: string, title?: string): unknown;
  setPaneMeta(id: string, meta: { workspace?: string }): void;
}
interface CommandsMod {
  installCommands(): void;
  workspacePath(): string;
  refresh(line: string, caret?: number): Promise<void>;
  completionVisible(): boolean;
  activeItemLabel(): string;
}
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rowLabels = (): string[] => Array.from(doc.querySelectorAll('#cmdPopup .cmd-row .cmd-name')).map((n) => n.textContent ?? '');
const popupVisible = (): boolean => (doc.getElementById('cmdPopup') as ElLike | null)?.classList.contains('hidden') === false;
const cmdCss = (): string => readFileSync(join(WEB, 'src', 'styles', 'commands.css'), 'utf8');

function key(el: ElLike, k: string): void {
  const ev = new Ev('keydown', { bubbles: true });
  Object.defineProperty(ev, 'key', { value: k });
  el.dispatchEvent(ev);
}

describe('H · @提及工作区文件（只传路径）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  async function boot(): Promise<{ cmd: CommandsMod; input: ElLike; urls: string[]; bodies: string[] }> {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s1', 'session', '甲会话');
    ctxMod.activatePane('ws/s1', 'session', '甲会话');
    ctxMod.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' }); // 会话归属的工作区名
    // 工作区注册表：名字 → 绝对路径（workspacePath 据此解析）。
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
    store.setWsList([{ name: 'celestea_studio-ts', path: '/src/celestea_studio-ts' }]);
    const urls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown }) => {
      const u = String(url);
      urls.push(u);
      if (init?.body !== undefined) bodies.push(String(init.body));
      // GET /api/fs/list?path=…
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/src')) return reply(200, { path: p, parent: '/', entries: [ { name: 'ui', type: 'dir', size: null, mtime: null }, { name: 'main.ts', type: 'file', size: 1234, mtime: null } ], roots: [], truncated: false });
        return reply(200, { path: p, parent: null, entries: [
          { name: 'src', type: 'dir', size: null, mtime: null },
          { name: 'README.md', type: 'file', size: 2048, mtime: null },
        ], roots: [], truncated: false });
      }
      return reply(200, { ok: true });
    });
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CommandsMod;
    cmd.installCommands();
    return { cmd, input: doc.getElementById('input') as ElLike, urls, bodies };
  }

  it('workspacePath 由会话 workspace 名解析到绝对路径', async () => {
    const { cmd } = await boot();
    expect(cmd.workspacePath()).toBe('/src/celestea_studio-ts');
  });

  it('打 @ 弹出工作区（目录 + 文件，目录项带视觉区分）', async () => {
    const { input, urls } = await boot();
    input.value = '@';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupVisible()).toBe(true);
    expect(urls.some((u) => u.includes('/api/fs/list'))).toBe(true);
    expect(rowLabels()).toEqual(['src/', 'README.md']);
    expect(doc.querySelector('#cmdPopup .cmd-row.dir .cmd-name')?.textContent).toBe('src/');
    expect(cmdCss(), '目录行有独立样式').toContain('.cmd-row.dir');
  });

  it('逐级进入：@src/ 列出该目录内容', async () => {
    const { input } = await boot();
    input.value = '@src/';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(rowLabels()).toEqual(['src/ui/', 'src/main.ts']);
  });

  it('前缀过滤：@RE 只留 README.md', async () => {
    const { input } = await boot();
    input.value = '@RE';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(rowLabels()).toEqual(['README.md']);
  });

  it('选中文件：输入框插入 @路径（只传路径，不读内容）', async () => {
    const { input, bodies } = await boot();
    input.value = '@RE';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    (doc.querySelector('#cmdPopup .cmd-row') as ElLike).dispatchEvent(new Ev('mousedown', { bubbles: true }));
    await flush();
    expect(input.value).toBe('@README.md');
    expect(popupVisible(), '文件选中后关闭补全').toBe(false);
    // 负例：不得发出任何带文件内容的请求；请求体里也不该出现文件正文。
    expect(bodies.every((b) => !b.includes('README 的正文'))).toBe(true);
  });

  it('负例：只传路径 —— 源码里不出现读文件内容的端点/调用', async () => {
    const filesSrc = readFileSync(join(WEB, 'src', 'ui', 'commands', 'files.ts'), 'utf8');
    // 只允许 fs/list 列举；不得调用任何「读文件内容」端点。
    expect(filesSrc).toContain('/api/fs/list');
    expect(filesSrc, '不得引用读内容端点').not.toMatch(/fs\/read|readFile|fsRead/);
    expect(filesSrc, '不得把内容拼进 value').not.toMatch(/value:\s*[^,]*content/);
  });

  it('Esc 关闭补全', async () => {
    const { input } = await boot();
    input.value = '@';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(popupVisible()).toBe(true);
    key(input, 'Escape');
    expect(popupVisible()).toBe(false);
  });

  it('降级：工作区无法解析 ⇒ 可读提示，不静默', async () => {
    const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
    ctxMod.initViewCtx();
    const pane = ctxMod.ensurePane('ws/s9', 'session', '无工作区');
    ctxMod.activatePane('ws/s9', 'session', '无工作区');
    const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
    store.setWsList([]);
    vi.stubGlobal('fetch', async () => reply(200, { ok: true }));
    const cmd = (await import(/* @vite-ignore */ at('ui/commands/index.ts'))) as CommandsMod;
    cmd.installCommands();
    const input = doc.getElementById('input') as ElLike;
    input.value = '@';
    input.dispatchEvent(new Ev('input', { bubbles: true }));
    await flush();
    expect(doc.querySelector('.msg.info')?.textContent ?? '', '必须有可读提示').toContain('工作区');
    void pane;
  });
});
