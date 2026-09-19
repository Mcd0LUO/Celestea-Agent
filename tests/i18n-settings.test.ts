// @vitest-environment jsdom
// i18n P1-b · 设置页域：语言切换后该域文案变化 + zh/en key 一致。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './lib/w795-dom.js';

interface I18nMod { t(key: string, params?: Record<string, string | number>): string; setLocale(l: string): void; localeDict(l: string): Record<string, string> }
interface CopyMod { toolDenyLabel(name: string): string }
interface BatchMod { batchFailureText(verb: string, resp: unknown): string }

const load = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;

describe('i18n P1-b · 设置页域', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('切换语言后设置页域文案变化', async () => {
    const m = await load();
    m.setLocale('zh');
    expect(m.t('settings.action.save')).toBe('保存');
    expect(m.t('settings.providers.defaultApplied')).toBe('已切换默认模型');
    m.setLocale('en');
    expect(m.t('settings.action.save')).toBe('Save');
    expect(m.t('settings.providers.defaultApplied')).toBe('Default model switched');
  });

  it('真实设置页纯函数随语言切换（toolDenyLabel / batchFailureText）', async () => {
    const m = await load();
    const copy = (await import(/* @vite-ignore */ at('ui/permissions/copy.ts'))) as CopyMod;
    const batch = (await import(/* @vite-ignore */ at('ui/batchresult.ts'))) as BatchMod;
    m.setLocale('zh');
    expect(copy.toolDenyLabel('write_file')).toBe('禁写文件');
    const zh = batch.batchFailureText(m.t('settings.action.delete'), { ok: true, deleted: 1, failed: [{ id: 'ws/a', error: 'unknown session' }] });
    expect(zh).toContain('删除失败');
    expect(zh).toContain('该会话已不存在');
    m.setLocale('en');
    expect(copy.toolDenyLabel('write_file')).toBe('File writes disabled');
    const en = batch.batchFailureText(m.t('settings.action.delete'), { ok: true, deleted: 1, failed: [{ id: 'ws/a', error: 'unknown session' }] });
    expect(en).toContain('Delete failed');
    expect(en).toContain('no longer exists');
    expect(zh).not.toBe(en);
  });

  it('zh/en key 集合一致（含设置页域新增 key）', async () => {
    const m = await load();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('settings.'))).toContain('settings.providers.defaultApplied');
  });
});
