// @vitest-environment jsdom
/**
 * W9104 前端半边 —— 通用配置页的「自动重试次数」字段。
 *
 * 两条不变量（与派工者的收口口径逐条对应）：
 *   ① **只有后端发布了 max_retries 才渲染** —— 旧服务不认它，渲染一个控件再被 400 拒绝
 *      是骗人的；不渲染比渲染一个假的默认值诚实（「诚实降级」）；
 *   ② 保存时**只在用户改过时才带上**该键（后端把「缺省」定义为不改），
 *      且**不在前端夹范围** —— 越界交给后端 400，前端不替产品规则做静默修正。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ConfigMod {
  loadConfig(opts?: { refresh?: boolean }): Promise<void>;
  initSettingsPage(): void;
}

const HTML =
  '<div id="settingsPage">' +
  '<nav class="settings-nav">' +
  '<button class="settings-nav-item active" type="button" data-page="config"></button>' +
  '<button class="settings-nav-item" type="button" data-page="general"></button>' +
  '<button class="settings-nav-item" type="button" data-page="tools"></button>' +
  '<button class="settings-nav-item" type="button" data-page="archive"></button>' +
  '<button class="settings-nav-item" type="button" data-page="providers"></button>' +
  '<button class="settings-nav-item" type="button" data-page="prompts"></button>' +
  '<button class="settings-nav-item" type="button" data-page="permissions"></button>' +
  '<button class="settings-nav-item" type="button" data-page="plugins"></button>' +
  '<button class="settings-nav-item" type="button" data-page="usage"></button>' +
  '</nav>' +
  '<section class="settings-pane active" data-pane="config"><div id="settingsConfig"></div><div id="settingsHint"></div></section>' +
  '<section class="settings-pane" data-pane="general"><div id="settingsGeneral"></div></section>' +
  '<section class="settings-pane" data-pane="tools"><span id="toolsCount"></span><div id="settingsTools"></div></section>' +
  '<section class="settings-pane" data-pane="archive"><span id="settingsArchiveCount"></span><div id="settingsArchive"></div><div id="settingsArchiveHint"></div></section>' +
  '<section class="settings-pane" data-pane="providers"><div id="settingsProviders"></div></section>' +
  '<section class="settings-pane" data-pane="prompts"><div id="promptsWrap"></div><div id="settingsPrompts"></div></section>' +
  '<section class="settings-pane" data-pane="permissions"><div id="settingsPermissions"></div></section>' +
  '<section class="settings-pane" data-pane="plugins"><div id="settingsPlugins"></div></section>' +
  '<section class="settings-pane" data-pane="usage"><div id="settingsUsage"></div></section>' +
  '<button id="btnSettingsEntry"></button><button id="btnSettingsClose"></button><button id="btnSettingsReload"></button>' +
  '<button id="btnAddProvider"></button><button id="btnNewPrompt"></button>' +
  '</div>';

/** The config GET body; `max_retries` is omitted for the "old server" case. */
function configBody(includeRetries: boolean, value = 1): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: 'deepseek-flash',
    base_url: 'http://x/v1',
    max_steps: 4096,
    context_window: 1000000,
    reasoning_effort: null,
    max_output_tokens: null,
    system_prompt: 'sys',
    available: { models: [{ id: 'deepseek-flash', name: 'Flash' }], efforts: ['low', 'high'] },
  };
  if (includeRetries) base['max_retries'] = value;
  return base;
}

let lastPatch: Record<string, unknown> | null = null;
let serverHasRetries = true;
let serverRetries = 1;

function stubServer(): void {
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (u.startsWith('/api/config')) {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        lastPatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Promise.resolve(reply(200, { ok: true, ...configBody(serverHasRetries, serverRetries) }));
      }
      return Promise.resolve(reply(200, configBody(serverHasRetries, serverRetries)));
    }
    if (u.startsWith('/api/status')) return Promise.resolve(reply(200, { model: 'deepseek-flash' }));
    return Promise.resolve(reply(404, { ok: false }));
  });
}

const q = (s: string): ElLike | null => doc.querySelector(s);
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s));
/** The retry control: the number input inside the field labelled 自动重试次数. */
function retryInput(): ElLike | null {
  for (const row of qa('#settingsConfig .cfg-field')) {
    if (row.querySelector('.cfg-label')?.textContent === '自动重试次数') {
      return row.querySelector('input');
    }
  }
  return null;
}
function saveBtn(): ElLike {
  return q('#settingsConfig .cfg-actions button') as ElLike;
}

describe('W9104 · 通用配置页「自动重试次数」', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    localStorage.clear();
    lastPatch = null;
    serverHasRetries = true;
    serverRetries = 1;
    stubServer();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as { setLocale(l: string): void };
    i18n.setLocale('zh');
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    cfg.initSettingsPage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
    localStorage.clear();
  });

  it('① 后端发布了 max_retries ⇒ 字段渲染，且初值 = 服务端值', async () => {
    serverRetries = 2;
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    await cfg.loadConfig({ refresh: true });
    const input = retryInput();
    expect(input, '字段应当渲染').not.toBeNull();
    expect(input!.value).toBe('2');
    expect(input!.getAttribute('min')).toBe('0');
    expect(input!.getAttribute('max')).toBe('3');
  });

  it('① 旧服务（没有该字段）⇒ **不渲染**该控件（不伪造默认值）', async () => {
    serverHasRetries = false;
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    await cfg.loadConfig({ refresh: true });
    expect(retryInput(), '旧服务下不得渲染重试控件').toBeNull();
  });

  it('② 改过才带上该键：改成 3 保存 ⇒ patch 含 max_retries: 3', async () => {
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    await cfg.loadConfig({ refresh: true });
    const input = retryInput()!;
    input.value = '3';
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch).not.toBeNull();
    expect(lastPatch!['max_retries']).toBe(3);
  });

  it('② 没改 ⇒ patch **不含**该键（后端把缺省定义为「不改」）', async () => {
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    await cfg.loadConfig({ refresh: true });
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch).not.toBeNull();
    expect('max_retries' in lastPatch!).toBe(false);
  });

  it('② 越界不在前端夹：输入 9 ⇒ 原样发给后端（由它 400 拒绝）', async () => {
    const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as ConfigMod;
    await cfg.loadConfig({ refresh: true });
    const input = retryInput()!;
    input.value = '9';
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch!['max_retries'], '前端不得静默夹到 3').toBe(9);
  });
});
