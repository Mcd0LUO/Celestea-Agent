// @vitest-environment jsdom
/**
 * W1536 · 提供商编辑「模型输入 / 输出类型」（用户点名：要能选它是否支持文字图片）。
 *
 * 语义真源（W804 + providers.schema.json）：**缺省 = 乐观默认**
 * （输入 [text,image] / 输出 [text]），此时 providers.json 里不写这两个键；
 * 用户改动 ⇒ 变显式配置并写盘 —— 显式配置是关掉图片入口的唯一途径。
 *
 * 本文件覆盖四件事（全部跑**真实生产代码**，不复刻逻辑）：
 *   ① 回填：absent = 乐观默认态（勾 text+image、标 is-default、说明文案在）；
 *   ② 载荷：未触碰 ⇒ **不带**这两个键（保持缺省，旧行为逐字不变）；
 *   ③ 勾选：点掉 image ⇒ POST /api/providers 的 body 里 input_modalities = ["text"]；
 *   ④ 读回：把服务端存下的模型对象再喂给表单 ⇒ 勾选状态与「显式」标记都保持。
 * 另有空集守卫（后端把空数组归一成 absent，允许清空会静默变回默认）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness, type ElLike } from './lib/w795-dom.js';

interface ModalityGroup {
  root: ElLike;
  set(values: readonly string[] | undefined): void;
  values(): string[] | undefined;
}
interface ModalitiesMod {
  addModalityGroup(
    label: string,
    options: readonly string[],
    defaults: readonly string[],
    onLayout?: () => void,
  ): ModalityGroup;
}
interface ModelRowHandle {
  id: ElLike;
  inputModalities: ModalityGroup;
  outputModalities: ModalityGroup;
}
interface FormMod {
  buildProviderForm(p: unknown, hooks: unknown): { root: ElLike; rows: ModelRowHandle[] };
}
interface I18nMod {
  setLocale(l: string): void;
}

const OPTIONS = ['text', 'image', 'audio'] as const;
const INPUT_DEFAULT = ['text', 'image'] as const;
const posts: string[] = [];

const jsonReply = (status: number, payload: unknown): unknown => ({
  ok: status < 300,
  status,
  json: async () => payload,
});

/** 只打桩 POST /api/providers（保存）；其余一律 404，便于断言「真的没打别的口」。 */
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

async function makeGroup(values?: readonly string[]): Promise<ModalityGroup> {
  const mod = (await import(/* @vite-ignore */ at('ui/providers/modalities.ts'))) as ModalitiesMod;
  const g = mod.addModalityGroup('输入类型', OPTIONS, INPUT_DEFAULT);
  g.set(values);
  doc.body.appendChild(g.root);
  return g;
}

const chip = (root: ElLike, id: string): ElLike => {
  const n = root.querySelector('[data-modality="' + id + '"]');
  if (n === null) throw new Error('chip missing: ' + id);
  return n;
};
const isOn = (root: ElLike, id: string): boolean =>
  chip(root, id).getAttribute('aria-pressed') === 'true';

describe('W1536 · 模型输入/输出类型多选', () => {
  beforeEach(async () => {
    resetHarness();
    posts.length = 0;
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    doc.body.replaceChildren();
  });

  it('回填 absent = 乐观默认：勾 text+image、标 is-default、说明文案在', async () => {
    const g = await makeGroup(undefined);
    expect(isOn(g.root, 'text')).toBe(true);
    expect(isOn(g.root, 'image')).toBe(true);
    expect(isOn(g.root, 'audio')).toBe(false);
    expect(g.root.classList.contains('is-default'), '乐观默认态要可辨').toBe(true);
    expect(g.root.querySelector('.prov-modality-note')?.hidden).toBe(false);
    expect(g.values(), '未触碰 ⇒ 不带键').toBeUndefined();
  });

  it('显式配置回填：只勾 text ⇒ 非默认态、image 明确「不支持」', async () => {
    const g = await makeGroup(['text']);
    expect(isOn(g.root, 'text')).toBe(true);
    expect(isOn(g.root, 'image'), '显式排除图片必须看得见').toBe(false);
    expect(g.root.classList.contains('is-default')).toBe(false);
    expect(g.values()).toEqual(['text']);
  });

  it('非标准类型（存量配置）补片显示、原样往返，不被吞掉', async () => {
    const g = await makeGroup(['text', 'video']);
    expect(isOn(g.root, 'video'), '存量未知类型必须看得见（补一枚片）').toBe(true);
    expect(isOn(g.root, 'image')).toBe(false);
    expect(g.values(), '未知项不得被静默丢弃').toEqual(['text', 'video']);
    chip(g.root, 'video').click(); // 且能改
    expect(g.values()).toEqual(['text']);
  });

  it('点击脱离乐观默认：点掉 image ⇒ ["text"]，再点回 ⇒ 仍是显式', async () => {
    const g = await makeGroup(undefined);
    chip(g.root, 'image').click();
    expect(g.values()).toEqual(['text']);
    expect(g.root.classList.contains('is-default')).toBe(false);
    chip(g.root, 'image').click();
    expect(g.values(), '与默认同值也必须保持显式').toEqual(['text', 'image']);
    expect(g.root.classList.contains('is-default')).toBe(false);
  });

  it('空集被拦住：至少留一项（后端会把空数组归一成缺省）', async () => {
    const g = await makeGroup(['text']);
    chip(g.root, 'text').click();
    expect(g.values(), '不许清空').toEqual(['text']);
    expect(g.root.querySelector('.prov-modality-note')?.textContent).toContain('至少');
  });
});
