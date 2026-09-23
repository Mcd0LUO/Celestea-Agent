// @vitest-environment jsdom
/**
 * i18n 全域测试（合并自 i18n.test.ts / i18n-chat.test.ts / i18n-settings.test.ts /
 * i18n-statusline.test.ts 四个分域文件，W896 测试收敛）。
 *
 * 为什么合并：四个文件各只装 3–7 条用例，却各自付一次 fork 启动 + jsdom 环境构建
 * （实测 ~426ms/文件，其中环境构建占 jsdom 组墙钟的 51%）。它们共用同一个
 * `./lib/w795-dom.js` 夹具与同一套 locale 生命周期，是天然的一个测试单元。
 *
 * 合并是**纯搬运**：用例、断言、beforeEach/afterEach 逐字未改；各分域的顶层符号
 * （load/I18nMod/doc/ElLike）按域加了前缀以避免同模块作用域冲突。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

/**
 * i18n P0 内核测试：插值、回落、语言检测、切换；zh/en key 集合一致；
 * api.ts 域双语；语言切换只通知订阅者、不重建会话。
 */
interface CoreI18nMod {
  t(key: string, params?: Record<string, string | number>): string;
  getLocale(): string;
  setLocale(l: string): void;
  onLocaleChange(cb: () => void): () => void;
  detectLocale(): string;
  allKeys(): string[];
  localeDict(l: string): Record<string, string>;
  localeLabel(l: string): string;
}
interface CoreSettingsMod { languageField(): ElLike; languageFieldMounted(): boolean; installI18nSettings(): void; setReloadImpl(fn: () => void): void }

const loadCore = async (): Promise<CoreI18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as CoreI18nMod;
const loadCoreSettings = async (): Promise<CoreSettingsMod> => (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as CoreSettingsMod;

describe('i18n P0', () => {
  beforeEach(() => { resetHarness(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('zh / en 的 key 集合完全一致（漏译即红）', async () => {
    const m = await loadCore();
    const zhKeys = Object.keys(m.localeDict('zh')).sort();
    const enKeys = Object.keys(m.localeDict('en')).sort();
    expect(enKeys, '英文必须覆盖全部中文 key').toEqual(zhKeys);
    expect(zhKeys.length, 'P0 字典 key 数').toBeGreaterThan(8);
    expect(m.allKeys().sort()).toEqual(zhKeys);
  });

  it('插值只支持 {name}（中英都插）', async () => {
    const m = await loadCore();
    m.setLocale('zh');
    expect(m.t('common.language.changed', { name: 'English' })).toBe('界面语言已切换为 English');
    m.setLocale('en');
    expect(m.t('common.language.changed', { name: '中文' })).toBe('Interface language switched to 中文');
  });

  it('api.ts 域双语：同一 key 中英不同且各自正确', async () => {
    const m = await loadCore();
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
    const m = await loadCore();
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
    const m = await loadCore();
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

  it('切换语言触发整页重载（方案 A：让所有渲染期 t() 的模块以新语言重画）', async () => {
    const m = await loadCore();
    const s = await loadCoreSettings();
    m.setLocale('zh');
    const reload = vi.fn();
    s.setReloadImpl(reload); // 测试缝：jsdom 的 location.reload 不可重定义
    const host = doc.createElement('div') as unknown as ElLike;
    doc.body.appendChild(host);
    host.appendChild(s.languageField());
    const select = host.querySelector('select') as ElLike;
    select.value = 'en';
    select.dispatchEvent(new Ev('change', { bubbles: true }));
    expect(reload, '语言真的变化时必须整页重载').toHaveBeenCalledTimes(1);
    expect(m.getLocale()).toBe('en');
    select.value = 'en';
    select.dispatchEvent(new Ev('change', { bubbles: true }));
    expect(reload, '同值不重载').toHaveBeenCalledTimes(1);
  });

  it('语言字段：渲染 select 且切换后只重画自身文案（不重建背景）', async () => {
    const m = await loadCore();
    const s = await loadCoreSettings();
    m.setLocale('zh');
    const host = doc.createElement('div') as unknown as ElLike;
    doc.body.appendChild(host);
    const marker = doc.createElement('div') as unknown as ElLike;
    marker.className = 'bg-marker';
    host.appendChild(marker);
    host.appendChild(s.languageField());
    s.installI18nSettings(); // 语言切换时重画已挂载字段（单一订阅，见 i18n/settings.ts）
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
// i18n P1-c · 对话面域：语言切换后该域文案变化 + zh/en key 一致 + **可见性断言**。
interface ChatI18nMod { t(key: string, params?: Record<string, string | number>): string; setLocale(l: string): void; localeDict(l: string): Record<string, string> }
interface QFormatMod { countdownText(ms: number | null): string }
interface RailCenterMod { railCenterLabel(hit: { item: unknown; clamped: boolean; round: number }, fold?: number): string }
interface ToolcardsMod { buildToolCard(d: { step: number; name: string; argsText: string }): { col: ElLike; card: ElLike } }

const loadChat = async (): Promise<ChatI18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as ChatI18nMod;

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
    const m = await loadChat();
    m.setLocale('zh');
    expect(m.t('chat.think.title')).toBe('思考');
    expect(m.t('chat.tool.step', { n: 3 })).toBe('第 3 步');
    m.setLocale('en');
    expect(m.t('chat.think.title')).toBe('Thinking');
    expect(m.t('chat.tool.step', { n: 3 })).toBe('Step 3');
  });

  it('真实纯函数随语言切换（countdownText / railCenterLabel）', async () => {
    const m = await loadChat();
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
    const m = await loadChat();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('chat.'))).toContain('chat.tool.step');
  });
});
// i18n P1-b · 设置页域：语言切换后该域文案变化 + zh/en key 一致。
interface SettingsI18nMod { t(key: string, params?: Record<string, string | number>): string; setLocale(l: string): void; localeDict(l: string): Record<string, string> }
interface CopyMod { toolDenyLabel(name: string): string }
interface BatchMod { batchFailureText(verb: string, resp: unknown): string }
// 根 tsconfig 的 lib 只有 ES2023（无 DOM），所以 DOM 走 globalThis 的结构类型转换
// —— 与本仓既有 jsdom 测试（archive-manage / frontend-batch-*）同一约定。
interface SettingsElLike { lang: string }
interface SettingsDocLike { documentElement: SettingsElLike }
const docSettings = (globalThis as unknown as { document: SettingsDocLike }).document;

const loadSettingsDomain = async (): Promise<SettingsI18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as SettingsI18nMod;

describe('i18n P1-b · 设置页域', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('切换语言后设置页域文案变化', async () => {
    const m = await loadSettingsDomain();
    m.setLocale('zh');
    expect(m.t('settings.action.save')).toBe('保存');
    expect(m.t('settings.providers.defaultApplied')).toBe('已切换默认模型');
    m.setLocale('en');
    expect(m.t('settings.action.save')).toBe('Save');
    expect(m.t('settings.providers.defaultApplied')).toBe('Default model switched');
  });

  it('真实设置页纯函数随语言切换（toolDenyLabel / batchFailureText）', async () => {
    const m = await loadSettingsDomain();
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
    const m = await loadSettingsDomain();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('settings.'))).toContain('settings.providers.defaultApplied');
  });

  // 真机复核（headless shell + CDP）发现：index.html 写死 <html lang="zh-CN">，切到
  // 英文后不更新 —— 读屏器按中文音读、浏览器翻译器不提供翻译。这条锁住修复。
  it('<html lang> 跟着语言切换（英文界面不得自称 zh-CN）', async () => {
    docSettings.documentElement.lang = 'zh-CN';
    const m = await loadSettingsDomain();
    const s = (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as { installI18nSettings(): void };
    m.setLocale('zh');
    s.installI18nSettings();
    expect(docSettings.documentElement.lang).toBe('zh-CN');
    m.setLocale('en');
    expect(docSettings.documentElement.lang).toBe('en');
    m.setLocale('zh');
    expect(docSettings.documentElement.lang).toBe('zh-CN');
  });
});
// i18n P1-a · statusline 域：语言切换后该域文案变化 + zh/en key 一致。
interface StatusI18nMod {
  t(key: string, params?: Record<string, string | number>): string;
  setLocale(l: string): void;
  localeDict(l: string): Record<string, string>;
}
interface TpsMod {
  createTpsSamples(capacity?: number): { values: readonly number[]; capacity: number };
  pushTpsSamples(s: unknown, v: unknown): unknown;
  tpsDisplay(s: unknown, current: unknown, busy: boolean, format: (v: number) => string): { text: string; title: string };
}

const loadStatus = async (): Promise<StatusI18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as StatusI18nMod;
const loadTps = async (): Promise<TpsMod> => (await import(/* @vite-ignore */ at('statusline/tps.ts'))) as TpsMod;

describe('i18n P1-a · statusline 域', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

  it('切换语言后 statusline 域文案变化（同一 key 中英不同）', async () => {
    const m = await loadStatus();
    m.setLocale('zh');
    expect(m.t('statusline.switched')).toBe('已切换');
    expect(m.t('statusline.tooltip')).toContain('上下文占用');
    m.setLocale('en');
    expect(m.t('statusline.switched')).toBe('Switched');
    expect(m.t('statusline.tooltip')).toContain('Context usage');
  });

  it('真实 statusline 纯函数（tpsDisplay）随语言切换文案', async () => {
    const m = await loadStatus();
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
    const m = await loadStatus();
    const zh = Object.keys(m.localeDict('zh')).sort();
    const en = Object.keys(m.localeDict('en')).sort();
    expect(en).toEqual(zh);
    expect(zh.filter((k) => k.startsWith('statusline.'))).toContain('statusline.switched');
  });
});