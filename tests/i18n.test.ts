// @vitest-environment jsdom
/**
 * i18n P0 内核测试：插值、回落、语言检测、切换；zh/en key 集合一致；
 * api.ts 域双语；语言切换只通知订阅者、不重建会话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

interface I18nMod {
  t(key: string, params?: Record<string, string | number>): string;
  getLocale(): string;
  setLocale(l: string): void;
  onLocaleChange(cb: () => void): () => void;
  detectLocale(): string;
  allKeys(): string[];
  localeDict(l: string): Record<string, string>;
  localeLabel(l: string): string;
}
interface SettingsMod { languageField(): ElLike; languageFieldMounted(): boolean }

const load = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
const loadSettings = async (): Promise<SettingsMod> => (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as SettingsMod;

describe('i18n P0', () => {
  beforeEach(() => { resetHarness(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('zh / en 的 key 集合完全一致（漏译即红）', async () => {
    const m = await load();
    const zhKeys = Object.keys(m.localeDict('zh')).sort();
    const enKeys = Object.keys(m.localeDict('en')).sort();
    expect(enKeys, '英文必须覆盖全部中文 key').toEqual(zhKeys);
    expect(zhKeys.length, 'P0 字典 key 数').toBeGreaterThan(8);
    expect(m.allKeys().sort()).toEqual(zhKeys);
  });

  it('插值只支持 {name}（中英都插）', async () => {
    const m = await load();
    m.setLocale('zh');
    expect(m.t('common.language.changed', { name: 'English' })).toBe('界面语言已切换为 English');
    m.setLocale('en');
    expect(m.t('common.language.changed', { name: '中文' })).toBe('Interface language switched to 中文');
  });

  it('api.ts 域双语：同一 key 中英不同且各自正确', async () => {
    const m = await load();
    m.setLocale('zh');
    const zh = m.t('api.error.connect');
    const zhForbidden = m.t('api.error.forbidden');
    m.setLocale('en');
    const en = m.t('api.error.connect');
    const enForbidden = m.t('api.error.forbidden');
    expect(zh).toContain('无法连接');
    expect(zhForbidden).toContain('没有权限');
    expect(en).toMatch(/Cannot reach/);
    expect(enForbidden).toMatch(/permission/);
    expect(zh).not.toBe(en);
  });

  it('语言检测：localStorage 优先 → navigator（zh* 中文，否则英文）→ 默认中文', async () => {
    const m = await load();
    localStorage.setItem('celestea-locale', 'en');
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    expect(m.detectLocale()).toBe('en');
    localStorage.clear();
    vi.stubGlobal('navigator', { language: 'zh-TW' });
    expect(m.detectLocale()).toBe('zh');
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(m.detectLocale()).toBe('en');
    vi.stubGlobal('navigator', { language: '' });
    expect(m.detectLocale()).toBe('zh');
  });

  it('切换语言：通知订阅者、持久化、getLocale 更新', async () => {
    const m = await load();
    let fired = 0;
    const off = m.onLocaleChange(() => { fired += 1; });
    m.setLocale('zh');
    expect(m.getLocale()).toBe('zh');
    const base = fired; // 初始语言可能是 en，先归一到已知状态再计增量
    m.setLocale('en');
    expect(m.getLocale()).toBe('en');
    expect(fired).toBe(base + 1);
    expect(localStorage.getItem('celestea-locale')).toBe('en');
    m.setLocale('en'); // 同值不重复通知
    expect(fired).toBe(base + 1);
    off();
  });

  it('语言字段：渲染 select 且切换后只重画自身文案（不重建背景）', async () => {
    const m = await load();
    const s = await loadSettings();
    m.setLocale('zh');
    const host = doc.createElement('div') as unknown as ElLike;
    doc.body.appendChild(host);
    const marker = doc.createElement('div') as unknown as ElLike;
    marker.className = 'bg-marker';
    host.appendChild(marker);
    host.appendChild(s.languageField());
    expect(s.languageFieldMounted()).toBe(true);
    const select = host.querySelector('select') as ElLike;
    expect(select.value).toBe('zh');
    expect((host.querySelector('.cfg-label') as ElLike).textContent).toBe('语言');
    select.value = 'en';
    select.dispatchEvent(new Ev('change', { bubbles: true }));
    expect(m.getLocale()).toBe('en');
    expect((host.querySelector('.cfg-label') as ElLike).textContent).toBe('Language');
    expect(host.querySelector('.bg-marker'), '只重画文案节点，背景节点身份不变').toBe(marker);
  });
});
