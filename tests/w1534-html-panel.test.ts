// @vitest-environment jsdom
/**
 * W1534 · HTML 预览 —— 面板行为（真实 openPreview 路径）。
 *
 * 守四件事：
 *   ① 切换控件**常驻可见**（不是 hover 才显形）：html 内容就绪后 .preview-modes
 *      不带 .hidden，且两个按钮都带 aria-pressed（选中态靠它，不靠 opacity）；
 *   ② 默认进**预览**（iframe 在），点「源码」后 iframe 仍在 DOM（不重建）但被
 *      visibility 隐藏、源码视图显示（★ 不能是 display:none，真机实测会丢 iframe 滚动位）；
 *   ③ 来回切换**不重新加载**：同一份内容、同一个 iframe 节点（身份不变）；
 *   ④ 非 html 类型**不显示**切换控件（不给不存在的选择）。
 *
 * 几何（非零尺寸 / 与代码文字不相交）由真机 CDP 断言，见 results/W1534-html-preview.md。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, flush, resetHarness, type ElLike } from './lib/w795-dom.js';

interface PanelMod {
  openPreview(req: unknown): void;
  closePreview(): void;
  previewIsOpen(): boolean;
  previewView(): string;
}
const loadPanel = async (): Promise<PanelMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PanelMod;
const cand = (path: string, kind = 'html'): unknown => ({ path, kind, source: 'label' });
const q = (s: string): ElLike | null => doc.querySelector(s) as unknown as ElLike | null;
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s)) as unknown as ElLike[];

const HTML_DOC = '<!doctype html><html><head><title>t</title></head><body><p id="p">hi &amp; bye</p></body></html>';
const MODE_LABELS = ['预览', '源码'];

/** 点一个按钮（派发真实 click）。 */
function click(n: ElLike | null): void {
  if (n === null) throw new Error('click(): target missing');
  n.dispatchEvent(new (globalThis as unknown as { Event: new (t: string) => unknown }).Event('click'));
}
/** 按可见文本找切换按钮。 */
function modeBtn(label: string): ElLike | null {
  return qa('.preview-mode').find((b) => (b.textContent ?? '').trim() === label) ?? null;
}
/** 打开一个 html 预览并等它画完。 */
async function openHtml(text: string = HTML_DOC, path = '/a/index.html'): Promise<void> {
  const p = await loadPanel();
  p.openPreview({ candidate: cand(path), loadFull: async () => ({ text }) });
  await flush(30);
}

beforeEach(() => { resetHarness(); });
afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

describe('W1534 · HTML 预览面板：切换控件', () => {
  it('html 内容就绪后切换控件**可见**（不带 .hidden），且两个按钮都常显', async () => {
    await openHtml();
    const modes = q('.preview-modes');
    expect(modes, '切换控件必须存在').not.toBeNull();
    expect(modes!.classList.contains('hidden'), '控件必须常驻可见（不是 hover 才显形）').toBe(false);
    const btns = qa('.preview-mode');
    expect(btns.map((b) => (b.textContent ?? '').trim())).toEqual(MODE_LABELS);
    // 选中态靠 aria-pressed，**不靠** opacity（W1526 的教训：opacity:0 的控件点不到）。
    for (const b of btns) expect(b.getAttribute('aria-pressed')).not.toBeNull();
    expect(q('.preview-mode[aria-pressed="true"]')?.textContent?.trim(), '默认选中「预览」').toBe('预览');
  });

  it('默认进预览：iframe 在、源码视图在但被隐藏（visibility，不是 display:none）', async () => {
    await openHtml();
    const body = q('.preview-body');
    expect(body!.classList.contains('is-dual'), '双视图模式').toBe(true);
    const frame = q('.preview-html-frame');
    expect(frame, '默认必须渲染出 iframe').not.toBeNull();
    const code = q('.preview-code');
    expect(code, '源码视图也必须同时在 DOM 里（切换不重建）').not.toBeNull();
    expect(frame!.closest('.view-off'), '默认 iframe 是显示的那个').toBeNull();
    expect(code!.closest('.view-off'), '默认源码视图被隐藏').not.toBeNull();
  });

  it('点「源码」：源码视图转为显示、iframe 转为隐藏，且 iframe 节点身份不变（不重建）', async () => {
    await openHtml();
    const p = await loadPanel();
    const frameBefore = q('.preview-html-frame');
    click(modeBtn('源码'));
    await flush(10);
    expect(p.previewView()).toBe('source');
    expect(q('.preview-mode[aria-pressed="true"]')?.textContent?.trim()).toBe('源码');
    const frameAfter = q('.preview-html-frame');
    expect(frameAfter, '★ iframe 必须还在（重建会丢滚动位 + 闪白）').not.toBeNull();
    expect(frameAfter, '★ 同一个节点（身份不变 ⇒ 文档没被重新加载）').toBe(frameBefore);
    expect(q('.preview-code')!.closest('.view-off'), '源码视图现在是显示的那个').toBeNull();
    expect(q('.preview-html')!.closest('.view-off'), 'iframe 容器转为隐藏').not.toBeNull();
    expect(q('.preview-code')!.textContent).toContain('hi &amp; bye');
  });

  it('切回「预览」：iframe 仍是同一个节点（内容没重新加载），且预览重新显示', async () => {
    await openHtml();
    const frameBefore = q('.preview-html-frame');
    click(modeBtn('源码'));
    await flush(10);
    click(modeBtn('预览'));
    await flush(10);
    expect((await loadPanel()).previewView()).toBe('preview');
    expect(q('.preview-html-frame')).toBe(frameBefore);
    expect(q('.preview-html')!.closest('.view-off')).toBeNull();
  });

  it('切换控件**不覆盖**代码文字：控件住 .preview-head，正文住 .preview-body（结构上不相交）', async () => {
    await openHtml();
    const modes = q('.preview-modes');
    // 控件是 .preview-head 的后代；正文容器是 .preview-head 的**兄弟**。
    // ⇒ 两者是上下相邻的两个块，轴对齐矩形不可能相交（W1526 判定法）。
    expect(modes!.closest('.preview-head'), '控件必须在头部行内').not.toBeNull();
    expect(modes!.closest('.preview-body'), '控件绝不能住正文里（那就是浮层挡字）').toBeNull();
    expect(q('.preview-body')!.closest('.preview-head'), '正文不在头部里').toBeNull();
  });

  it('非 html 类型不显示切换控件（不给不存在的选择）', async () => {
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/b.ts', 'code'), loadFull: async () => ({ text: 'const x = 1;' }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), 'code 文件没有两种看法 ⇒ 控件隐藏').toBe(true);
    expect(q('.preview-html-frame'), 'code 文件不该有 iframe').toBeNull();
  });

  it('打开另一个文件时控件先隐藏，内容就绪后再按新类型决定（不残留上一个文件的控件）', async () => {
    await openHtml();
    expect(q('.preview-modes')!.classList.contains('hidden')).toBe(false);
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/note.md', 'markdown'), loadFull: async () => ({ text: '# T' }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), 'markdown 没有双视图').toBe(true);
    expect(q('.preview-html-frame')).toBeNull();
  });

  it('降级态（内容不在会话里）不显示切换控件，也不产出 iframe', async () => {
    const p = await loadPanel();
    p.openPreview({ candidate: cand('/a/x.html'), loadFull: async () => ({ text: null }) });
    await flush(30);
    expect(q('.preview-modes')!.classList.contains('hidden'), '没有内容就没有两种看法').toBe(true);
    expect(q('.preview-html-frame')).toBeNull();
  });

  it('关闭面板后重开：回到默认「预览」视图（不把上次的选择带过来）', async () => {
    await openHtml();
    const p = await loadPanel();
    click(modeBtn('源码'));
    await flush(10);
    expect(p.previewView()).toBe('source');
    p.closePreview();
    await flush(5);
    await openHtml();
    expect(p.previewView(), '重开必须回到默认预览').toBe('preview');
    expect(q('.preview-mode[aria-pressed="true"]')?.textContent?.trim()).toBe('预览');
  });

  it('点当前已选中的按钮不重复触发（幂等；避免无谓重画）', async () => {
    await openHtml();
    const frameBefore = q('.preview-html-frame');
    click(modeBtn('预览')); // 已经是「预览」
    await flush(10);
    expect(q('.preview-html-frame'), '重复点当前项不得重画').toBe(frameBefore);
  });
});
