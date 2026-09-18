// @vitest-environment jsdom
/**
 * W867（追加）· ①对话页圆角外框 · ②附件收纳展示夹（悬浮在输入框上方、不挤 #input 宽度）
 *
 * 现状：statusline / #messages / #statusbar / #inputbar 是通铺的直角区块；待发附件条是
 *   #inputbar 的普通子项（flex-wrap 换行、占满输入栏宽度）—— 附件一多就把输入区顶高/挤窄。
 * 本文件钉的是：
 *   · 结构真源（真实 index.html：四块同属一个 .chat-shell；展示夹挂在 .input-box 内）；
 *   · 行为真源（真实 ui/inputbar.ts 模块 + 真实渲染器：单行、单个移除、整体折叠）；
 *   · CSS 真源（展示夹 position:absolute 出流 + nowrap + 横向滚动；外框圆角走 --r-*）。
 * jsdom 无排版：像素级几何只能靠这些**必要条件** + 真机复验（见报告）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';

const css = (rel: string): string => readFileSync(join(WEB, 'src', 'styles', rel), 'utf8');
const indexHtml = (): string => readFileSync(join(WEB, 'index.html'), 'utf8');

/** 正则元字符转义（不用字符类里的 \$\{\} —— 模板字面量会把它们当插值）。 */
function escRe(s: string): string {
  const meta = '.*+?^$()[]{}|\\';
  return s
    .split('')
    .map((ch) => (meta.indexOf(ch) >= 0 ? '\\' + ch : ch))
    .join('');
}

/** 取某选择器**最后一条**规则体（后写的规则才生效）。 */
function rule(text: string, selector: string): string {
  const all = [...text.matchAll(new RegExp(escRe(selector) + '\\s*\\{([^}]*)\\}', 'g'))];
  expect(all.length, '找不到规则：' + selector).toBeGreaterThan(0);
  return all[all.length - 1]?.[1] ?? '';
}

interface FileLike {
  name: string;
  type: string;
  size: number;
  slice(): { arrayBuffer(): Promise<ArrayBuffer> };
}
interface PendingLike {
  file: unknown;
  name: string;
  url: string;
  bytes: number;
  id: string;
  error: string;
}
interface AttachmentMod {
  restorePending(key: string, items: readonly unknown[]): void;
  pendingList(): PendingLike[];
}
interface InputBarMod {
  initInputBar(h: { send(t: string, m: string): void; cancel(): void }): void;
  refreshAttachmentTray(): void;
  refreshAttachmentEntry(): void;
}

function fakeFile(name: string, type: string, size = 2048): FileLike {
  return { name, type, size, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) };
}

const tray = (): ElLike | null => doc.querySelector('.attach-tray');
const trayItems = (): ElLike[] => Array.from(doc.querySelectorAll('.attach-tray .attach-item')) as ElLike[];
const foldBtn = (): ElLike | null => doc.querySelector('.attach-tray .attach-mode');

/** 用**真实 index.html 的 <body>** 当夹具（#inputbar / .input-box / #input 与线上同构）。 */
function useRealBody(): void {
  const raw = indexHtml();
  doc.body.innerHTML = raw.slice(raw.indexOf('<body>') + 6, raw.indexOf('</body>'));
}

/** 走真实模块：initInputBar 装配 → 附件状态走 attachments.ts 的会话草稿。 */
async function bootBar(): Promise<{ bar: InputBarMod; att: AttachmentMod }> {
  useRealBody();
  const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as InputBarMod;
  bar.initInputBar({ send: () => {}, cancel: () => {} });
  const att = (await import(/* @vite-ignore */ at('ui/attachments.ts'))) as AttachmentMod;
  return { bar, att };
}

function item(name: string, url: string, error = ''): PendingLike {
  return { file: fakeFile(name, 'image/png'), name, url: url === '' ? '' : 'blob:' + url, bytes: 2048, id: 'id-' + name, error };
}

function seedPending(att: AttachmentMod, items: PendingLike[]): void {
  att.restorePending('', items as unknown[]);
}

describe('W867（追加）· ①对话页圆角外框（.chat-shell）', () => {
  beforeEach(() => {
    resetHarness();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  // W871 修正：用户澄清「我说的是 statusline 和下面的会话发送栏是一体圆角，你直接给
  //   整个会话页圆角了」⇒ 外框只圈底部那一条，#messages 必须留在框**外**（保持贴屏幕
  //   边缘、保持唯一滚动容器 .sess-pane 的几何）。W871 新增的 tests/w871-shell-anchor-dom
  //   .test.ts 用真实浏览器量到的 rect 数字把这条钉死。
  it('真实 index.html：.chat-shell 只圈发送栏三条（statusline/状态栏/输入栏）；#messages 在框外', () => {
    const raw = indexHtml();
    doc.body.innerHTML = raw.slice(raw.indexOf('<body>') + 6, raw.indexOf('</body>'));
    const shell = doc.querySelector('.chat-shell');
    expect(shell, '#main 里必须有 .chat-shell').not.toBeNull();
    expect(shell?.closest('#main'), '外框不得跑出 #main').not.toBeNull();
    for (const sel of ['#statusline', '#statusbar', '#inputbar']) {
      const node = doc.querySelector(sel);
      expect(node, sel + ' 必须在').not.toBeNull();
      expect(node?.closest('.chat-shell'), sel + ' 必须收进同一个圆角外框').not.toBeNull();
    }
    const msgs = doc.querySelector('#messages');
    expect(msgs, '#messages 必须在').not.toBeNull();
    expect(msgs?.closest('.chat-shell'), '#messages 必须留在圆角外框**之外**（消息区不圆角）').toBeNull();
    // 外框的**全部**子元素就是这三条（父子关系，不是「class 存在」）
    const kids = shell === null ? [] : (Array.from(shell.querySelectorAll(':scope > *')) as ElLike[]);
    expect(kids.map((c) => c.id)).toEqual(['statusline', 'statusbar', 'inputbar']);
    expect(shell?.parentElement?.id).toBe('main');
    // 滚动容器语义不变：.sess-pane 仍是唯一的 overflow-y:auto；外框既不滚也不裁
    expect(rule(css('views.css'), '.sess-pane')).toContain('overflow-y: auto');
    expect(rule(css('layout.css'), '.chat-shell')).not.toContain('overflow-y: auto');
    expect(rule(css('layout.css'), '.chat-shell'), '外框不得 overlay:hidden（会切掉向上弹的 .sl-popup）').not.toContain('overflow: hidden');
  });

  it('外框：圆角走 --r-*、发丝线、同一表面色；窄屏有降级', () => {
    const shell = rule(css('layout.css'), '.chat-shell');
    // W871：圆角经本层自定义属性 --r-shell（= --r-lg）同时给外框与首/末子元素，
    // 窄屏在 responsive.css 里改 --r-md 时两边同步（子元素若不是同刻度会露出角差）。
    expect(shell).toContain('border-radius: var(--r-shell)');
    expect(shell, '--r-shell 的刻度真源仍是 --r-lg').toContain('--r-shell: var(--r-lg)');
    expect(rule(css('layout.css'), '.chat-shell > :first-child')).toContain('border-top-left-radius: var(--r-shell)');
    expect(rule(css('layout.css'), '.chat-shell > :last-child')).toContain('border-bottom-left-radius: var(--r-shell)');
    expect(shell).toContain('border: var(--hairline) solid var(--border-l1)');
    expect(shell).toContain('background: var(--bg-layer-1)');
    expect(shell, '外框不参与滚动（滚动仍是 .sess-pane）').not.toContain('overflow-y');
    const resp = css('responsive.css');
    expect(resp, 'tablet 档收边距').toMatch(/\.chat-shell\s*\{\s*margin:\s*4px;\s*\}/);
    expect(resp, 'mobile 档再收一档并降圆角').toMatch(/\.chat-shell\s*\{[^}]*margin:\s*2px[^}]*border-radius:\s*var\(--r-md\)/);
    for (const f of ['layout.css', 'responsive.css', 'attachments.css']) {
      expect(css(f), f + ' 不得出现虚线').not.toMatch(/\b(dashed|dotted)\b/);
    }
  });
});

describe('W867（追加）· ②附件收纳展示夹（悬浮、不挤输入框）', () => {
  beforeEach(() => {
    resetHarness();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('展示夹挂在 .input-box 内且出流：#inputbar 的直接子节点不变（不抢 #input 的 flex 槽位）', async () => {
    const { bar } = await bootBar();
    const t = tray();
    expect(t, '展示夹必须建出来').not.toBeNull();
    expect(t?.parentElement?.className, '定位基准 = .input-box').toContain('input-box');
    const barKids = Array.from(doc.querySelectorAll('#inputbar > *')).map((c) => c.className);
    // 既有出流子项：.attach-note（提示）与 .attach-file（隐藏 <input type=file>）—— 两者都在
    // 本次改动之前就存在、都不占宽度分配；关键是**展示夹本身不在里面**。
    expect(barKids, '#inputbar 的直接子项不含展示夹').toEqual([
      'attach-note hidden',
      'input-box',
      'input-side',
      'attach-file hidden',
    ]);
    expect(doc.querySelector('#inputbar > .attach-tray'), '展示夹**不得**是 #inputbar 的直接子项（否则参与宽度分配）').toBeNull();
    const trayCss = rule(css('attachments.css'), '.attach-tray');
    expect(trayCss, '出流 = 绝对定位（不参与 #inputbar 的宽度分配）').toContain('position: absolute');
    expect(trayCss, '单行 + 横向滚动（多行会盖住输入区）').toContain('flex-wrap: nowrap');
    expect(trayCss).toContain('overflow-x: auto');
    expect(trayCss, '贴住输入框上沿：由 ui/inputbar.ts 量出的 --tray-h 决定').toContain('bottom: var(--tray-h');
    bar.refreshAttachmentTray(); // 空态：仍然是隐藏的，不占位
    expect(tray()?.classList.contains('hidden')).toBe(true);
  });

  it('一条附件一条目、可单个移除；清空后整条隐藏', async () => {
    const { bar, att } = await bootBar();
    seedPending(att, [item('a.png', 'a'), item('b.png', 'b')]);
    bar.refreshAttachmentTray();
    expect(tray()?.classList.contains('hidden')).toBe(false);
    expect(trayItems().length).toBe(2);
    const remove = trayItems()[0]?.querySelector('.attach-remove');
    expect(remove, '每条都有自己的移除键').not.toBeNull();
    remove?.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(trayItems().length, '单个移除不影响其它条目').toBe(1);
    expect(att.pendingList().length).toBe(1);
    const remove2 = trayItems()[0]?.querySelector('.attach-remove');
    remove2?.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(trayItems().length).toBe(0);
    expect(tray()?.classList.contains('hidden'), '清空后整条隐藏').toBe(true);
  });

  it('整体折叠：折叠后只剩折叠键（缩略图由 CSS 隐藏），再点展开（aria 同步）', async () => {
    const { bar, att } = await bootBar();
    seedPending(att, [item('a.png', 'a')]);
    bar.refreshAttachmentTray();
    const first = foldBtn();
    expect(first, '折叠键常显').not.toBeNull();
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    expect(first?.textContent).toContain('附件 1');
    first?.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(tray()?.classList.contains('collapsed'), '折叠态落在条带容器上（CSS 负责隐藏缩略图）').toBe(true);
    expect(foldBtn()?.getAttribute('aria-expanded')).toBe('false');
    expect(trayItems().length, '折叠不销毁条目（展开即见）').toBe(1);
    expect(
      /\.attach-tray\.collapsed\s+\.attach-item:not\(\.attach-mode\)\s*\{\s*display:\s*none/.test(css('attachments.css')),
      '折叠 = CSS 隐藏缩略图',
    ).toBe(true);
    foldBtn()?.dispatchEvent(new Ev('click', { bubbles: true }));
    expect(tray()?.classList.contains('collapsed')).toBe(false);
    expect(foldBtn()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('非图片附件不假设有图：无预览地址的条目退化成通用图标（文件名首字）', async () => {
    const { bar, att } = await bootBar();
    seedPending(att, [item('note.md', '', '仅支持图片'), item('报告.pdf', '')]);
    bar.refreshAttachmentTray();
    const marks = trayItems().map((n) => n.querySelector('.attach-thumb-meta')?.textContent ?? '');
    expect(marks, '文本附件的兜底图标 = 文件名首字（不是写死的「图」）').toEqual(['N', '报']);
    expect(trayItems().every((n) => n.querySelector('img.attach-thumb') === null), '不假装有图').toBe(true);
  });

  it('输入框长高后展示夹重新贴位（--tray-h 跟随 .input-box 实测高度）', async () => {
    const { bar, att } = await bootBar();
    seedPending(att, [item('a.png', 'a')]);
    const box = doc.querySelector('.input-box') as ElLike;
    const trayH = (): string =>
      (tray()?.style as unknown as { getPropertyValue(p: string): string })?.getPropertyValue('--tray-h') ?? '';
    (box as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect = () => ({ height: 132 });
    bar.refreshAttachmentTray();
    expect(trayH(), '输入框长高 → 展示夹跟着抬高').toBe('132px');
    (box as unknown as { getBoundingClientRect(): { height: number } }).getBoundingClientRect = () => ({ height: 52 });
    bar.refreshAttachmentTray();
    expect(trayH(), '输入框缩回 → 展示夹跟着贴回').toBe('52px');
  });
});
