// @vitest-environment jsdom
/**
 * W9108 — 插件页「可调配置」：通用配置缝 + 内联展开面板 + 落地配置项。
 *
 * 五条不变量（与派工简报逐条对应）：
 *   ① 展开区节点存在，且**只在展开时可见**（收起 = max-height 0 / 不带 open）；
 *   ② **每种控件类型**都能从描述渲染出来（参数化 bool / enum / text / number）；
 *   ③ 改配置 → 插件行为**真的变了**（代码块增强的折叠阈值）；
 *   ④ 读失败 / 写失败如实降级（不伪造成功、不吞用户配置）；
 *   ⑤ 渲染器**不含按 id 的分支**：换一个从未见过的假 descriptor 也能渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, flush, reply, resetHarness, type ElLike } from './lib/w795-dom.js';

interface InputLike extends ElLike {
  checked: boolean;
  type: string;
  value: string;
  maxLength: number;
  min: string;
  max: string;
  step: string;
}
interface Mod {
  renderConfigSpec(spec: unknown, values: Record<string, string>, onChange: (k: string, v: string) => void): ElLike;
  applyValues(box: ElLike, values: Record<string, string>): void;
  readControl(node: ElLike): string;
  buildConfigPanel(
    label: string,
    spec: unknown,
    values: Record<string, string>,
    onChange: (k: string, v: string) => void,
  ): { state: { open: boolean }; toggle: ElLike; panel: ElLike; content: ElLike };
}

const q = (s: string): ElLike | null => doc.querySelector(s);
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s));
const cls = (n: ElLike, c: string): boolean => n.classList.contains(c);
const panel = (id: string): ElLike => q('#settingsPlugins .plug-entry[data-id="' + id + '"] .plug-panel') as ElLike;

const server = { disabled: [] as string[], config: {} as Record<string, Record<string, string>>, failGet: false, failPut: false };

function stubServer(): void {
  const base = (globalThis as unknown as { fetch: (u: unknown, i?: { method?: string; body?: unknown }) => Promise<unknown> }).fetch;
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string; body?: unknown }) => {
    if (!String(url).startsWith('/api/display-plugins')) return base(url, init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      if (server.failPut) return Promise.resolve(reply(500, { ok: false, error: 'write failed' }));
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { disabled?: unknown; config?: unknown };
      if (Array.isArray(parsed.disabled)) server.disabled = parsed.disabled as string[];
      if (parsed.config !== undefined) server.config = (parsed.config ?? {}) as Record<string, Record<string, string>>;
      return Promise.resolve(reply(200, { ok: true, disabled: server.disabled, config: server.config }));
    }
    if (server.failGet) return Promise.resolve(reply(404, { ok: false }));
    return Promise.resolve(reply(200, { ok: true, disabled: server.disabled, config: server.config }));
  });
}

/** 打开设置页「插件」一格（真实装配路径）。 */
async function openPlugins(): Promise<void> {
  const hints = (await import(/* @vite-ignore */ at('ui/hint/index.ts'))) as { initHints(): void };
  hints.initHints();
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as { initSettingsPage(): void };
  cfg.initSettingsPage();
  q('.settings-nav-item[data-page="plugins"]')?.dispatchEvent(new Ev('click'));
  await flush();
}

function appMarkup(): string {
  const raw = require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'apps', 'web', 'index.html'), 'utf8') as string;
  return raw.slice(raw.indexOf('<div id="app">'), raw.indexOf('<script type="module"'));
}

beforeEach(() => {
  resetHarness();
  server.disabled = [];
  server.config = {};
  server.failGet = false;
  server.failPut = false;
  stubServer();
  (doc.body as ElLike & { insertAdjacentHTML(p: string, h: string): void }).insertAdjacentHTML('beforeend', appMarkup());
});
afterEach(() => {
  vi.unstubAllGlobals();
  doc.body.replaceChildren();
});

describe('W9108 ① 展开区：节点存在，且只在展开时可见', () => {
  it('每行都有展开控件与相邻面板；收起时面板不带 open、展开后才带', async () => {
    await openPlugins();
    const rows = qa('#settingsPlugins .plug-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('.plug-expand')).not.toBeNull();
      const entry = row.parentElement as ElLike;
      expect(entry.className).toContain('plug-entry');
      expect(entry.querySelector('.plug-panel')).not.toBeNull();
    }
    const id = 'display.codeExtras';
    const p = panel(id);
    expect(cls(p, 'open')).toBe(false);
    const toggle = q('#settingsPlugins .plug-entry[data-id="' + id + '"] .plug-expand') as ElLike;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect((toggle.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    toggle.dispatchEvent(new Ev('click'));
    expect(cls(p, 'open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.dispatchEvent(new Ev('click'));
    expect(cls(p, 'open')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('没有可调项的插件：展开区如实说明，不伪造控件', async () => {
    await openPlugins();
    const id = 'display.codeCopy';
    expect(panel(id).querySelector('.plug-cfg-empty')?.textContent).toBe('这个插件没有可调项');
    expect(panel(id).querySelectorAll('.plug-cfg-item').length).toBe(0);
    // 真·如实：空描述下**一个控件节点都不许有**（伪造一个裸 input 也会被这里抓住）。
    expect(panel(id).querySelectorAll('input, select, textarea').length).toBe(0);
    // 有可调项的插件则真的画出控件，且**不**出现空态文案。
    expect(panel('display.codeExtras').querySelector('.plug-cfg-empty')).toBeNull();
    expect(panel('display.codeExtras').querySelectorAll('.plug-cfg-item').length).toBeGreaterThan(0);
  });
});

describe('W9108 ② 每种控件类型都能从描述渲染出来（参数化）', () => {
  async function render(spec: unknown, values: Record<string, string> = {}): Promise<{ box: ElLike; changes: Array<[string, string]> }> {
    const mod = (await import(/* @vite-ignore */ at('ui/plugins/config-panel.ts'))) as Mod;
    const changes: Array<[string, string]> = [];
    const box = mod.renderConfigSpec(spec, values, (k, v) => changes.push([k, v]));
    doc.body.appendChild(box);
    return { box, changes };
  }

  it('bool → 勾选框，初值来自生效值，变更回传 on/off', async () => {
    const { box, changes } = await render(
      { items: [{ kind: 'bool', key: 'b', labelKey: 'plugins.desc.hljs.label', def: true }] },
      { b: 'off' },
    );
    const input = box.querySelector('.plug-cfg-bool') as InputLike;
    expect(input.type).toBe('checkbox');
    expect(input.checked).toBe(false);
    input.checked = true;
    input.dispatchEvent(new Ev('change'));
    expect(changes).toEqual([['b', 'on']]);
  });

  it('enum → 下拉框，选项走 t()，初值来自生效值', async () => {
    const { box, changes } = await render({
      items: [{
        kind: 'enum', key: 'e', labelKey: 'plugins.desc.math.label', def: 'a',
        options: [
          { value: 'a', labelKey: 'plugins.desc.hljs.label' },
          { value: 'b', labelKey: 'plugins.desc.math.label' },
        ],
      }],
    });
    const select = box.querySelector('.plug-cfg-enum') as ElLike & { value: string };
    expect(select.querySelectorAll('option').length).toBe(2);
    expect(select.querySelectorAll('option')[0]!.textContent).toBe('代码高亮'); // t() 真的生效
    select.value = 'b';
    select.dispatchEvent(new Ev('change'));
    expect(changes).toEqual([['e', 'b']]);
  });

  it('text → 文本框，maxLength 落到控件上', async () => {
    const { box, changes } = await render({ items: [{ kind: 'text', key: 's', labelKey: 'plugins.desc.math.label', def: 'x', maxLength: 4 }] });
    const input = box.querySelector('.plug-cfg-text') as InputLike;
    expect(input.type).toBe('text');
    expect(input.value).toBe('x');
    expect(input.maxLength).toBe(4);
    input.value = 'hello';
    input.dispatchEvent(new Ev('change'));
    expect(changes).toEqual([['s', 'hello']]);
  });

  it('number → 数字框，min/max/step/默认值全部来自描述', async () => {
    const { box, changes } = await render({ items: [{ kind: 'number', key: 'n', labelKey: 'plugins.desc.math.label', def: 30, min: 5, max: 500, step: 5 }] });
    const input = box.querySelector('.plug-cfg-number') as InputLike;
    expect(input.type).toBe('number');
    expect(input.value).toBe('30');
    expect(input.min).toBe('5');
    expect(input.max).toBe('500');
    expect(input.step).toBe('5');
    input.value = '60';
    input.dispatchEvent(new Ev('change'));
    expect(changes).toEqual([['n', '60']]);
  });

  it('applyValues 把值回填到各控件（保存失败拨回原值的那一步）', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/plugins/config-panel.ts'))) as Mod;
    const box = mod.renderConfigSpec(
      {
        items: [
          { kind: 'number', key: 'n', labelKey: 'plugins.desc.math.label', def: 30 },
          { kind: 'bool', key: 'b', labelKey: 'plugins.desc.math.label', def: false },
        ],
      },
      { n: '30', b: 'off' },
      () => undefined,
    );
    doc.body.appendChild(box);
    (box.querySelector('.plug-cfg-number') as InputLike).value = '999';
    (box.querySelector('.plug-cfg-bool') as InputLike).checked = true;
    mod.applyValues(box, { n: '45', b: 'on' });
    expect((box.querySelector('.plug-cfg-number') as InputLike).value).toBe('45');
    expect((box.querySelector('.plug-cfg-bool') as InputLike).checked).toBe(true);
  });
});

describe('W9108 ③ 改配置 → 插件行为真的变了', () => {
  /** 造一个长代码块（行数可调）。 */
  function longBlock(lines: number): { box: ElLike; pre: ElLike } {
    const box = doc.createElement('div');
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.className = 'language-ts';
    code.textContent = Array.from({ length: lines }, (_, i) => 'line' + i).join('\n');
    pre.appendChild(code);
    box.appendChild(pre);
    return { box, pre };
  }

  async function enhancer(): Promise<{ enhance(c: ElLike): void }> {
    const mod = (await import(/* @vite-ignore */ at('ui/enhance/code-extras.ts'))) as {
      codeExtrasEnhancer(): { enhance(c: ElLike): void };
      setCodeFoldLines(n: number): void;
      currentFoldLines(): number;
    };
    return mod.codeExtrasEnhancer();
  }

  it('阈值变小 ⇒ 原本不折叠的块开始折叠（行为真的跟着配置走）', async () => {
    const extras = (await import(/* @vite-ignore */ at('ui/enhance/code-extras.ts'))) as {
      setCodeFoldLines(n: number): void;
      currentFoldLines(): number;
    };
    extras.setCodeFoldLines(200);
    const a = longBlock(30);
    await (await enhancer()).enhance(a.box);
    expect(a.pre.classList.contains('code-folded')).toBe(false); // 30 行 < 200 ⇒ 不折叠

    extras.setCodeFoldLines(10);
    const b = longBlock(30);
    await (await enhancer()).enhance(b.box);
    expect(b.pre.classList.contains('code-folded')).toBe(true); // 30 行 > 10 ⇒ 折叠
    expect(extras.currentFoldLines()).toBe(10);
    extras.setCodeFoldLines(30); // 还原默认
  });

  it('经设置页写配置 ⇒ 服务端落库 + 生效值回填 + 真的改变折叠行为', async () => {
    await openPlugins();
    const input = panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike;
    expect(input.value).toBe('30'); // 默认值
    input.value = '8';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '8' });

    const extras = (await import(/* @vite-ignore */ at('ui/enhance/code-extras.ts'))) as {
      codeExtrasEnhancer(): { enhance(c: ElLike): void };
      currentFoldLines(): number;
      setCodeFoldLines(n: number): void;
    };
    expect(extras.currentFoldLines()).toBe(8);
    const block = longBlock(12);
    extras.codeExtrasEnhancer().enhance(block.box);
    expect(block.pre.classList.contains('code-folded')).toBe(true);
    extras.setCodeFoldLines(30); // 还原，避免污染其它用例
  });

  it('越界值被夹进描述声明的区间（界面上显示的 = 能存下去的）', async () => {
    await openPlugins();
    const input = panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike;
    input.value = '99999';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '500' }); // max=500
    expect(input.value).toBe('500');
    input.value = '1';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '5' }); // min=5
    expect(input.value).toBe('5');
  });

  it('刷新页面（模块重建 + 服务端保留）后取值仍在 —— 持久化真的生效', async () => {
    await openPlugins();
    const input = panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike;
    input.value = '77';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '77' });

    resetHarness(); // 模块表 + DOM 全重建；服务端状态保留
    stubServer();
    (doc.body as ElLike & { insertAdjacentHTML(p: string, h: string): void }).insertAdjacentHTML('beforeend', appMarkup());
    await openPlugins();
    expect((panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike).value).toBe('77');
    const extras = (await import(/* @vite-ignore */ at('ui/enhance/code-extras.ts'))) as { currentFoldLines(): number };
    expect(extras.currentFoldLines()).toBe(77);
  });
});

describe('W9108 ④ 读失败 / 写失败如实降级', () => {
  it('读服务端失败 ⇒ 配置全部回落默认值，不崩、不伪造', async () => {
    server.failGet = true;
    server.config = { 'display.codeExtras': { foldLines: '3' } };
    await openPlugins();
    expect((panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike).value).toBe('30');
    const store = (await import(/* @vite-ignore */ at('plugins/store.ts'))) as {
      displayPluginsServerAvailable(): boolean;
      savedConfigOf(id: string): Record<string, string>;
    };
    expect(store.displayPluginsServerAvailable()).toBe(false);
    expect(store.savedConfigOf('display.codeExtras')).toEqual({});
  });

  it('写服务端失败 ⇒ 控件拨回原值、内存镜像不动、状态行如实说明', async () => {
    await openPlugins();
    const input = panel('display.codeExtras').querySelector('.plug-cfg-number') as InputLike;
    input.value = '60';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '60' });

    server.failPut = true;
    input.value = '12';
    input.dispatchEvent(new Ev('change'));
    await flush();
    expect(input.value).toBe('60'); // 拨回服务端真值
    expect(server.config['display.codeExtras']).toEqual({ foldLines: '60' }); // 服务端没动
    const store = (await import(/* @vite-ignore */ at('plugins/store.ts'))) as { savedConfigOf(id: string): Record<string, string> };
    expect(store.savedConfigOf('display.codeExtras')).toEqual({ foldLines: '60' }); // 镜像没动
    const status = q('#settingsPlugins .plug-status') as ElLike;
    expect(status.className).toContain('err');
    expect(status.textContent).toContain('保存失败');
    const extras = (await import(/* @vite-ignore */ at('ui/enhance/code-extras.ts'))) as { currentFoldLines(): number };
    expect(extras.currentFoldLines()).toBe(60); // 行为没被失败的值污染
  });
});

describe('W9108 ⑤ 渲染器不含按 id 的分支（换一个假 descriptor 也能渲染）', () => {
  it('把登记表换成从未见过的插件，面板照常渲染出全部控件', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/plugins/config-panel.ts'))) as Mod;
    const spec = {
      items: [
        { kind: 'bool', key: 'x1', labelKey: 'plugins.desc.hljs.label', def: true },
        { kind: 'enum', key: 'x2', labelKey: 'plugins.desc.hljs.label', def: 'p', options: [{ value: 'p', labelKey: 'plugins.desc.hljs.label' }] },
        { kind: 'text', key: 'x3', labelKey: 'plugins.desc.hljs.label', def: 'z' },
        { kind: 'number', key: 'x4', labelKey: 'plugins.desc.hljs.label', def: 7, min: 1, max: 9 },
      ],
    };
    const built = mod.buildConfigPanel('从未见过的插件', spec, {}, () => undefined);
    doc.body.appendChild(built.panel);
    expect(built.content.querySelectorAll('.plug-cfg-item').length).toBe(4);
    expect(built.content.querySelector('.plug-cfg-bool')).not.toBeNull();
    expect(built.content.querySelector('.plug-cfg-enum')).not.toBeNull();
    expect(built.content.querySelector('.plug-cfg-text')).not.toBeNull();
    expect(built.content.querySelector('.plug-cfg-number')).not.toBeNull();
  });

  it('渲染器源码里没有对插件 id 的 if/else（机械兜底）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'apps', 'web', 'src', 'ui', 'plugins', 'config-panel.ts'), 'utf8');
    for (const needle of ['display.codeExtras', 'display.codeCopy', 'builtin.hljs', 'builtin.math', 'display.imageZoom', 'display.csvTable', 'hint-text-card', 'rail-preview']) {
      expect(src, needle).not.toContain(needle);
    }
  });
});
describe('W9108 ⑦ 内置增强遍（代码高亮 / 数学）也是可开关的客户端插件', () => {
  interface EnhanceMod { enhancerIds(): readonly string[]; runEnhancers(c: ElLike): void }

  function codeBlock(): { box: ElLike; code: ElLike } {
    const box = doc.createElement('div');
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    code.className = 'language-typescript';
    code.textContent = 'const a = 1;';
    pre.appendChild(code);
    box.appendChild(pre);
    return { box, code };
  }

  it('关掉代码高亮 ⇒ 代码块保持原样（没有 hljs 标记）；重开恢复', async () => {
    await openPlugins();
    const enhance = (await import(/* @vite-ignore */ at('ui/enhance/index.ts'))) as EnhanceMod;
    const on = codeBlock();
    enhance.runEnhancers(on.box);
    expect(on.code.querySelectorAll('.hljs-keyword').length).toBeGreaterThan(0);

    const sw = q('#settingsPlugins .plug-row[data-id="builtin.hljs"] .plug-switch-input') as InputLike;
    sw.checked = false;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    expect(enhance.enhancerIds()).not.toContain('builtin.hljs');

    const off = codeBlock();
    enhance.runEnhancers(off.box);
    expect(off.code.querySelectorAll('.hljs-keyword').length).toBe(0);
    expect(off.code.textContent).toBe('const a = 1;'); // 原文逐字不变

    sw.checked = true;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    expect(enhance.enhancerIds()).toContain('builtin.hljs');
  });

  it('关掉数学增强 ⇒ 占位如实保持原样（不升级、不显示成坏公式）', async () => {
    await openPlugins();
    const enhance = (await import(/* @vite-ignore */ at('ui/enhance/index.ts'))) as EnhanceMod;
    const sw = q('#settingsPlugins .plug-row[data-id="builtin.math"] .plug-switch-input') as InputLike;
    sw.checked = false;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    expect(enhance.enhancerIds()).not.toContain('builtin.math');

    const box = doc.createElement('div');
    const span = doc.createElement('span');
    span.className = 'math-inline';
    span.textContent = 'x^2';
    box.appendChild(span);
    enhance.runEnhancers(box);
    await flush();
    expect(span.textContent).toBe('x^2'); // 原样保留
    expect(span.querySelectorAll('*').length).toBe(0); // 没有被升级成 MathML
    expect(span.classList.contains('math-done')).toBe(false);

    sw.checked = true;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    expect(enhance.enhancerIds()).toContain('builtin.math');
  });

  it('关掉再打开高亮后，顺序不变量仍然成立（hljs 先于 code-extras）', async () => {
    await openPlugins();
    const enhance = (await import(/* @vite-ignore */ at('ui/enhance/index.ts'))) as EnhanceMod;
    const sw = q('#settingsPlugins .plug-row[data-id="builtin.hljs"] .plug-switch-input') as InputLike;
    sw.checked = false;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    sw.checked = true;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    const ids = enhance.enhancerIds();
    // ★ 这是「重新注册必然排在最后」的回归守卫：没有 order 常量时这条会红，
    //   而行号会被 hljs 的 innerHTML 整体替换静默抹掉。
    expect(ids.indexOf('builtin.hljs')).toBeLessThan(ids.indexOf('display.codeExtras'));
    expect(ids.indexOf('builtin.hljs')).toBeLessThan(ids.indexOf('builtin.math'));
  });

  it('持久化：关掉内置高亮后重开页面仍为关（走的是同一张启用表）', async () => {
    await openPlugins();
    const sw = q('#settingsPlugins .plug-row[data-id="builtin.hljs"] .plug-switch-input') as InputLike;
    sw.checked = false;
    sw.dispatchEvent(new Ev('change'));
    await flush();
    expect(server.disabled).toContain('builtin.hljs');

    resetHarness();
    stubServer();
    (doc.body as ElLike & { insertAdjacentHTML(p: string, h: string): void }).insertAdjacentHTML('beforeend', appMarkup());
    await openPlugins();
    expect((q('#settingsPlugins .plug-row[data-id="builtin.hljs"] .plug-switch-input') as InputLike).checked).toBe(false);
    const enhance = (await import(/* @vite-ignore */ at('ui/enhance/index.ts'))) as EnhanceMod;
    expect(enhance.enhancerIds()).not.toContain('builtin.hljs');
  });
});
