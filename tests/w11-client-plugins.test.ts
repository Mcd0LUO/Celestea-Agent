// @vitest-environment jsdom
/**
 * W859 · 设置页「插件」一格（apps/web）：
 *   ① 客户端插件两行 + 开关默认开（且与真实提示注册表一致）；
 *   ② 关掉「文字卡片」→ **真实解析**不再走它（注册表里没有、resolveHint 返回 null、
 *      提示回退原生 title），重开恢复；
 *   ③ 关闭状态持久化（模块表重建 = 模拟重开页面，仍为关）；
 *   ④ 坏 JSON / 未知 id fail-safe（不崩、未知被忽略、不误关已知插件）；
 *   ⑤ 宿主清单：有数据逐项渲染并标「不可热拔插」；404 → 如实空态、不报错、不伪造；
 *   ⑥ 样式机械门禁（无 dashed/dotted、圆角无硬编码 px）+ 新样式已被 main.ts 引入。
 *
 * 说明：本文件自己补设置页宿主（resetHarness 之后 doc.body.insertAdjacentHTML 真实
 * index.html 的 #app 壳），不改 tests/lib/w795-dom.ts（并行任务在动它）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, WEB, type ElLike } from './lib/w795-dom.js';

interface InputLike extends ElLike {
  checked: boolean;
}

interface BodyLike extends ElLike {
  insertAdjacentHTML(pos: string, html: string): void;
}
interface HintHandleLike {
  build(): ElLike | null;
}
interface HintMod {
  initHints(): void;
  hintPlugins(): readonly { id: string; priority?: number }[];
  resolveHint(target: ElLike, text: string): HintHandleLike | null;
  setHint(target: ElLike, text: string | null): void;
}
interface CfgMod {
  initSettingsPage(): void;
}
interface StoreMod {
  parseDisabled(raw: string | null): string[];
}
interface LsLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}

const STYLES = join(WEB, 'src', 'styles');
const ls = (globalThis as unknown as { localStorage: LsLike }).localStorage;

const q = (sel: string): ElLike | null => doc.querySelector(sel);
const qa = (sel: string): ElLike[] => Array.from(doc.querySelectorAll(sel));

/** 真实 index.html 的 body 片段（#app 全壳；settings-archive-pane.test.ts 同法）。 */
function appMarkup(): string {
  const raw = readFileSync(join(WEB, 'index.html'), 'utf8');
  return raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

/** resetHarness 之后补设置页宿主（不碰共享夹具文件）。 */
function bootSettings(): void {
  (doc.body as BodyLike).insertAdjacentHTML('beforeend', appMarkup());
}

/** 走真实装配路径打开「插件」一格：initHints → initSettingsPage → 点导航。 */
async function openPlugins(): Promise<HintMod> {
  const hints = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as HintMod;
  hints.initHints();
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as CfgMod;
  cfg.initSettingsPage();
  q('.settings-nav-item[data-page="plugins"]')?.dispatchEvent(new Ev('click'));
  await flush();
  return hints;
}

const switchOf = (id: string): InputLike =>
  q('#settingsPlugins .plug-row[data-id="' + id + '"] .plug-switch-input') as InputLike;

async function flip(id: string, on: boolean): Promise<void> {
  const input = switchOf(id);
  input.checked = on;
  input.dispatchEvent(new Ev('change'));
  await flush(); // W895-C1：写服务端是异步的，等它落定再断言
}

const statusText = (): string => q('#settingsPlugins .plug-status')?.textContent ?? '';

/**
 * W895-C1：显示组件启用表的打桩服务端。默认在夹具 fetch 之上再包一层
 * （/api/display-plugins 走这里，其余仍走夹具），这样设置页读到的就是服务端真值。
 */
const displayServer = { disabled: [] as string[], failGet: false, failPut: false };
function stubDisplay(opts: { get?: boolean; put?: boolean } = {}): void {
  displayServer.failGet = opts.get === true;
  displayServer.failPut = opts.put === true;
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: { method?: string; body?: unknown }) => Promise<unknown> }).fetch;
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string; body?: unknown }) => {
    if (!String(url).startsWith('/api/display-plugins')) return base(url, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      if (displayServer.failPut) return Promise.resolve(reply(500, { ok: false, error: 'write failed' }));
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { disabled?: unknown };
      displayServer.disabled = Array.isArray(parsed.disabled) ? (parsed.disabled as string[]) : [];
      return Promise.resolve(reply(200, { ok: true, disabled: displayServer.disabled }));
    }
    if (displayServer.failGet) return Promise.resolve(reply(404, { ok: false }));
    return Promise.resolve(reply(200, { ok: true, disabled: displayServer.disabled }));
  });
}

/** 打桩 GET /api/plugins（其余请求仍走夹具的真实 fetch 路径）。 */
function stubPlugins(status: number, payload: unknown): void {
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: unknown) => Promise<unknown> }).fetch;
  vi.stubGlobal('fetch', (url: unknown, init?: unknown) =>
    String(url).startsWith('/api/plugins') ? Promise.resolve(reply(status, payload)) : base(url, init),
  );
}

beforeEach(() => {
  resetHarness();
  ls.clear();
  displayServer.disabled = [];
  stubDisplay(); // W895-C1：默认服务端启用表为空 = 全开
  bootSettings();
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('W859 设置页「插件」· 客户端插件真实热开关', () => {
  it('① 列出全部客户端插件（2 提示 + 4 增强），开关默认开，且与真实提示注册表一致', async () => {
    const hints = await openPlugins();
    const rows = qa('#settingsPlugins .plug-row');
    // W895-L：插件库**按分类分组**渲染，所以 DOM 顺序 = 分类顺序（不再是登记表顺序）。
    // 这里断言「集合完整」，顺序由下一条（分组）用例钉住。
    // JSON 树组件已按用户要求移除，故为 2 提示 + 4 增强。
    expect(rows.map((r) => r.dataset['id']).sort()).toEqual([
      'display.codeCopy', 'display.codeExtras', 'display.csvTable', 'display.imageZoom',
      'hint-text-card', 'rail-preview',
    ]);
    expect(qa('#settingsPlugins .plug-row-label').map((n) => n.textContent).sort()).toEqual([
      '代码块复制',
      '代码块增强',
      '图片灯箱',
      '预览卡片',
      '文字卡片',
      '表格视图',
    ].sort());
    for (const r of rows) {
      expect((r.querySelector('.plug-switch-input') as InputLike).checked).toBe(true);
    }
    expect(hints.hintPlugins().map((p) => p.id).sort()).toEqual(['hint-text-card', 'rail-preview']);
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    for (const needle of ['data-page="plugins"', 'data-pane="plugins"', 'id="settingsPlugins"']) {
      expect(html).toContain(needle);
    }
  });

  it('② 关掉「文字卡片」后真实解析不再走它，重开恢复', async () => {
    const hints = await openPlugins();
    const node = doc.createElement('div') as ElLike;
    expect(hints.resolveHint(node, '提示')?.build()?.className).toBe('hint-card-text');

    await flip('hint-text-card', false);
    expect(hints.hintPlugins().map((p) => p.id)).toEqual(['rail-preview']);
    expect(hints.resolveHint(node, '提示')).toBeNull();
    hints.setHint(node, '提示');
    expect(node.getAttribute('data-hint')).toBe('提示');
    expect(node.getAttribute('title')).toBe('提示'); // 无人认领 → 原生兜底
    expect(statusText()).toContain('已关闭');

    await flip('hint-text-card', true);
    expect(hints.hintPlugins().map((p) => p.id).sort()).toEqual(['hint-text-card', 'rail-preview']);
    expect(hints.resolveHint(node, '提示')?.build()?.className).toBe('hint-card-text');
  });

  it('③ 关闭状态持久化到服务端：模拟重开页面仍为关', async () => {
    await openPlugins();
    await flip('hint-text-card', false);
    // W895-C1：真源已是服务端（不再是 localStorage）。
    expect(displayServer.disabled).toContain('hint-text-card');

    resetHarness(); // 模块表 + DOM 全部重建；服务端状态保留（= 重开页面）
    stubDisplay();
    bootSettings();
    const again = await openPlugins();
    expect(switchOf('hint-text-card').checked).toBe(false);
    expect(switchOf('rail-preview').checked).toBe(true);
    expect(again.hintPlugins().map((p) => p.id)).toEqual(['rail-preview']);
  });

  it('④ 服务端读失败=全开；未知 id 忽略、不误关已知（parseDisabled 仍覆盖旧值解析）', async () => {
    const store = (await import(/* @vite-ignore */ at('plugins/store.ts'))) as StoreMod;
    // 纯函数 parseDisabled 仍是迁移读取旧 localStorage 的解析器（坏数据 fail-safe）。
    expect(store.parseDisabled('{ 这不是 JSON')).toEqual([]);
    expect(store.parseDisabled('"x"')).toEqual([]);
    expect(store.parseDisabled('["a",3,null,"b"]')).toEqual(['a', 'b']);

    // (a) 服务端读失败 ⇒ 如实降级为「全开」，不崩、不伪造
    resetHarness();
    displayServer.disabled = ['ghost-plugin', 'hint-text-card'];
    stubDisplay({ get: true });
    bootSettings();
    await openPlugins();
    expect(switchOf('hint-text-card').checked).toBe(true);
    expect(switchOf('rail-preview').checked).toBe(true);

    // (b) 服务端读成功但含未知 id ⇒ 未知忽略、已知照关
    resetHarness();
    displayServer.disabled = ['ghost-plugin', 'hint-text-card'];
    stubDisplay();
    bootSettings();
    const hints = await openPlugins();
    expect(switchOf('hint-text-card').checked).toBe(false);
    expect(switchOf('rail-preview').checked).toBe(true);
    expect(q('#settingsPlugins .plug-row[data-id="ghost-plugin"]')).toBeNull();
    expect(hints.hintPlugins().map((p) => p.id)).toEqual(['rail-preview']);
  });

  it('⑤ 宿主清单：有数据逐项渲染并标注不可热拔插；404 如实空态', async () => {
    stubPlugins(200, {
      ok: true,
      plugins: [
        { name: 'demo-host', version: '1.2.3', description: '示例' },
        { nonsense: true },
      ],
    });
    await openPlugins();
    await flush();
    const hostRows = qa('#settingsPlugins .plug-host');
    expect(hostRows.length).toBe(1); // 认不出的项被忽略，不伪造
    expect(hostRows[0]?.textContent).toContain('demo-host');
    expect(hostRows[0]?.textContent).toContain('服务端内置 · 进程内不可热拔插');
    expect(hostRows[0]?.querySelector('.plug-switch-input')).toBeNull(); // 只读

    resetHarness(); // GET /api/plugins → 404（夹具默认）
    bootSettings();
    await openPlugins();
    await flush();
    expect(q('#settingsPlugins .plug-empty')?.textContent).toBe('服务端未提供插件清单');
    expect(qa('#settingsPlugins .plug-host').length).toBe(0);
    expect(qa('#settingsPlugins .plug-switch-input').length).toBe(6);
  });
  it('⑦ W895：新增的「增强」类组件关掉后真的从增强缝注销（与提示类同一套开关）', async () => {
    await openPlugins();
    const enhance = (await import(/* @vite-ignore */ at('ui/enhance/registry.ts'))) as {
      enhancerIds(): readonly string[];
    };
    expect(enhance.enhancerIds()).toContain('display.codeCopy');

    await flip('display.codeCopy', false);
    expect(enhance.enhancerIds()).not.toContain('display.codeCopy');
    expect(statusText()).toContain('已关闭');

    await flip('display.codeCopy', true);
    expect(enhance.enhancerIds()).toContain('display.codeCopy');
  });
});

describe('W859 样式机械门禁（apps/web/src/styles）', () => {
  it('⑥ 无虚线；圆角无硬编码 px（999px 胶囊除外）；新样式已接线', () => {
    const bad: string[] = [];
    const files = readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort();
    for (const name of files) {
      const text = readFileSync(join(STYLES, name), 'utf8');
      if (/\b(dashed|dotted)\b/.test(text)) bad.push(name + ' 含虚线');
      for (const m of text.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
        const v = (m[1] ?? '').trim();
        if (/\d+px/.test(v) && !v.includes('999px')) bad.push(name + ' 圆角 ' + v);
      }
    }
    expect(bad).toEqual([]);
    expect(readFileSync(join(STYLES, 'plugins.css'), 'utf8')).toContain('--r-card');
    expect(readFileSync(join(WEB, 'src', 'main.ts'), 'utf8')).toContain("import './styles/plugins.css'");
  });
});
