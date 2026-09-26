// @vitest-environment jsdom
/**
 * 设置页「通用偏好」独立 pane：nav 存在、点击切页、语言字段只在新 pane、
 * 切页零重建（节点身份不变）、切语言后该页文案立刻变。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ConfigMod { initSettingsPage(): void }
interface I18nMod { setLocale(l: string): void }

const HTML =
  '<div id="settingsPage">' +
  '<nav class="settings-nav">' +
  '<button class="settings-nav-item" type="button" data-page="general" data-i18n="settings.general.title"></button>' +
  '<button class="settings-nav-item active" type="button" data-page="config">通用配置</button>' +
  '<button class="settings-nav-item" type="button" data-page="tools"></button>' +
  '<button class="settings-nav-item" type="button" data-page="archive"></button>' +
  '<button class="settings-nav-item" type="button" data-page="providers"></button>' +
  '<button class="settings-nav-item" type="button" data-page="prompts"></button>' +
  '<button class="settings-nav-item" type="button" data-page="permissions"></button>' +
  '<button class="settings-nav-item" type="button" data-page="plugins"></button>' +
  '<button class="settings-nav-item" type="button" data-page="usage"></button>' +
  '</nav>' +
  '<section class="settings-pane" data-pane="general"><h4 data-i18n="settings.general.title"></h4><div class="settings-pane-body" id="settingsGeneral"></div></section>' +
  '<section class="settings-pane active" data-pane="config"><div id="settingsConfig"></div><div id="settingsHint"></div></section>' +
  '<section class="settings-pane" data-pane="tools"><span id="toolsCount"></span><div id="settingsTools"></div></section>' +
  '<section class="settings-pane" data-pane="archive"><span id="settingsArchiveCount"></span><div id="settingsArchive"></div><div id="settingsArchiveHint"></div></section>' +
  '<section class="settings-pane" data-pane="providers"><div id="settingsProviders"></div></section>' +
  '<section class="settings-pane" data-pane="prompts"><div id="promptsWrap"></div><div id="settingsPrompts"></div></section>' +
  '<section class="settings-pane" data-pane="permissions"><div id="settingsPermissions"></div></section>' +
  '<section class="settings-pane" data-pane="plugins"><div id="settingsPlugins"></div></section>' +
  '<section class="settings-pane" data-pane="usage"><div id="settingsUsage"></div></section>' +
  // W9103：设置入口从顶栏 #btnConfig 挪到左下角 #btnSettingsEntry（断言语义未改）
  '<button id="btnSettingsEntry"></button><button id="btnSettingsClose"></button><button id="btnSettingsReload"></button>' +
  '<button id="btnAddProvider"></button><button id="btnNewPrompt"></button>' +
  '</div>';

const generalNav = (): ElLike => doc.querySelector('.settings-nav-item[data-page="general"]') as ElLike;
const generalPane = (): ElLike => doc.querySelector('.settings-pane[data-pane="general"]') as ElLike;
const generalBody = (): ElLike => doc.getElementById('settingsGeneral') as ElLike;

describe('设置页 · 通用偏好（独立语言页）', () => {
  beforeEach(() => { resetHarness(); doc.body.innerHTML = HTML; localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); localStorage.clear(); });

  async function boot(): Promise<{ i18n: I18nMod }> {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    cfg.initSettingsPage();
    return { i18n };
  }

  it('新 nav 项存在且文案走 i18n（非写死中文）', async () => {
    await boot();
    expect(generalNav().textContent).toBe('通用偏好');
    expect(generalNav().getAttribute('data-i18n')).toBe('settings.general.title');
    expect((generalPane().querySelector('h4') as ElLike).textContent).toBe('通用偏好');
  });

  it('点击切到新 pane；语言字段只在新 pane，config pane 里没有', async () => {
    await boot();
    generalNav().dispatchEvent(new Ev('click', { bubbles: true }));
    expect(generalPane().classList.contains('active')).toBe(true);
    expect(doc.querySelector('.settings-pane[data-pane="config"]')?.classList.contains('active')).toBe(false);
    expect(generalBody().querySelector('select'), '语言字段在新 pane').not.toBeNull();
    expect(doc.getElementById('settingsConfig')?.querySelector('select'), 'config pane 不得再有语言字段').toBeNull();
  });

  it('切页零重建：切走再切回，语言字段节点身份不变、不重新请求', async () => {
    await boot();
    generalNav().dispatchEvent(new Ev('click', { bubbles: true }));
    const field = generalBody().querySelector('.i18n-field') as ElLike;
    expect(field).not.toBeNull();
    // 切到 config（会触发 loadConfig 取配置），再切回 general
    (doc.querySelector('.settings-nav-item[data-page="config"]') as ElLike).dispatchEvent(new Ev('click', { bubbles: true }));
    generalNav().dispatchEvent(new Ev('click', { bubbles: true }));
    expect(generalBody().querySelector('.i18n-field'), '切回不得重建').toBe(field);
  });

  it('切语言后该页文案立刻变（语言字段标签 + nav/标题）', async () => {
    const { i18n } = await boot();
    generalNav().dispatchEvent(new Ev('click', { bubbles: true }));
    const field = generalBody().querySelector('.i18n-field') as ElLike;
    expect((field.querySelector('.cfg-label') as ElLike).textContent).toBe('语言');
    i18n.setLocale('en');
    expect((field.querySelector('.cfg-label') as ElLike).textContent).toBe('Language');
    expect(generalNav().textContent).toBe('General preferences');
    expect((generalPane().querySelector('h4') as ElLike).textContent).toBe('General preferences');
    expect(field, '切语言不重建字段节点').toBe(generalBody().querySelector('.i18n-field'));
  });
});
