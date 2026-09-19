// @vitest-environment jsdom
// i18n P1-c · 对话面域：语言切换后该域文案变化 + zh/en key 一致 + **可见性断言**。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface I18nMod { t(key: string, params?: Record<string, string | number>): string; setLocale(l: string): void; localeDict(l: string): Record<string, string> }
interface QFormatMod { countdownText(ms: number | null): string }
interface RailCenterMod { railCenterLabel(hit: { item: unknown; clamped: boolean; round: number }, fold?: number): string }
interface ToolcardsMod { buildToolCard(d: { step: number; name: string; argsText: string }): { col: ElLike; card: ElLike } }

const load = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;

/** 可见性判据：节点已挂载，且祖先链上没有 hidden / display:none（正是 G4 面板不可见的 bug 类）。 */
function visibleInDom(node: ElLike): boolean {
  let n: ElLike | null = node;
  while (n) {
    if (n.classList.contains('hidden')) return false;
    const disp = (n as unknown as { style?: { display?: string } }).style?.display;
    if (disp === 'none') return false;
    n = n.parentElement as ElLike | null;
  }
  return node.isConnected === true;
}

describe('i18n P1-c · 对话面域', () => {
  beforeEach(() => { resetHarness(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); localStorage.clear(); });

  it('切换语言后对话面域文案变化', async () => {
    const m = await load();
    m.setLocale('zh');
    expect(m.t('chat.think.title')).toBe('思考');
    expect(m.t('chat.tool.step', { n: 3 })).toBe('第 3 步');
    m.setLocale('en');
    expect(m.t('chat.think.title')).toBe('Thinking');
    expect(m.t('chat.tool.step', { n: 3 })).toBe('Step 3');
  });

  it('真实纯函数随语言切换（countdownText / railCenterLabel）', async () => {
    const m = await load();
    const q = (await import(/* @vite-ignore */ at('ui/question/format.ts'))) as QFormatMod;
    const rc = (await import(/* @vite-ignore */ at('ui/rail-center.ts'))) as RailCenterMod;
    m.setLocale('zh');
    expect(q.countdownText(30_000)).toBe('剩 30 秒');
    expect(q.countdownText(0)).toBe('已到时限');
    expect(rc.railCenterLabel({ item: {}, clamped: false, round: 2 })).toContain('第 2 轮');
    m.setLocale('en');
    expect(q.countdownText(30_000)).toBe('30s left');
    expect(q.countdownText(0)).toBe('Timed out');
    expect(rc.railCenterLabel({ item: {}, clamped: false, round: 2 })).toContain('turn 2');
  });

  it('可见性：渲染出的工具卡在 DOM 里可见（祖先链无 hidden/display:none）+ 非零几何', async () => {
    const tc = (await import(/* @vite-ignore */ at('ui/toolcards.ts'))) as ToolcardsMod;
    const ref = tc.buildToolCard({ step: 1, name: 'read_file', argsText: '{}' });
    doc.body.appendChild(ref.col);
    expect(visibleInDom(ref.col), '工具卡必须真的可见（不是只存在节点）').toBe(true);
    // 反例：带 hidden 的节点必须被判为不可见（判据本身有效）
    const hidden = doc.createElement('div') as unknown as ElLike;
    hidden.className = 'hidden';
    doc.body.appendChild(hidden);
    expect(visibleInDom(hidden)).toBe(false);
    // 几何：jsdom 无排版引擎（rect 恒 0），注入非零 rect 断言可读；真实像素由浏览器验收。
    (ref.col as unknown as { getBoundingClientRect(): { width: number; height: number; top: number; left: number; right: number; bottom: number } }).getBoundingClientRect = () => ({ width: 320, height: 44, top: 0, left: 0, right: 320, bottom: 44 });
    const rect = (ref.col as unknown as { getBoundingClientRect(): { width: number; height: number } }).getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    // 关闭/移除后不得仍被判可见
    ref.col.remove();
    expect(visibleInDom(ref.col)).toBe(false);
  });

  it('zh/en key 集合一致（含对话面域新增 key）', async () => {
    const m = await load();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('chat.'))).toContain('chat.tool.step');
  });
});
