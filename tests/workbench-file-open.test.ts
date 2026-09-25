// @vitest-environment jsdom
/**
 * 文件管理器 · 点文件 ⇒ **右侧预览面板**流式打开**完整文件**（W1545）。
 *
 * ★ W1545（用户原话：「文件管理器打开文件应该直接渲染完整的文件（流式打开巨文件）
 *   而不是直接原地展开，且原地展开的文件还没有高亮」+「右侧的预览是应该几乎瞬时
 *   出现的」）：本文件的断言是**有意更新**的（架构师批准）。旧断言钉的是 W1532 的
 *   「内容在文件行下方的 .wb-inline 里」—— 那个交互被用户点名删掉了。新断言是同
 *   一条不变量换一个落点：
 *     · 内容仍由 GET /api/fs/read 装载、仍非空、仍可见、降级仍可读；
 *     · 但它现在长在**右侧预览面板**的 .preview-body 里（.wb-inline 必须不存在）；
 *     · 并且是**完整**文件（分段取到 truncated=false，不是 256 KiB 截断/降级）；
 *     · 面板壳**当帧**出现（不等第一次读盘返回）。
 *   判别力由变异负控制证明（见 results/W1545-preview-stream.md「变异负控制」一节）：
 *   把 cap 改回 256 KiB ⇒ 「完整文件」红；把点击改回不打开面板 ⇒ 「面板打开」红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ViewCtxMod { initViewCtx(): unknown; ensurePane(id: string, kind?: string, title?: string): { el: ElLike }; activatePane(id: string, kind?: string, title?: string): unknown; setPaneMeta(id: string, meta: { workspace?: string }): void }
interface WbMod { initWorkbench(): void; openPanel(kind: string, dock?: string): { id: string }; resetPanels(): void }
interface PreviewMod { previewIsOpen(): boolean }
interface WorkspaceStoreMod { setWsList(v: unknown[]): void }

const rows = (): ElLike[] => Array.from(doc.querySelectorAll('.wb-row')) as ElLike[];
/** 预览面板的正文（W1545：内容长在这里，不再在文件行下方的 .wb-inline 里）。 */
const bodyText = (): string => (doc.querySelector('.preview-body') as ElLike | null)?.textContent ?? '';
const q = (s: string): ElLike | null => doc.querySelector(s) as ElLike | null;
const rowOf = (name: string): ElLike | undefined => rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
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
/** 分段块的全文（按 DOM 序拼接 = 面板里真正显示的文件内容）。 */
const shownText = (): string =>
  Array.from(doc.querySelectorAll('.preview-code code')).map((c) => c.textContent ?? '').join('');
const shownLines = (): number => {
  const s = shownText();
  if (s === '') return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
};

/**
 * 轮询等一个事实成立（上限 5s）。
 *
 * 为什么需要：分段之间会**让出一帧**（requestAnimationFrame，见 preview/stream.ts），
 * 而 jsdom 的 rAF 是按 ~16ms 的宏任务跑的 —— 用固定 flush 猜段数会随机器负载 flake
 * （本仓 W896 的教训：把「猜宏任务数」换成「等事实成立」）。超时上限保证「真的坏了」
 * 依旧快速失败，而不是永远等下去。
 */
async function waitFor(probe: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 造一个「像真服务端」的分页桩：按 offset/limit 切行窗口，末页 truncated=false。 */
function pagedServer(lines: string[], kind: 'text' | 'binary' = 'text'): { fetch: (url: unknown) => Promise<unknown>; calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: unknown): Promise<unknown> => {
    const u = String(url);
    if (u.includes('/api/fs/list')) {
      const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
      return reply(200, { path: p, parent: null, entries: [{ name: 'big.ts', type: 'file', size: 999, mtime: null }, { name: 'src', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
    }
    if (!u.includes('/api/fs/read')) return reply(200, { ok: true });
    calls.push(u);
    const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
    if (kind === 'binary') return reply(200, { path: p, size: 10, kind: 'binary', text: '', offset: 1, limit: 400, totalLines: 0, truncated: false });
    const offset = Number(/[?&]offset=(\d+)/.exec(u)?.[1] ?? '1');
    const limit = Number(/[?&]limit=(\d+)/.exec(u)?.[1] ?? '400');
    const window = lines.slice(offset - 1, offset - 1 + limit);
    const text = window.length === 0 ? '' : window.join('\n') + '\n';
    const more = offset - 1 + window.length < lines.length;
    return reply(200, { path: p, size: 999, kind: 'text', text, offset, limit, totalLines: lines.length, truncated: more });
  };
  return { fetch, calls };
}

/** 装配：真实 viewctx + 真实工作台（面板走真实路径），fetch 打桩。 */
async function setup(fetchImpl: (url: unknown) => Promise<unknown>): Promise<{ wb: WbMod }> {
  const ctxMod = (await import(/* @vite-ignore */ at('ui/viewctx.ts'))) as ViewCtxMod;
  ctxMod.initViewCtx();
  ctxMod.ensurePane('ws/s1', 'session', '甲会话');
  ctxMod.activatePane('ws/s1', 'session', '甲会话');
  ctxMod.setPaneMeta('ws/s1', { workspace: 'celestea_studio-ts' });
  const store = (await import(/* @vite-ignore */ at('ui/sessiontree/store.ts'))) as WorkspaceStoreMod;
  store.setWsList([{ name: 'celestea_studio-ts', path: '/src/celestea_studio-ts' }]);
  vi.stubGlobal('fetch', fetchImpl);
  const wb = (await import(/* @vite-ignore */ at('ui/workbench/index.ts'))) as WbMod;
  wb.resetPanels();
  wb.initWorkbench();
  return { wb };
}

/** 打开文件管理器并点一个文件（含等待 rAF：分段之间会**让出一帧**）。 */
async function clickFile(wb: WbMod, name: string): Promise<void> {
  wb.openPanel('files', 'right');
  await flush();
  const row = rows().find((r) => r.querySelector('.wb-name')?.textContent === name);
  expect(row, '目录列表里应有 ' + name).not.toBeUndefined();
  row!.dispatchEvent(new Ev('click', { bubbles: true }));
  await flush();
  await new Promise((r) => setTimeout(r, 40));
  await flush();
}

/**
 * 造 N 行「真代码」（有 hljs 认得出的关键字，供高亮断言）。
 *
 * ★ 行**故意写得长**（≈150 字符）：5000 行 ≈ 750 KB，远在 256 KiB 之上。
 *   为什么必须远：断言要能机械抓住「把上限改回 256 KiB」这个变异。若样本只有
 *   280 KB（刚好过线），截断只会发生在**最后一段**，而最后一段的 more=false
 *   本来就会正常收尾 ⇒ 变异跑绿、断言没有判别力（第一版就是这么假绿的，见报告）。
 */
function makeLines(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push('export function fn' + i + '(a: number, b: string, c: boolean): number { const s = "str-' + i + '"; const t = "tail-' + i + '"; return a + s.length + t.length + (c ? 1 : 0); }');
  }
  return out;
}

describe('文件管理器 · 点文件在右侧预览里流式打开（W1545）', () => {
  beforeEach(() => {
    resetHarness();
    const btn = doc.createElement('button') as unknown as ElLike;
    btn.id = 'btnWorkbench';
    doc.body.appendChild(btn);
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('点文本文件 → 内容在**右侧预览面板**里、非空、可见；行内展开块不存在', async () => {
    const srv = pagedServer(['# Hello', 'world']);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    const pv = (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PreviewMod;
    expect(srv.calls.length, '应打 GET /api/fs/read').toBe(1);
    expect(srv.calls[0]).toContain('path=%2Fsrc%2Fcelestea_studio-ts%2Fbig.ts');
    expect(pv.previewIsOpen(), '★ 必须打开右侧预览面板').toBe(true);
    expect(visibleInDom(q('.preview-host')), '★ 预览宿主必须真的可见').toBe(true);
    expect(bodyText(), '预览正文非空').toContain('Hello');
    // ★ W1545：行内展开被整块移除 —— 它没有 .rendered 祖先（高亮不着色）且塞不下完整文件。
    expect(q('.wb-inline'), '行内展开块必须不存在').toBeNull();
    // 选中态保留（g4-workbench.test.ts:134 的既有口径：点文件进入选中态）。
    expect(rowOf('big.ts')?.classList.contains('sel'), '点文件进入选中态').toBe(true);
    // 进度提示在全部段落落地后清空（不留「已读 N/M 行」的残影）。
    expect(q('.preview-stream-note')?.classList.contains('hidden'), '读完即清空进度提示').toBe(true);
  });

  it('★ 面板壳**当帧**出现：首段读盘还没回来，宿主已可见 + 骨架在位 + 标题/路径已就位', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => { release = r; });
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'slow.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) { await held; return reply(200, { path: '', size: 1, kind: 'text', text: 'x\n', offset: 1, limit: 400, totalLines: 1, truncated: false }); }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    rowOf('slow.ts')!.dispatchEvent(new Ev('click', { bubbles: true }));
    // ★ 不 await：读盘仍被扣住。壳必须**已经**在 DOM 里且可见。
    const host = q('.preview-host');
    expect(visibleInDom(host), '★ 读盘未返回时面板就必须可见（壳先出）').toBe(true);
    expect(q('.preview-skeleton'), '★ 骨架占位在位（不是白屏）').not.toBeNull();
    expect(q('.preview-title')?.textContent, '标题当帧就位').toBe('slow.ts');
    expect(q('.preview-path')?.textContent, '路径当帧就位').toBe('/src/celestea_studio-ts/slow.ts');
    expect(bodyText(), '此刻还没有文件内容').not.toContain('x');
    release!();
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(q('.preview-skeleton'), '首段落地后骨架被换掉').toBeNull();
  });

  it('★ 完整文件：5000 行（> 256 KiB）必须**全文**渲染，且不是降级文案', async () => {
    const lines = makeLines(5000);
    const expected = lines.join('\n') + '\n';
    expect(expected.length, '★ 样本必须**远**超过旧的 256 KiB 上限（否则变异抓不住，见 makeLines 注释）').toBeGreaterThan(600 * 1024);
    const srv = pagedServer(lines);
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    await waitFor(() => shownLines() === 5000, 'the stream to finish (5000 lines)');
    expect(q('.preview-degrade'), '★ 不许降级成「文件过大」').toBeNull();
    expect(shownLines(), '★ DOM 行数必须等于服务端 totalLines').toBe(5000);
    expect(shownText(), '★ 逐字节等于完整文件').toBe(expected);
    expect(srv.calls.length, '分段取（不止一次往返）').toBeGreaterThan(1);
    expect(srv.calls[0], '首段用**小** limit（首屏快）').toContain('limit=400');
    expect(srv.calls[1], '后续段用大 limit（往返少）').toContain('limit=1200');
  });

  /**
   * ★ 高亮生效的**结构**前提（计算样式由真机 CDP 断言，见报告）。
   *
   * 真 bug（用户原话「原地展开的文件还没有高亮」）：hljs 的颜色**全部**作用域限定在
   * `.rendered` 下（components.css 的 `.rendered .hljs-keyword { color: … }`）。
   * W1532 的内联块是 `el('div', 'wb-inline-content')` —— **没有** .rendered，
   * 于是 hljs 的 class 都加上了、颜色一条都不命中（类在、色不在）。
   * 本用例钉住「承载 renderPreview 输出的容器必须有 .rendered 祖先」这条不变量。
   */
  it('★ 高亮：内容容器有 .rendered 祖先，且 hljs 真的把 token 标出来了', async () => {
    // ★ 样本必须让**首段**就超过 hljs 的 32 KB 单块上限（utils/hljs.ts 的
    //   HL_MAX_BLOCK_CHARS）：否则「每段再切块」这一步没被考到，变异会假绿。
    //   500 行 × ≈150 字符 ⇒ 首段（400 行）≈ 60 KB，正是真机踩到的形态。
    const srv = pagedServer(makeLines(500));
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    const body = q('.preview-body');
    expect(body, '预览正文存在').not.toBeNull();
    expect(body!.classList.contains('rendered'), '★ 正文容器必须带 .rendered（hljs 颜色规则的作用域）').toBe(true);
    const kw = q('.preview-body .hljs-keyword');
    expect(kw, '★ 必须真的产出 .hljs-keyword 节点').not.toBeNull();
    expect(kw!.closest('.rendered'), '★ 该 token 必须在 .rendered 祖先之内').not.toBeNull();
    // 分段块同样要吃 .rendered 作用域（每段一个块，块自己不带 .rendered，靠祖先）。
    expect(q('.preview-body .preview-code .hljs-keyword')?.closest('.rendered'), '分段块里的 token 同样在 .rendered 内').not.toBeNull();
  });

  /**
   * ★ 分段块必须**再切**到 hljs 的单块上限（32 KB）以下 —— 真机第一次跑就是这样
   *   露的馅：首段 400 行 × ≈150 字符 ≈ 60 KB > 32 KB，utils/hljs.ts 的
   *   HL_MAX_BLOCK_CHARS 规则**整块跳过**高亮 ⇒ .hljs-keyword = 0 个。
   *   这条断言与上面那条是**两件事**：上面证明「容器作用域对」，这条证明
   *   「每块真的小到会被高亮」。去掉切块逻辑 ⇒ 这条立刻红（变异 5）。
   */
  it('★ 高亮不被单块上限吃掉：每个分段块的字符数必须 ≤ hljs 的 32 KB 门槛', async () => {
    const srv = pagedServer(makeLines(500));
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    await waitFor(() => doc.querySelectorAll('.preview-code code').length >= 3, 'the first segment to be split into blocks');
    const sizes = Array.from(doc.querySelectorAll('.preview-code code')).map((c) => (c.textContent ?? '').length);
    const biggest = Math.max(...sizes);
    expect(biggest, '★ 单块必须 ≤ 24 KB（给 hljs 的 32 KB 门槛留余量）').toBeLessThanOrEqual(24 * 1024);
    expect(sizes.filter((s) => s > 0).length, '确实切成了多块').toBeGreaterThan(1);
    expect(q('.preview-body .hljs-keyword'), '★ 切块之后必须真的高亮出来').not.toBeNull();
  });

  it('binary → 可读降级原因（不白屏）', async () => {
    const srv = pagedServer([], 'binary');
    const { wb } = await setup(srv.fetch);
    await clickFile(wb, 'big.ts');
    expect(bodyText()).toContain('二进制');
    expect(visibleInDom(q('.preview-body .preview-degrade'))).toBe(true);
  });

  it('读取失败（4xx）→ 可读降级原因', async () => {
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'big.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) return reply(400, { error: 'not a regular file' });
      return reply(200, { ok: true });
    });
    await clickFile(wb, 'big.ts');
    expect(bodyText().length, '降级原因不能为空').toBeGreaterThan(0);
    expect(visibleInDom(q('.preview-body .preview-degrade'))).toBe(true);
  });

  /**
   * W1545 **竞态守卫**：快速连点两个文件时，先点那个文件的**首段**可能后到。
   * 它绝不能被画进后点那个文件的预览里 —— 那正是「内容串了」这个 bug 的形态。
   * 这里把 A 的首段扣住，先让 B 落地，再放行 A。
   */
  it('竞态：先点文件的晚到段落不得覆盖后点文件的内容', async () => {
    const gate: Array<() => void> = [];
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        return reply(200, { path: p, parent: null, entries: [{ name: 'A.ts', type: 'file', size: 10, mtime: null }, { name: 'B.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
      }
      if (u.includes('/api/fs/read')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('A.ts')) {
          await new Promise<void>((res) => gate.push(res)); // 扣住 A
          return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-A\n', offset: 1, limit: 400, totalLines: 1, truncated: false });
        }
        return reply(200, { path: p, size: 10, kind: 'text', text: 'CONTENT-B\n', offset: 1, limit: 400, totalLines: 1, truncated: false });
      }
      return reply(200, { ok: true });
    });
    wb.openPanel('files', 'right');
    await flush();
    rowOf('A.ts')!.dispatchEvent(new Ev('click', { bubbles: true })); // 打开 A（首段被扣住）
    await flush();
    rowOf('B.ts')!.dispatchEvent(new Ev('click', { bubbles: true })); // 改点 B（立即返回）
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(bodyText(), 'B 的内容先落地').toContain('CONTENT-B');
    gate.forEach((res) => res()); // 放行 A 的晚到响应
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(bodyText(), '★ A 的晚到内容不得串进 B 的预览').toContain('CONTENT-B');
    expect(bodyText(), '★ A 的内容一个字都不许出现').not.toContain('CONTENT-A');
  });
});

/** 目录导航与「点文件」是两条路：进入目录**不得**读文件、不得开预览。 */
describe('文件管理器 · 点目录仍然进入目录（W1545）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('进入目录（不打开预览、不读文件）', async () => {
    const srv = pagedServer(['x']);
    const { wb } = await setup(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/fs/list')) {
        const p = decodeURIComponent(/[?&]path=([^&]*)/.exec(u)?.[1] ?? '');
        if (p.endsWith('/src')) return reply(200, { path: p, parent: '/src/celestea_studio-ts', entries: [{ name: 'main.ts', type: 'file', size: 10, mtime: null }], roots: [], truncated: false });
        return reply(200, { path: p, parent: null, entries: [{ name: 'src', type: 'dir', size: null, mtime: null }], roots: [], truncated: false });
      }
      return srv.fetch(url);
    });
    wb.openPanel('files', 'right');
    await flush();
    const dirRow = rows().find((r) => r.querySelector('.wb-name')?.textContent === 'src')!;
    dirRow.dispatchEvent(new Ev('click', { bubbles: true }));
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(q('.wb-crumb-cur')?.textContent).toBe('/src/celestea_studio-ts/src');
    expect(rows().map((r) => r.querySelector('.wb-name')?.textContent)).toEqual(['main.ts']);
    expect(srv.calls.length, '进入目录不得读文件').toBe(0);
  });
});
