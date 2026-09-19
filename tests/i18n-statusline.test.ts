// @vitest-environment jsdom
// i18n P1-a · statusline 域：语言切换后该域文案变化 + zh/en key 一致。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './lib/w795-dom.js';

interface I18nMod {
  t(key: string, params?: Record<string, string | number>): string;
  setLocale(l: string): void;
  localeDict(l: string): Record<string, string>;
}
interface TpsMod {
  createTpsSamples(capacity?: number): { values: readonly number[]; capacity: number };
  pushTpsSamples(s: unknown, v: unknown): unknown;
  tpsDisplay(s: unknown, current: unknown, busy: boolean, format: (v: number) => string): { text: string; title: string };
}

const load = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
const loadTps = async (): Promise<TpsMod> => (await import(/* @vite-ignore */ at('statusline/tps.ts'))) as TpsMod;

describe('i18n P1-a · statusline 域', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('切换语言后 statusline 域文案变化（同一 key 中英不同）', async () => {
    const m = await load();
    m.setLocale('zh');
    expect(m.t('statusline.switched')).toBe('已切换');
    expect(m.t('statusline.tooltip')).toContain('上下文占用');
    m.setLocale('en');
    expect(m.t('statusline.switched')).toBe('Switched');
    expect(m.t('statusline.tooltip')).toContain('Context usage');
  });

  it('真实 statusline 纯函数（tpsDisplay）随语言切换文案', async () => {
    const m = await load();
    const tps = await loadTps();
    const s = tps.pushTpsSamples(tps.createTpsSamples(), 42.5);
    m.setLocale('zh');
    const zh = tps.tpsDisplay(s, undefined, false, (v) => v.toFixed(1));
    expect(zh.title).toContain('会话当前未运行');
    expect(zh.title).toContain('次采样的均值');
    m.setLocale('en');
    const en = tps.tpsDisplay(s, undefined, false, (v) => v.toFixed(1));
    expect(en.title).toContain('The session is not running');
    expect(en.title).toContain('samples');
    expect(zh.title).not.toBe(en.title);
  });

  it('zh/en key 集合一致（含 statusline 域新增 key）', async () => {
    const m = await load();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('statusline.'))).toContain('statusline.switched');
  });
});
