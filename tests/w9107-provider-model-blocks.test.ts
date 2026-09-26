// @vitest-environment jsdom
/**
 * W9107 · 提供商表单「模型块分隔线 + 推理强度可删/默认勾选」集成测试。
 *
 * 跑真实 buildProviderForm（不是复刻逻辑），钉住四条：
 *   ① 相邻模型块之间有分隔节点、最后一个之后没有（增行/删行都重排）；
 *   ② 点档位片右上角「×」⇒ 该片消失且 values() 不再含它（销毁，不是取消勾选）；
 *   ③ 出现的档位片**一律** `.on`（没有「不勾选」态）；
 *   ④ 「缺省（未配置）」与「显式空数组」的回填结果不同 —— 前者三片全选（乐观默认），
 *      后者一片不留（= 该模型不支持推理，后端契约语义）；保存往返各自保持。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, Ev, resetHarness, type ElLike } from './lib/w795-dom.js';

interface EffortChips {
  root: ElLike;
  set(values: readonly string[] | undefined): void;
  values(): string[];
}
interface ModelRowHandle {
  id: ElLike;
  name: ElLike;
  efforts: EffortChips;
  li: ElLike;
}
interface EditorRefs {
  root: ElLike;
  modelsBox: ElLike;
  rows: ModelRowHandle[];
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): EditorRefs;
}
interface I18nMod {
  setLocale(l: string): void;
}
/** 兄弟节点遍历（jsdom 有这两个属性，共用夹具的 ElLike 未声明 —— 本地补类型，不动共享夹具）。 */
type Sibling = ElLike & { previousElementSibling: ElLike | null; nextElementSibling: ElLike | null };
const sib = (n: ElLike): Sibling => n as unknown as Sibling;

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

const rows = (refs: EditorRefs): ElLike[] =>
  Array.from(refs.modelsBox.querySelectorAll('.prov-model-row'));
const dividers = (refs: EditorRefs): ElLike[] =>
  Array.from(refs.modelsBox.querySelectorAll('.prov-model-div'));
/** 一枚档位片（按展示值）。 */
const chipOf = (row: ModelRowHandle, tier: string): ElLike | null =>
  row.efforts.root.querySelector('[data-effort="' + tier + '"]');
const chips = (row: ModelRowHandle): ElLike[] =>
  Array.from(row.efforts.root.querySelectorAll('.prov-effort-chip'));
const killOf = (chip: ElLike): ElLike => {
  const k = chip.querySelector('.prov-effort-kill');
  if (k === null) throw new Error('kill button missing');
  return k;
};
const btnWith = (root: ElLike, text: string): ElLike => {
  const b = Array.from(root.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes(text));
  if (b === undefined) throw new Error('button missing: ' + text);
  return b;
};
const saveBtn = (refs: EditorRefs): ElLike => btnWith(refs.root, '保存');
const addModelBtn = (refs: EditorRefs): ElLike => btnWith(refs.root, '添加模型');
const removeRowBtn = (row: ModelRowHandle): ElLike => btnWith(row.li, '移除');
const modelsOf = (i: number): Array<Record<string, unknown>> =>
  ((JSON.parse(posts[i] ?? '{}') as Record<string, unknown>)['models'] ?? []) as Array<
    Record<string, unknown>
  >;

function bootHarness(): Promise<void> {
  resetHarness();
  doc.body.innerHTML = HTML;
  posts.length = 0;
  stubSave();
  return Promise.resolve();
}

describe('W9107 · 模型块分隔线', () => {
  beforeEach(async () => {
    await bootHarness();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('① 相邻模型块之间有分隔节点，最后一个之后没有', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }, { id: 'm3', name: 'm3' }]);
    const rs = rows(refs);
    expect(rs).toHaveLength(3);
    expect(dividers(refs), '3 个模型块 ⇒ 2 条分隔线').toHaveLength(2);
    // 每条线都紧贴在「非首行」之前（= 相邻行之间）
    for (let i = 1; i < rs.length; i++) {
      expect(sib(rs[i]!).previousElementSibling?.className ?? '').toContain('prov-model-div');
    }
    // 首行之前没有线、末行之后没有线
    expect(sib(rs[0]!).previousElementSibling).toBeNull();
    expect(sib(rs[2]!).nextElementSibling, '最后一个模型块之后不画').toBeNull();
  });

  it('① 增行/删行后重排：数量 = 行数 − 1，末行之后始终无线', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1' }]);
    expect(dividers(refs)).toHaveLength(0);
    addModelBtn(refs).click();
    expect(rows(refs)).toHaveLength(2);
    expect(dividers(refs)).toHaveLength(1);
    addModelBtn(refs).click();
    expect(rows(refs)).toHaveLength(3);
    expect(dividers(refs)).toHaveLength(2);
    removeRowBtn(refs.rows[2]!).click();
    expect(rows(refs)).toHaveLength(2);
    expect(dividers(refs)).toHaveLength(1);
    expect(sib(rows(refs)[1]!).nextElementSibling, '删掉末行后新末行之后无线').toBeNull();
    removeRowBtn(refs.rows[1]!).click();
    expect(rows(refs)).toHaveLength(1);
    expect(dividers(refs)).toHaveLength(0);
  });
});

describe('W9107 · 推理强度：× 销毁 / 一律勾选 / 缺省 vs 空数组', () => {
  beforeEach(async () => {
    await bootHarness();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('④ 缺省（未配置）⇒ 三片全选；显式空数组 ⇒ 一片不留', async () => {
    const absent = await boot([{ id: 'm1', name: 'm1' }]);
    const rowAbsent = absent.rows[0]!;
    expect(rowAbsent.efforts.values()).toEqual(['low', 'high', 'max']);
    expect(chips(rowAbsent)).toHaveLength(3);

    const empty = await boot([{ id: 'm2', name: 'm2', reasoning_efforts: [] }]);
    const rowEmpty = empty.rows[0]!;
    expect(chips(rowEmpty), '显式空数组 = 不支持推理 ⇒ 不显示任何片').toHaveLength(0);
    expect(rowEmpty.efforts.values()).toEqual([]);
  });

  it('③ 出现的档位片一律 .on / aria-pressed=true（没有不勾选态）', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1' }]);
    const row = refs.rows[0]!;
    const cs = chips(row);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect(c.classList.contains('on'), (c.dataset['effort'] ?? '') + ' 必须选中').toBe(true);
      expect(c.getAttribute('aria-pressed')).toBe('true');
    }
    // 点片本体不再切状态（改集合只有 × 与 + 两条路）
    cs[0]!.click();
    expect(row.efforts.values()).toEqual(['low', 'high', 'max']);
  });

  it('② 点「×」⇒ 该片消失且 values() 不含它；固定三档也能删、可经「+」加回', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1', reasoning_efforts: ['low', 'high', 'max'] }]);
    const row = refs.rows[0]!;
    killOf(chipOf(row, 'high')!).click();
    expect(chipOf(row, 'high'), '片被销毁（不是取消勾选）').toBeNull();
    expect(row.efforts.values()).toEqual(['low', 'max']);

    killOf(chipOf(row, 'low')!).click();
    killOf(chipOf(row, 'max')!).click();
    expect(chips(row)).toHaveLength(0);
    expect(row.efforts.values()).toEqual([]);

    // 「+」加回同名档位 ⇒ 自动选中
    btnWith(row.efforts.root, '+').click();
    const input = row.efforts.root.querySelector('input');
    if (input === null) throw new Error('tier input missing');
    input.value = 'low';
    input.dispatchEvent(new Ev('blur')); // 失焦即提交
    expect(row.efforts.values()).toEqual(['low']);
    expect(chipOf(row, 'low')?.classList.contains('on')).toBe(true);
  });

  it('② 再次回填（保存后重开面板）⇒ × 删掉的片不再复活', async () => {
    const refs = await boot([{ id: 'm1', name: 'm1', reasoning_efforts: ['low', 'high', 'max'] }]);
    const row = refs.rows[0]!;
    killOf(chipOf(row, 'high')!).click();
    expect(row.efforts.values()).toEqual(['low', 'max']);
    // 服务端存下的就是删完的集合 ⇒ 再喂回来（= 重新打开编辑面板）不得把 high 补回来
    row.efforts.set(['low', 'max']);
    expect(chips(row)).toHaveLength(2);
    expect(chipOf(row, 'high')).toBeNull();
    expect(row.efforts.values()).toEqual(['low', 'max']);
    // 反向：显式空数组回填 ⇒ 清空已有片
    row.efforts.set([]);
    expect(chips(row)).toHaveLength(0);
    expect(row.efforts.values()).toEqual([]);
  });

  it('保存往返：× 删掉的档位不会复活；显式空数组原样写盘', async () => {
    const refs = await boot([
      { id: 'm1', name: 'm1', reasoning_efforts: ['low', 'high', 'max'] },
      { id: 'm2', name: 'm2', reasoning_efforts: [] },
    ]);
    killOf(chipOf(refs.rows[0]!, 'high')!).click();
    saveBtn(refs).click();
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect(modelsOf(0)[0]?.['reasoning_efforts']).toEqual(['low', 'max']);
    expect(modelsOf(0)[1]?.['reasoning_efforts'], '显式空数组必须原样保留').toEqual([]);
  });
});
