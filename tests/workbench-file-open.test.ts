// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件**在行下方内联展开**（GET /api/fs/read）。
 * 覆盖：文本文件出内容、binary/读取失败给可读降级、truncated 标记、目录仍进入、
 * 以及**可见性**（祖先链无 hidden/display:none —— 存在 ≠ 可见）。
 *
 * ★ W1532（用户：「点击文件默认就是展开的 vscode 风格」）：本文件的断言是**有意
 *   更新**的（架构师批准）。旧断言是「点文件打开 F2 右侧**覆盖式浮层**」
 *   （previewIsOpen() === true + .preview-host 可见 + 内容在 .preview-body 里）。
 *   新断言是同一条不变量换一个落点：内容仍由 GET /api/fs/read 装载、仍非空、
 *   仍可见、降级仍可读 —— 但它必须出现在**文件行的正下方**（DOM 兄弟），
 *   而不是浮层。判别力由变异负控制证明：改回浮层 ⇒ 这条立刻红（见报告）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface PreviewMod { previewIsOpen(): boolean }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
/** 内联展开块的文本（W1532：内容长在这里，不再在浮层的 .preview-body 里）。 */
const bodyText = (): string => (doc.querySelector('.wb-inline') as ElLike | null)?.textContent ?? '';
const inline = (): ElLike | null => doc.querySelector('.wb-inline') as ElLike | null;
const rowOf = (name: string): ElLike | undefined => rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
/**
 * ElLike 垫片只声明了用例用到的那部分 DOM 面（见 tests/lib/w795-dom.ts）。
 * 「展开块是不是文件行的下一个兄弟」要读 nextElementSibling —— 真实 DOM 有，
 * 垫片的类型面没有，所以在这里按本仓既有做法（g4-workbench-step2.test.ts 给
 * getBoundingClientRect 打补丁）显式补一个窄类型。
 */
const siblingOf = (n: ElLike): ElLike | null =>
  (n as unknown as { nextElementSibling: ElLike | null }).nextElementSibling;
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

describe('文件管理器 · 点文件内联展开（W1532）', () => {
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

  it('点文本文件 → 内容**内联在文件行下方**（非浮层）、非空、可见', async () => {
    const { wb, readCalls } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 2048, kind: 'text', text: '# Hello\nworld', offset: 1, limit: 2000, totalLines: 2, truncated: false }));
    await clickFile(wb, 'README.md');
    const pv = (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PreviewMod;
    expect(readCalls.length, '应打 GET /api/fs/read').toBe(1);
    expect(readCalls[0]).toContain('path=%2Fsrc%2Fcelestea_studio-ts%2FREADME.md');
    // ★ W1532：内容在**行下方**的 .wb-inline 里，不再是右侧覆盖式浮层。
    expect(pv.previewIsOpen(), '不得再打开覆盖式浮层').toBe(false);
    // 浮层宿主由 openPreview() **懒建**：从没打开过就根本不存在。不变量是
    // 「不可见」，同时覆盖「不存在」与「存在但 hidden」两种形态。
    expect(visibleInDom(doc.querySelector('.preview-host') as ElLike | null), '浮层宿主不得可见').toBe(false);
    const box = inline();
    if (box === null) throw new Error('展开块不存在');
    expect(bodyText(), '内联内容非空').toContain('Hello');
    // ★ DOM 位置证明「内联」：展开块是**文件行的下一个兄弟**（同一个列表容器内），
    //   而不是脱离列表、盖住视口的浮层。这一条是「VSCode 风格」的机械定义。
    const row = rowOf('README.md') as ElLike;
    expect(siblingOf(row), '展开块必须紧跟文件行（行下方）').toBe(box);
    expect(box.parentElement, '展开块与文件行同容器（不脱离列表）').toBe(row.parentElement);
    expect(box.querySelector('.wb-inline-status'), '装载完成后等待提示消失').toBeNull();
    // 可见性：存在 ≠ 可见（祖先链无 hidden/display:none）
    expect(visibleInDom(box), '展开块必须真的可见').toBe(true);
  });

  it('binary → 可读降级原因（不白屏）', async () => {
    const { wb } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 10, kind: 'binary', text: '', offset: 1, limit: 2000, totalLines: 0, truncated: false }));
    await clickFile(wb, 'README.md');
    expect(bodyText()).toContain('二进制');
    expect(visibleInDom(doc.querySelector('.wb-inline .preview-degrade') as ElLike | null)).toBe(true);
    // 降级也带类型徽标（与浮层同一条口径）。
    expect((doc.querySelector('.wb-inline-badge') as ElLike | null)?.textContent ?? '').toContain('二进制');
  });

  it('读取失败（4xx）→ 可读降级原因', async () => {
    const { wb } = await setup(reply(400, { error: 'not a regular file' }), 400);
    await clickFile(wb, 'README.md');
    expect(bodyText().length, '降级原因不能为空').toBeGreaterThan(0);
    expect(visibleInDom(doc.querySelector('.wb-inline .preview-degrade') as ElLike | null)).toBe(true);
  });

  it('truncated → 显示「已截断」标记', async () => {
    const { wb } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 999999, kind: 'text', text: 'line', offset: 1, limit: 2000, totalLines: 99999, truncated: true }));
    await clickFile(wb, 'README.md');
    const note = doc.querySelector('.wb-inline-note') as ElLike | null;
    expect(note?.textContent ?? '').toContain('已截断');
    expect(visibleInDom(note)).toBe(true);
  });

  it('点目录仍然进入目录（不展开文件）', async () => {
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
    expect(inline(), '进入目录不得留下展开块').toBeNull();
  });

  /**
   * W1532：**再点同一行收起**（VSCode 的 toggle），且收起后重新渲染的列表里
   * 那一行不再是 open 态 —— 「展开」是一个有状态、可逆的动作，不是一次性弹层。
   */
  it('再点同一行 → 收起（展开块消失、行不再 open）', async () => {
    const { wb } = await setup(reply(200, { path: '/src/celestea_studio-ts/README.md', size: 2048, kind: 'text', text: 'hello', offset: 1, limit: 2000, totalLines: 1, truncated: false }));
    await clickFile(wb, 'README.md');
    expect(inline(), '先展开').not.toBeNull();
    expect(rowOf('README.md')?.classList.contains('open')).toBe(true);
    rowOf('README.md')!.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    expect(inline(), '再点必须收起').toBeNull();
    expect(rowOf('README.md')?.classList.contains('open'), '收起后行不再是 open 态').toBe(false);
  });

  /**
   * W1532 **竞态守卫**（state.ts 的 seq 模式）：快速连点两个不同文件时，先点那个
   * 文件的读取结果可能**后**到。它绝不能被画进后点那个文件的展开块里 —— 那正是
   * 「内容串了」这个 bug 的形态。这里把第一个响应扣住，先让第二个落地，再放行。
   */
  it('竞态：先点文件的晚到响应不得覆盖后点文件的内容', async () => {
    const gate: Array<() => void> = [];
    const { wb } = await setup(reply(200, { path: '', size: 0, kind: 'text', text: '', offset: 1, limit: 2000, totalLines: 0, truncated: false }));
    // 重装 fetch：A 的响应挂在 gate 上，B 立即返回。
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'A.md', type: 'file', size: 10, mtime: null }, { name: 'B.md', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('A.md')) {
          await new Promise<void>((res) => gate.push(res)); // 扣住 A
          return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-A', offset: 1, limit: 2000, totalLines: 1, truncated: false });
        }
        return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-B', offset: 1, limit: 2000, totalLines: 1, truncated: false });
      }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    rowOf('A.md')!.dispatchEvent(new Ev('click', { bubbles: true })); // 展开 A（响应被扣住）
    await flush();
    rowOf('B.md')!.dispatchEvent(new Ev('click', { bubbles: true })); // 改点 B（立即返回）
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(bodyText(), 'B 的内容先落地').toContain('CONTENT-B');
    gate.forEach((res) => res()); // 放行 A 的晚到响应
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(bodyText(), 'A 的晚到内容不得串进 B 的展开块').toContain('CONTENT-B');
    expect(bodyText(), 'A 的内容一个字都不许出现').not.toContain('CONTENT-A');
    expect(doc.querySelectorAll('.wb-inline').length, '同时只允许一个展开块').toBe(1);
  });
});
