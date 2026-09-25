// @vitest-environment jsdom
/**
 * W1536 · 表单集成：能力位回填 → 编辑 → 保存载荷 → 读回（跑真实 buildProviderForm）。
 *
 * 与 w1536-provider-modalities.test.ts 的分工：那个测多选组本身，这个测**表单接线**：
 *   ① 新建模型行：未触碰 ⇒ 保存 body 里**没有** input_modalities / output_modalities
 *      （旧行为逐字不变，providers.json 不会被无故加上这两个键）；
 *   ② 编辑既有模型：点掉 image ⇒ body 里 input_modalities === ["text"]；
 *   ③ 读回：把服务端存下的同一份模型对象再喂给表单 ⇒ 勾选状态保持（真机验收同款断言）；
 *   ④ 服务端把空数组归一成 absent 的边界，在组件层已被拦住（见另一文件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ModalityGroup {
  root: ElLike;
  set(values: readonly string[] | undefined): void;
  values(): string[] | undefined;
}
interface ModelRowHandle {
  id: ElLike;
  name: ElLike;
  inputModalities: ModalityGroup;
  outputModalities: ModalityGroup;
}
interface EditorRefs {
  root: ElLike;
  rows: ModelRowHandle[];
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): EditorRefs;
}
interface I18nMod {
  setLocale(l: string): void;
}

/** state.ts 在 import 期 need('#settingsProviders')，宿主必须在位。 */
const HTML =
  '<div id="settingsPage"><section class="settings-pane" data-pane="providers">' +
  '<div id="settingsProviders"></div></section></div>';

const posts: string[] = [];

const jsonReply = (status: number, payload: unknown): unknown => ({
  ok: status < 300,
  status,
  json: async () => payload,
});

function stubSave(): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: unknown; method?: string }) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.startsWith('/api/providers') && method === 'POST') {
      posts.push(init?.body === undefined ? '' : String(init.body));
      return jsonReply(200, { ok: true, id: 'p1' });
    }
    return jsonReply(404, { ok: false, error: 'not stubbed' });
  });
}

/** 用「服务端读回的模型清单」建表单（走真实回填路径）。 */
async function boot(models: unknown[]): Promise<EditorRefs> {
  const form = (await import(/* @vite-ignore */ at('ui/providers/form.ts'))) as FormMod;
  return form.buildProviderForm(
    {
      id: 'p1',
      name: 'p1',
      note: '',
      base_url: 'https://example.com/v1',
      request_format: 'chat_completions',
      models,
    },
    { onSaved: () => {}, onCancel: () => {} },
  );
}

const chip = (root: ElLike, id: string): ElLike => {
  const n = root.querySelector('[data-modality="' + id + '"]');
  if (n === null) throw new Error('chip missing: ' + id);
  return n;
};
const saveBtn = (refs: EditorRefs): ElLike => {
  const btns = Array.from(refs.root.querySelectorAll('button'));
  const b = btns.find((x) => (x.textContent ?? '').includes('保存'));
  if (b === undefined) throw new Error('save button missing');
  return b;
};
const bodyOf = (i: number): Record<string, unknown> =>
  JSON.parse(posts[i] ?? '{}') as Record<string, unknown>;
const modelsOf = (i: number): Array<Record<string, unknown>> =>
  (bodyOf(i)['models'] ?? []) as Array<Record<string, unknown>>;

describe('W1536 · 提供商表单的输入/输出类型接线', () => {
  beforeEach(async () => {
    resetHarness();
    doc.body.innerHTML = HTML;
    posts.length = 0;
    stubSave();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('未触碰能力位 ⇒ 保存 body 不带这两个键（旧行为逐字不变）', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1' }]);
    saveBtn(refs).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    const m = modelsOf(0)[0] ?? {};
    expect('input_modalities' in m, '缺省 = 乐观默认，不写盘').toBe(false);
    expect('output_modalities' in m).toBe(false);
  });

  it('点掉 image ⇒ body 的 input_modalities 恰为 ["text"]', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1' }]);
    const row = refs.rows[0]!;
    expect(chip(row.inputModalities.root, 'image').getAttribute('aria-pressed')).toBe('true');
    chip(row.inputModalities.root, 'image').click();
    saveBtn(refs).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    const m = modelsOf(0)[0] ?? {};
    expect(m['input_modalities']).toEqual(['text']);
    expect('output_modalities' in m, '输出类型没动过 ⇒ 仍缺省').toBe(false);
  });

  it('读回：服务端存下的 ["text"] 再喂给表单 ⇒ 勾选状态保持', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1', input_modalities: ['text'] }]);
    const row = refs.rows[0]!;
    expect(chip(row.inputModalities.root, 'text').getAttribute('aria-pressed')).toBe('true');
    expect(chip(row.inputModalities.root, 'image').getAttribute('aria-pressed'), '读回不得回弹成乐观默认').toBe('false');
    expect(row.inputModalities.values()).toEqual(['text']);
    // 再存一次：值原样往返（幂等）
    saveBtn(refs).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(modelsOf(0)[0]?.['input_modalities']).toEqual(['text']);
  });

  it('输出类型独立于输入类型（可各自配置）', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1', output_modalities: ['text'] }]);
    const row = refs.rows[0]!;
    chip(row.outputModalities.root, 'image').click();
    saveBtn(refs).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    const m = modelsOf(0)[0] ?? {};
    expect(m['output_modalities']).toEqual(['text', 'image']);
    expect('input_modalities' in m).toBe(false);
  });
});
