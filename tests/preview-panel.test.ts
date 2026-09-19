// @vitest-environment jsdom
/**
 * F2 文件侧边预览 · DOM：打开不重建背景、竞态丢弃（seq 守卫）、Esc 只关栈顶一层、
 * 降级可读原因 + 两个动作键（复制路径 / 在文件管理器中打开）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, resetHarness, type ElLike } from './lib/w795-dom.js';

interface Candidate { path: string; kind: string; source: string }
interface PanelMod {
  openPreview(req: { candidate: Candidate; load?: () => Promise<string | null>; url?: string | null }): void;
  closePreview(): void;
  previewIsOpen(): boolean;
}
interface OverlaysMod {
  pushOverlay(close: () => void): { id: number; depth: number };
  popOverlay(h?: { id: number; depth: number }): void;
  overlayDepth(): number;
}

const loadPanel = async (): Promise<PanelMod> =>
  (await import(/* @vite-ignore */ at('ui/preview/panel.ts'))) as PanelMod;
const loadOverlays = async (): Promise<OverlaysMod> =>
  (await import(/* @vite-ignore */ at('utils/overlays.ts'))) as OverlaysMod;
const cand = (path: string, kind = 'code'): Candidate => ({ path, kind, source: 'tool' });
const bodyText = (): string => doc.querySelector('.preview-body')?.textContent ?? '';
const actionLabels = (): string[] => Array.from(doc.querySelectorAll('.preview-action')).map((b) => b.textContent ?? '');
const dispatch = (e: unknown): boolean => (doc as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(e);
function pressEscape(): void {
  const ev = new Ev('keydown');
  Object.defineProperty(ev, 'key', { value: 'Escape' });
  dispatch(ev);
}

describe('F2 · 文件侧边预览（DOM）', () => {
  beforeEach(() => { resetHarness(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('打开 code 预览：内容渲染，且不重建背景（#messages 节点身份不变）', async () => {
    const panel = await loadPanel();
    const msgs = doc.getElementById('messages') as ElLike;
    const marker = doc.createElement('div') as unknown as ElLike;
    marker.className = 'bg-marker';
    msgs.appendChild(marker);
    panel.openPreview({ candidate: cand('/a/b.ts'), load: async () => 'const x = 1;' });
    await flush();
    expect(panel.previewIsOpen()).toBe(true);
    expect(doc.querySelector('.preview-code')?.textContent).toContain('const x = 1;');
    expect(msgs.querySelector('.bg-marker')).toBe(marker);
    expect(doc.querySelectorAll('#messages .preview-host').length).toBe(0);
  });

  it('竞态：晚到的旧加载结果被丢弃（seq 守卫）', async () => {
    const panel = await loadPanel();
    let releaseA: (v: string | null) => void = () => {};
    panel.openPreview({ candidate: cand('/a/a.ts'), load: () => new Promise((r) => { releaseA = r; }) });
    panel.openPreview({ candidate: cand('/a/b.ts'), load: async () => 'B 的内容' });
    await flush();
    releaseA('A 的内容');
    await flush();
    expect(bodyText()).toContain('B 的内容');
    expect(bodyText()).not.toContain('A 的内容');
  });

  it('Esc 只关栈顶一层：先关后开的那层，再关面板', async () => {
    const panel = await loadPanel();
    const overlays = await loadOverlays();
    panel.openPreview({ candidate: cand('/a/b.ts'), load: async () => 'x' });
    await flush();
    let secondClosed = false;
    overlays.pushOverlay(() => { secondClosed = true; });
    expect(overlays.overlayDepth()).toBe(2);
    pressEscape();
    expect(secondClosed).toBe(true);
    expect(panel.previewIsOpen()).toBe(true);
    pressEscape();
    expect(panel.previewIsOpen()).toBe(false);
  });

  it('降级：内容不在会话里 → 可读原因 + 复制路径 + 在文件管理器中打开', async () => {
    const panel = await loadPanel();
    panel.openPreview({ candidate: cand('/a/x.xyz', 'unknown'), load: async () => null });
    await flush();
    expect(bodyText()).toContain('不在本次会话里');
    expect(actionLabels()).toContain('复制路径');
    expect(actionLabels()).toContain('在文件管理器中打开');
  });

  it('降级：二进制内容 → 可读原因', async () => {
    const panel = await loadPanel();
    panel.openPreview({ candidate: cand('/a/bin.dat', 'unknown'), load: async () => 'a\u0000b' });
    await flush();
    expect(bodyText()).toContain('二进制');
  });
});
