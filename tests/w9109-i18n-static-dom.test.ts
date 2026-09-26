// @vitest-environment jsdom
/**
 * W9109 · index.html 静态 DOM 的 i18n 收口。
 *
 * 背景（用户报障「英文状态下仍有残留中文，主要集中在设置页面」）：
 *   静态骨架 index.html 里写死了大量中文，只有 11 个 data-i18n* 属性 —— 门禁
 *   apps/web/tools/check-ui-copy.mjs 的护栏 A 只扫 apps/web/src/** 的字符串字面量，
 *   **不含 .html**，于是静态骨架里的中文完全逃过「必须走 i18n」的机械检查。
 *
 * 本文件把两件事变成机械断言（都不手写清单，直接从真实 index.html 派生）：
 *   ① index.html 上出现的**每一个** data-i18n* key 在 zh 与 en 字典里都存在且非空；
 *   ② 切到 en 后，整棵静态 DOM（含设置页各 pane）的**可见文本节点**与
 *      title / placeholder / aria-label **不含 CJK**。
 *
 * ② 刻意遍历**整棵** DOM 而不是只查设置页：设置页是用户点名的重灾区，但同一批
 * 硬编码中文也散在顶栏 / statusline / statusbar 里（本次一并迁移），断言写窄了会漏。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface I18nMod {
  setLocale(l: string): void;
  getLocale(): string;
  t(key: string, params?: Record<string, string | number>): string;
  localeDict(l: string): Record<string, string>;
}
interface SettingsMod { installI18nSettings(): void }

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, '..', 'apps', 'web', 'index.html');
const CJK = /[\u3400-\u9fff]/;

/** 从真实 index.html 取 <body> 内容（脚本是 type=module，innerHTML 不会执行它）。 */
function bodyOf(html: string): string {
  const m = /<body>([\s\S]*)<\/body>/.exec(html);
  if (!m || m[1] === undefined) throw new Error('index.html 里找不到 <body>…</body>');
  return m[1];
}

// ---- 结构类型（根 tsconfig 的 lib 没有 DOM，与既有 jsdom 测试同一约定） ----
interface DomClassList { contains(c: string): boolean }
interface DomElement {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<DomElement>;
  parentElement: DomElement | null;
  tagName: string;
  classList: DomClassList;
  getAttribute(n: string): string | null;
  querySelectorAll(sel: string): ArrayLike<DomElement>;
}
interface DomQuery {
  querySelectorAll(sel: string): ArrayLike<DomElement>;
}
const root = doc as unknown as DomQuery & { body: DomElement };
const all = (sel: string): DomElement[] => Array.from(root.querySelectorAll(sel));

/** 可见性：祖先链上没有 .hidden、没有 aria-hidden="true"（jsdom 不跑样式表）。 */
function visible(el: DomElement | null): boolean {
  let n = el;
  while (n) {
    if (n.classList.contains('hidden')) return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
    n = n.parentElement;
  }
  return true;
}

/** 机械遍历：所有可见文本节点 + 所有 title / placeholder / aria-label。 */
function cjkInStaticDom(): string[] {
  const hits: string[] = [];
  for (const el of all('*')) {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v !== null && CJK.test(v)) hits.push('<' + el.tagName.toLowerCase() + ' ' + attr + '> ' + v);
    }
    if (!visible(el)) continue;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 3) continue;
      const text = (child.nodeValue ?? '').trim();
      if (text !== '' && CJK.test(text)) hits.push('<' + el.tagName.toLowerCase() + '> ' + text);
    }
  }
  return hits;
}

/** index.html 上所有 data-i18n* 的 key（含各自属性名，便于失败时定位）。 */
function staticKeys(): Array<{ attr: string; key: string; line: string }> {
  const raw = readFileSync(INDEX_HTML, 'utf8');
  const out: Array<{ attr: string; key: string; line: string }> = [];
  for (const m of raw.matchAll(/data-i18n(-title|-aria-label|-placeholder)?="([^"]+)"/g)) {
    out.push({ attr: 'data-i18n' + (m[1] ?? ''), key: m[2] ?? '', line: raw.slice(0, m.index).split('\n').length + '' });
  }
  return out;
}

async function bootEnglish(): Promise<void> {
  const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
  i18n.setLocale('en');
  const s = (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as SettingsMod;
  s.installI18nSettings();
}

describe('W9109 · index.html 静态 DOM（英文界面不得残留中文）', () => {
  beforeEach(() => {
    // resetHarness：装 fetch 打桩 + vi.resetModules()。**resetModules 是本文件的关键**：
    // i18n/settings.ts 的 installed 标志是模块级的，不复位的话第二个用例起
    // installI18nSettings() 会直接早退，静态 DOM 还是空的（断言会误报成「没填充」）。
    resetHarness();
    localStorage.clear();
    doc.body.innerHTML = bodyOf(readFileSync(INDEX_HTML, 'utf8'));
    // 设置页初始带 .hidden（由 openSettings 摘掉）——断言的是「打开后」的样子。
    doc.getElementById('settingsPage')?.classList.remove('hidden');
  });
  afterEach(() => { vi.unstubAllGlobals(); doc.body.replaceChildren(); localStorage.clear(); });

  it('每个 data-i18n* 键在 zh / en 都存在且非空', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    const keys = staticKeys();
    // 防「夹具没加载」的空转：本次迁移后 index.html 上的 i18n 键远超这个下限。
    expect(keys.length, 'index.html 上的 data-i18n* 属性数量').toBeGreaterThan(40);
    const zh = i18n.localeDict('zh');
    const en = i18n.localeDict('en');
    const missing: string[] = [];
    const empty: string[] = [];
    for (const { attr, key, line } of keys) {
      if (!(key in zh)) missing.push('zh 缺 ' + key + ' (' + attr + ' @' + line + ')');
      if (!(key in en)) missing.push('en 缺 ' + key + ' (' + attr + ' @' + line + ')');
      if ((zh[key] ?? '').trim() === '') empty.push('zh 空值 ' + key + ' (' + attr + ' @' + line + ')');
      if ((en[key] ?? '').trim() === '') empty.push('en 空值 ' + key + ' (' + attr + ' @' + line + ')');
    }
    expect(missing, 'index.html 引用了字典里不存在的 key').toEqual([]);
    expect(empty, 'index.html 引用的 key 不得为空值').toEqual([]);
  });

  it('切到 en：整棵静态 DOM 的可见文本与 title/placeholder/aria-label 无 CJK', async () => {
    await bootEnglish();
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    expect(i18n.getLocale()).toBe('en');
    // 先证明遍历真的扫到了东西（否则「没有 CJK」可能只是空跑）。
    expect(all('.settings-nav-item').length).toBe(9);
    expect(all('.settings-pane').length).toBe(9);
    expect(all('[data-i18n]').length).toBeGreaterThan(30);
    expect(cjkInStaticDom(), '英文界面下的残留中文（逐条列在这里）').toEqual([]);
  });

  it('index.html 上的 data-i18n* 属性名只有四种（拼错即红）', () => {
    // 为什么需要：上面两条断言都按**属性名选择器**取元素 —— 属性名一旦拼错
    // （例如 data-i18n-placholder），选择器匹配不到、断言静默通过，而页面上那条文案
    // 就再也没人写（表现为空白或硬编码）。这里直接从原文正则出所有 data-i18n* 属性名，
    // 与填充器支持的四种比对。
    const raw = readFileSync(INDEX_HTML, 'utf8');
    const allowed = new Set(['data-i18n', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-placeholder']);
    const found = new Set<string>();
    for (const m of raw.matchAll(/\bdata-i18n[A-Za-z-]*(?==)/g)) found.add(m[0]);
    expect([...found].sort(), 'index.html 上出现了填充器不认的 data-i18n* 属性名').toEqual(
      [...found].filter((n) => allowed.has(n)).sort(),
    );
    expect(found.has('data-i18n-placeholder'), '#input 必须带 data-i18n-placeholder（首帧占位）').toBe(true);
  });

  it('填充器真的把每个 data-i18n* 属性写成了非空值（四个属性各自可达）', async () => {
    // 这条防的是「属性搬过去了、填充器却没认」——那种情况下 DOM 是**空的**，
    // 上面的「无 CJK」断言会静默通过（空字符串当然不含中文）。
    await bootEnglish();
    const unset: string[] = [];
    for (const attr of ['data-i18n', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-placeholder']) {
      for (const el of all('[' + attr + ']')) {
        const target = attr === 'data-i18n' ? 'textContent' : attr.slice('data-i18n-'.length);
        const value = (el as unknown as Record<string, unknown>)[target] ??
          (el.getAttribute(target) as string | null);
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '') unset.push(el.tagName.toLowerCase() + '[' + attr + '] → ' + target + ' 为空');
      }
    }
    expect(unset, '有 data-i18n* 属性却没被填充（属性名写错 / 填充器漏了该属性）').toEqual([]);
    const input = doc.getElementById('input');
    expect(input?.getAttribute('placeholder')?.trim(), '#input 的 placeholder 必须由填充器写入').not.toBe('');
  });

  it('切到 en 后动态 placeholder（插话 / 排队 / worker）也不含 CJK', async () => {
    // index.html 上的 data-i18n-placeholder 只管首帧；真实取值由 ui/inputbar 按当前
    // 语言写。这条把「重载即完整」钉在输入栏这一格上。
    await bootEnglish();
    const bar = (await import(/* @vite-ignore */ at('ui/inputbar.ts'))) as {
      initInputBar(h: Record<string, () => void>): void;
      setInputMode(m: string): void;
      setSubmitMode(m: string): void;
    };
    bar.initInputBar({ send: () => {}, cancel: () => {} } as never);
    const input = doc.getElementById('input') as unknown as { placeholder: string };
    const seen: string[] = [];
    for (const mode of ['idle', 'interject', 'worker']) {
      bar.setInputMode(mode);
      for (const lane of ['steer', 'queue']) {
        bar.setSubmitMode(lane);
        seen.push(mode + '/' + lane + ': ' + input.placeholder);
      }
    }
    const bad = seen.filter((s) => CJK.test(s));
    expect(bad, '英文界面下输入栏 placeholder 的残留中文').toEqual([]);
    expect(seen.every((s) => s.split(': ')[1]?.trim() !== ''), 'placeholder 不得为空').toBe(true);
  });

  it('设置页各 pane 的静态区块在 en 下无 CJK（nav 文案 + pane 头 + 说明）', async () => {
    await bootEnglish();
    const hits: string[] = [];
    for (const nav of all('.settings-nav-item')) {
      const text = (nav as unknown as { textContent: string | null }).textContent ?? '';
      if (text.trim() === '') hits.push('nav 项无文案（未填充）');
      if (CJK.test(text)) hits.push('nav: ' + text);
    }
    for (const pane of all('.settings-pane')) {
      const head = pane.querySelectorAll('.settings-pane-head');
      for (const h of Array.from(head)) {
        const text = (h as unknown as { textContent: string | null }).textContent ?? '';
        if (CJK.test(text)) hits.push('pane 头: ' + text.trim());
      }
    }
    expect(hits).toEqual([]);
  });

  it('反例：同一遍历在 zh 下**能**看到中文（证明断言不是空转）', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    i18n.setLocale('zh');
    const s = (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as SettingsMod;
    s.installI18nSettings();
    const hits = cjkInStaticDom();
    expect(hits.length, 'zh 下必须有中文，否则遍历/断言是空转的').toBeGreaterThan(10);
    expect(hits.some((h) => h.includes('通用设置'))).toBe(true);
  });

  it('<html lang> 跟着语言切换（英文界面不得自称 zh-CN）', async () => {
    const i18n = (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
    const docEl = (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement;
    i18n.setLocale('zh');
    const s = (await import(/* @vite-ignore */ at('i18n/settings.ts'))) as SettingsMod;
    s.installI18nSettings();
    expect(docEl.lang).toBe('zh-CN');
    i18n.setLocale('en');
    expect(docEl.lang).toBe('en');
  });
});
