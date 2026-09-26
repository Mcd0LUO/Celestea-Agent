// @vitest-environment jsdom
/**
 * W9202 · 「配置与提供商页」修复的聚焦测试。
 *
 * 三组不变量，对应本轮三条修复：
 *   ① 通用配置页的 system_prompt **只在用户真的改过时才提交**（与 max_retries 同构）。
 *      未改 ⇒ patch 不含该键；改过 ⇒ 带新值；清空 ⇒ 带 ''（后端据此清除覆盖）。
 *   ② 「获取模型」用**身份 id**（originalId），不是显示名 —— name != id 的 provider
 *      也必须打到 /api/providers/<id>/models/fetch。
 *   ③ 插件配置缝：defaultOf 对 enum/number 也做域校验（控件显示的 = 能存下去的）；
 *      effectiveConfig 复用 parseConfigValues（不再是无人调用的死代码）；
 *      同一 item.key 在两个插件里不会撞 DOM id。
 *
 * 每个 describe 都有一条可在 results/W9202-修复.md 里复现的变异负控制。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, type ElLike } from './lib/w795-dom.js';

interface InputLike extends ElLike {
  checked: boolean;
  rows: number;
}
interface Mod {
  renderConfigSpec(spec: unknown, values: Record<string, string>, onChange: (k: string, v: string) => void): ElLike;
}
interface CfgMod {
  loadConfig(opts?: { refresh?: boolean }): Promise<void>;
  initSettingsPage(): void;
}
/** 一个模型行的推理档位片（回归钉 ④ 需要读它的回填结果）。 */
interface EffortChipsLike {
  root: ElLike;
  values(): string[];
}
/** buildProviderForm 的返回（**唯一**声明处）。
 *
 * W9202 更正：此前这里只声明 `{ root }`，④ 又用 `FormMod & { buildProviderForm(...): { rows } }`
 * 想补上 rows —— 两个调用签名相交时 TS 取**重载交集**，`refs.rows` 仍不可见（tsc TS2339）。
 * 现在把完整形状写在**这一处**，调用点只用 `FormMod`，不再有第二份签名。 */
interface FormRefs {
  root: ElLike;
  rows: Array<{ efforts: EffortChipsLike }>;
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): FormRefs;
}
interface PluginCfgMod {
  defaultOf(item: unknown): string;
  effectiveConfig(spec: unknown, saved: Record<string, string> | undefined): Record<string, string>;
  normalizeItem(item: unknown, raw: string): string;
}

const q = (s: string): ElLike | null => doc.querySelector(s);
const qa = (s: string): ElLike[] => Array.from(doc.querySelectorAll(s));
const reply = (status: number, payload: unknown): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const btnWith = (root: ElLike, text: string): ElLike => {
  const b = Array.from(root.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(text));
  if (b === undefined) throw new Error('button missing: ' + text);
  return b;
};

// ---- ① system_prompt 只在改过时才提交 ------------------------------------------

/** 设置页全部宿主（与 index.html 的 id/class 一致；ui/config.ts 的 need() 要求它们都在）。 */
const SETTINGS_HTML =
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

const CONFIG_BODY = {
  model: 'deepseek-flash',
  base_url: 'http://x/v1',
  max_steps: 4096,
  context_window: 1000000,
  reasoning_effort: null,
  max_output_tokens: null,
  max_retries: 1,
  system_prompt: 'ASSEMBLED-PROMPT',
  available: { models: [{ id: 'deepseek-flash', name: 'Flash' }], efforts: ['low', 'high'] },
};

let lastPatch: Record<string, unknown> | null = null;

function stubConfig(): void {
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (u.startsWith('/api/config')) {
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        lastPatch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return Promise.resolve(reply(200, { ok: true, ...CONFIG_BODY }));
      }
      return Promise.resolve(reply(200, CONFIG_BODY));
    }
    if (u.startsWith('/api/status')) return Promise.resolve(reply(200, { model: 'deepseek-flash' }));
    return Promise.resolve(reply(404, { ok: false }));
  });
}

/** 系统提示词 textarea（字段标签为「系统提示词」）。 */
function sysArea(): InputLike | null {
  for (const row of qa('#settingsConfig .cfg-field')) {
    if (row.querySelector('.cfg-label')?.textContent === '系统提示词') return row.querySelector('textarea') as InputLike;
  }
  return null;
}
const saveBtn = (): ElLike => q('#settingsConfig .cfg-actions button') as ElLike;

async function bootConfig(): Promise<void> {
  vi.resetModules();
  lastPatch = null;
  doc.body.innerHTML = SETTINGS_HTML;
  stubConfig();
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as { setLocale(l: string): void };
  i18n.setLocale('zh');
  const cfg = (await import(/* @vite-ignore */ at('ui/config.ts'))) as CfgMod;
  cfg.initSettingsPage();
  await cfg.loadConfig({ refresh: true });
}

describe('W9202 ① system_prompt 只在改过时才提交（保存不得钉死动态组装的提示词）', () => {
  beforeEach(async () => { await bootConfig(); });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('没改过 ⇒ patch 不含 system_prompt（与 max_retries 同一口径）', async () => {
    expect(sysArea()?.value, '表单初值 = 服务端组装结果').toBe('ASSEMBLED-PROMPT');
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch).not.toBeNull();
    expect('system_prompt' in lastPatch!, '未改不得回传：否则后端把它钉成内存覆盖值').toBe(false);
    expect('max_retries' in lastPatch!, '同批口径：未改也不带').toBe(false);
  });

  it('改过 ⇒ patch 带新值', async () => {
    (sysArea() as InputLike).value = 'MY OWN PROMPT';
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch?.['system_prompt']).toBe('MY OWN PROMPT');
  });

  it('清空 ⇒ patch 带空串（后端据此清除覆盖，回落注册表组装）', async () => {
    (sysArea() as InputLike).value = '';
    saveBtn().dispatchEvent(new Ev('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(lastPatch?.['system_prompt'], '空串必须真的发出去').toBe('');
  });
});

// ---- ② 「获取模型」用身份 id，不用显示名 ----------------------------------------

const PROV_HTML =
  '<div id="settingsPage"><section class="settings-pane" data-pane="providers">' +
  '<div id="settingsProviders"></div></section></div>';

let calledUrls: string[] = [];

function stubProviders(): void {
  vi.stubGlobal('fetch', (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calledUrls.push(method + ' ' + u);
    if (u.endsWith('/models/fetch')) return Promise.resolve(reply(200, { ok: true, models: [{ id: 'm-new' }] }));
    if (u.startsWith('/api/providers') && method === 'POST') return Promise.resolve(reply(200, { ok: true, id: 'p1' }));
    return Promise.resolve(reply(404, { ok: false, error: 'not stubbed' }));
  });
}

describe('W9202 ② 「获取模型」必须用身份 id（name 只是显示名）', () => {
  beforeEach(() => {
    vi.resetModules();
    calledUrls = [];
    doc.body.innerHTML = PROV_HTML;
    stubProviders();
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('name != id 的既有 provider ⇒ 打到 /api/providers/<id>/models/fetch', async () => {
    const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
    const refs = form.buildProviderForm(
      {
        id: 'celestea-id',
        name: 'Gateway 显示名',
        note: '',
        base_url: 'https://example.com/v1',
        request_format: 'chat_completions',
        models: [],
      },
      { onSaved: () => {}, onCancel: () => {} },
    );
    btnWith(refs.root, '获取模型').dispatchEvent(new Ev('click', { bubbles: true }));
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    const fetchCall = calledUrls.find((c) => c.includes('/models/fetch'));
    expect(fetchCall, '必须发出取模型请求').toBeDefined();
    expect(fetchCall).toContain('/api/providers/celestea-id/models/fetch');
    expect(fetchCall, '显示名不得出现在 URL 里').not.toContain('Gateway');
  });
});

// ---- ③ 插件配置缝：默认值域校验 / 读路径归一化 / id 唯一 ------------------------

const ENUM_SPEC = {
  items: [{
    kind: 'enum', key: 'e', labelKey: 'plugins.desc.math.label', def: 'not-in-options',
    options: [{ value: 'a', labelKey: 'plugins.desc.hljs.label' }, { value: 'b', labelKey: 'plugins.desc.math.label' }],
  }],
};
const NUM_SPEC = {
  items: [{ kind: 'number', key: 'n', labelKey: 'plugins.desc.math.label', def: 9999, min: 5, max: 500, step: 5 }],
};
const MIX_SPEC = {
  items: [{ kind: 'number', key: 'n', labelKey: 'plugins.desc.math.label', def: 30, min: 5, max: 500 }],
};

describe('W9202 ③ 插件配置缝（闭集类型的域校验与读路径归一化）', () => {
  beforeEach(() => { vi.resetModules(); doc.body.replaceChildren(); });
  afterEach(() => { doc.body.replaceChildren(); });

  it('enum 的 def 不在 options 里 ⇒ 回落第一项（控件显示的值一定能存下去）', async () => {
    const cfg = (await import(/* @vite-ignore */ at('plugins/config.ts'))) as PluginCfgMod;
    expect(cfg.defaultOf(ENUM_SPEC.items[0])).toBe('a');
    expect(cfg.normalizeItem(ENUM_SPEC.items[0], 'b')).toBe('b');
  });

  it('number 的 def 越界 ⇒ 夹进描述区间（与 normalizeItem 同一把尺子）', async () => {
    const cfg = (await import(/* @vite-ignore */ at('plugins/config.ts'))) as PluginCfgMod;
    expect(cfg.defaultOf(NUM_SPEC.items[0])).toBe('500');
  });

  it('effectiveConfig 走 parseConfigValues：越界/未知/坏类型一律收口', async () => {
    const cfg = (await import(/* @vite-ignore */ at('plugins/config.ts'))) as PluginCfgMod;
    expect(cfg.effectiveConfig(MIX_SPEC, { n: '99999' }), '越界被夹到 max').toEqual({ n: '500' });
    expect(cfg.effectiveConfig(MIX_SPEC, { n: '3' }), '越界被夹到 min').toEqual({ n: '5' });
    expect(cfg.effectiveConfig(MIX_SPEC, { n: 'not-a-number' }), '非数字回落默认').toEqual({ n: '30' });
    expect(cfg.effectiveConfig(MIX_SPEC, { unknown: 'x' }), '不认识的键不得出现在生效值里').toEqual({ n: '30' });
    expect(cfg.effectiveConfig(MIX_SPEC, undefined), '没配过 = 全默认').toEqual({ n: '30' });
  });

  it('同一 item.key 出现在两个插件面板 ⇒ 控件 id 不撞车、label 各指各的', async () => {
    const mod = (await import(/* @vite-ignore */ at('ui/plugins/config-panel.ts'))) as Mod;
    const spec = { items: [{ kind: 'text', key: 'shared', labelKey: 'plugins.desc.math.label', def: 'x' }] };
    const a = mod.renderConfigSpec(spec, {}, () => undefined);
    const b = mod.renderConfigSpec(spec, {}, () => undefined);
    doc.body.appendChild(a);
    doc.body.appendChild(b);
    const idA = a.querySelector('.plug-cfg-text')?.id ?? '';
    const idB = b.querySelector('.plug-cfg-text')?.id ?? '';
    expect(idA).not.toBe('');
    expect(idB, '两个面板的控件 id 必须不同').not.toBe(idA);
    expect(a.querySelector('.plug-cfg-label')?.getAttribute('for')).toBe(idA);
    expect(b.querySelector('.plug-cfg-label')?.getAttribute('for')).toBe(idB);
    expect(qa('.plug-cfg-text').length).toBe(2);
  });
});

// ---- ④ P1-1 的真实行为回归钉（把「API 到底会返回什么」写死） --------------------

describe('W9202 ④ 推理档位的真实 API 形状（乐观默认在生产路径不可达）', () => {
  beforeEach(() => { vi.resetModules(); doc.body.innerHTML = PROV_HTML; });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); });

  it('public view 的 reasoning_efforts 永远是数组 ⇒ [] 回填出零片（不是三片）', async () => {
    const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
    // 这就是后端 store/providers.ts 的 public view 真实形状：缺失的键被归一成 []。
    // 旧注释声称「缺失 ⇒ undefined ⇒ 三片全选」，但 ProviderModel.reasoning_efforts 是必填
    // string[]，view() 又写死 [...m.reasoning_efforts] —— undefined 这一态从不出现。
    const refs = form.buildProviderForm(
      {
        id: 'p1', name: 'p1', note: '', base_url: 'https://example.com/v1',
        request_format: 'chat_completions',
        models: [{ id: 'legacy', name: 'legacy', reasoning_efforts: [] }],
      },
      { onSaved: () => {}, onCancel: () => {} },
    );
    const row = refs.rows[0]!;
    expect(row.efforts.values(), '[] = 该模型不支持推理（后端 isReasoningCapable 判 length>0）').toEqual([]);
    expect(Array.from(row.efforts.root.querySelectorAll('.prov-effort-chip')).length, '零片是当前真实行为').toBe(0);
  });
});

