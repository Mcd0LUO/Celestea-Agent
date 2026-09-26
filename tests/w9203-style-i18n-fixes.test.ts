// @vitest-environment jsdom
/**
 * W9203 · 样式/i18n 修复回归（P1-3 中文泄漏 · 护栏 D 扩面 · P1-1 盾牌几何 · P1-2 图标配色）。
 *
 * 四条修复各自的机械断言：
 *   ① 伪元素 content 的中文搬进 CSS 变量（views.css 的 content 值里一个 CJK 都不许剩）；
 *   ② 护栏 D 的 CSS 面与 HTML 全属性面（实体/单引号/转义都拦，注释放行）；
 *   ③ .sl-grant 的几何只有一个写者（statusline.css 不再重复声明）；
 *   ④ --mi-* 跟随 data-theme，而不是 prefers-color-scheme。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { at, doc, resetHarness } from './lib/w795-dom.js';

interface GateResult { problems: string[]; stats: Record<string, number> }
interface GateModule { runGate(root?: string): GateResult }
interface I18nMod { setLocale(l: string): void; t(k: string): string }
interface DomMod { applyI18n(root: unknown): void }

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'apps', 'web');
const STYLES = join(WEB, 'src', 'styles');
const gate = (await import(pathToFileURL(join(WEB, 'tools', 'check-ui-copy.mjs')).href)) as GateModule;
const loadI18n = async (): Promise<I18nMod> => (await import(/* @vite-ignore */ at('i18n/index.ts'))) as I18nMod;
const loadDom = async (): Promise<DomMod> => (await import(/* @vite-ignore */ at('i18n/dom.ts'))) as DomMod;

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** 最小 fixture 树：root/{index.html, src/...}。 */
function fixture(indexHtml: string, src: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'w9203-fix-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), indexHtml, 'utf8');
  for (const [rel, body] of Object.entries(src)) {
    const p = join(root, 'src', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  return root;
}

/** 一份 key 一致的最小 zh/en 字典对（gate 要求两语 key 集合一致）。 */
function locales(zh: string, en: string): Record<string, string> {
  return {
    'i18n/locales/zh/index.ts': 'export const zh = { ...common } as const;\n',
    'i18n/locales/zh/common.ts': zh,
    'i18n/locales/en/index.ts': 'export const en = { ...common };\n',
    'i18n/locales/en/common.ts': en,
  };
}
const GREEN_HTML = '<!doctype html><body><div id="app">Studio</div></body>';
const OK_LOCALES = locales("export const common = { 'k': '\u597d\u7684' } as const;\n", "export const common = { 'k': 'ok' };\n");

const cssText = (name: string): string => readFileSync(join(STYLES, name), 'utf8');
const dOnly = (r: GateResult): string[] => r.problems.filter((p) => p.includes('\u62a4\u680f D'));
const Q = String.fromCharCode(39);

describe('W9203 · ① 伪元素 content 的中文走 i18n', () => {
  it('views.css 的 content 里不再有 CJK，改读 --i18n-lane-*', () => {
    const text = cssText('views.css');
    expect(text).toContain('content: var(--i18n-lane-steer');
    expect(text).toContain('content: var(--i18n-lane-queued');
    // 注释里可以有中文（那是给维护者看的），但 content 的值里不许有。
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of stripped.matchAll(/content\s*:\s*([^;}]+)/g)) {
      expect(m[1] ?? '', 'content 值不得含中文').not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it('applyI18n 写入的变量值是**带引号的 CSS 字符串**，且与字典一致（zh/en）', async () => {
    resetHarness();
    const i18n = await loadI18n();
    const dom = await loadDom();
    // 夹具的 DocLike 只声明了测试用到的那几个成员（根 tsconfig 无 DOM lib）；
    // 这里按 w867-chatcol-drag.test.ts 的既有写法局部收窄，不改共享夹具。
    const html = (doc as unknown as {
      documentElement: { style: { getPropertyValue(p: string): string } };
    }).documentElement;
    const cases = [
      ['zh', 'chat.lane.nextStep', 'chat.lane.nextTurn'],
      ['en', 'chat.lane.nextStep', 'chat.lane.nextTurn'],
    ] as const;
    for (const [locale, kSteer, kQueued] of cases) {
      i18n.setLocale(locale);
      dom.applyI18n(doc);
      const pairs = [['--i18n-lane-steer', kSteer], ['--i18n-lane-queued', kQueued]] as const;
      for (const [name, key] of pairs) {
        const raw = html.style.getPropertyValue(name);
        // 关键：必须是**带引号**的字符串 token —— 裸文本会被 content 解析成 none（Chrome 实测），
        // 后缀静默消失。JSON.parse 反解同时钉住「引号存在」与「内容正确」。
        expect(raw.startsWith('"'), name + ' 必须是带引号的 CSS 字符串').toBe(true);
        expect(JSON.parse(raw), name + ' @' + locale).toBe(' \u00b7 ' + i18n.t(key));
      }
    }
  });

  it('两个 key 在中英字典里都存在且非空、且中英不同', async () => {
    const i18n = await loadI18n();
    const seen: Record<string, string> = {};
    for (const locale of ['zh', 'en'] as const) {
      i18n.setLocale(locale);
      for (const k of ['chat.lane.nextStep', 'chat.lane.nextTurn']) {
        const v = i18n.t(k);
        expect(v, k + ' @' + locale).not.toBe('');
        expect(v, k + ' @' + locale).not.toBe(k);
        seen[locale + k] = v;
      }
    }
    expect(seen['zhchat.lane.nextStep']).not.toBe(seen['enchat.lane.nextStep']);
    expect(seen['zhchat.lane.nextTurn']).not.toBe(seen['enchat.lane.nextTurn']);
  });
});

describe('W9203 · ② 护栏 D 扩面', () => {
  it('CSS content 里的中文 ⇒ 红（① 修复前的漏网路径）', () => {
    const root = fixture(GREEN_HTML, {
      ...OK_LOCALES,
      'styles/x.css': '.a::after{content:' + Q + ' \u00b7 \u4e0b\u4e00\u6b65\u9001\u8fbe' + Q + '}',
    });
    const d = dOnly(gate.runGate(root));
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('styles/x.css:1');
    expect(d[0]).toContain('\u4e0b\u4e00\u6b65\u9001\u8fbe');
  });

  it('CSS 十六进制转义写的中文同样拦（\\4e0b\\4e00\\6b65）', () => {
    const root = fixture(GREEN_HTML, {
      ...OK_LOCALES,
      'styles/x.css': '.a::after{content:' + Q + '\\4e0b\\4e00\\6b65' + Q + '}',
    });
    const d = dOnly(gate.runGate(root));
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('\u4e0b\u4e00\u6b65');
  });

  it('CSS 注释里的中文不拦（等长剥注释，行号不挪）', () => {
    const root = fixture(GREEN_HTML, {
      ...OK_LOCALES,
      'styles/x.css': '/* \u8fd9\u662f\u6ce8\u91ca\uff1a\u4e0b\u4e00\u6b65\u9001\u8fbe */\n.a{color:red}',
    });
    expect(dOnly(gate.runGate(root))).toEqual([]);
  });

  it('CSS 里的纯符号 content 不拦（\u00b7 / \u25b8 / \\00b7）', () => {
    const root = fixture(GREEN_HTML, {
      ...OK_LOCALES,
      'styles/x.css': '.a::after{content:' + Q + '\u00b7' + Q + '}\n.b::after{content:' + Q + '\u25b8' + Q + '}\n.c::after{content:' + Q + '\\00b7' + Q + '}',
    });
    expect(dOnly(gate.runGate(root))).toEqual([]);
  });

  it('HTML 非传统文案属性（alt / aria-describedby / value / data-*）也拦', () => {
    const root = fixture(
      '<!doctype html><body><div id="app">Studio</div>' +
        '<img alt="\u56fe\u7247"><input aria-describedby="\u8bbe\u7f6e" value="\u4e2d\u6587\u503c">' +
        '<div data-label="\u4e2d\u6587"></div></body>',
      { 'ui/keep.ts': 'export const x = 1;\n' },
    );
    const d = dOnly(gate.runGate(root));
    for (const v of ['\u56fe\u7247', '\u8bbe\u7f6e', '\u4e2d\u6587\u503c', '\u4e2d\u6587']) {
      expect(d.some((p) => p.includes(v)), v).toBe(true);
    }
  });

  it('单引号属性与 HTML 实体（十/十六进制）都不放过', () => {
    // 每个待查串都用**互不为子串**的独立词，否则「A 是 B 的子串」会让断言在错误实现下也通过。
    // 反例（W9203 变异 M4 抓到）：断言 p.includes('重新') 会被另一条 '重新载入' 命中。
    const root = fixture(
      '<!doctype html><body><div id="app">Studio</div>' +
        '<button title=' + Q + '\u91cd\u65b0\u8f7d\u5165' + Q + '>a</button>' +
        '<div>&#x901a;&#x7528;&#x8bbe;&#x7f6e;</div>' +
        '<img alt="&#x56fe;&#x7247;">' +
        '<button title="&#20445;&#23384;"></button></body>',
      { 'ui/keep.ts': 'export const x = 1;\n' },
    );
    const d = dOnly(gate.runGate(root));
    // 单引号属性（未编码的 CJK）
    expect(d.some((p) => p.includes('\u91cd\u65b0\u8f7d\u5165'))).toBe(true);
    // 十六进制实体：文本节点
    expect(d.some((p) => p.includes('\u901a\u7528\u8bbe\u7f6e'))).toBe(true);
    // 十六进制实体：属性（alt）
    expect(d.some((p) => p.includes('\u56fe\u7247'))).toBe(true);
    // 十进制实体：属性（title）—— 源码里是纯 ASCII，CJK 正则看不见，必须先解码
    expect(d.some((p) => p.includes('\u4fdd\u5b58'))).toBe(true);
  });

  it('假名/韩文/全角标点也拦（英文界面不该有）', () => {
    const root = fixture(
      '<!doctype html><body><div id="app">Studio</div>' +
        '<div>\u3053\u3093\u306b\u3061\u306f</div><div>\uc548\ub155\ud558\uc138\uc694</div><div>\uff0c\u3002\uff08\uff09</div></body>',
      { 'ui/keep.ts': 'export const x = 1;\n' },
    );
    const d = dOnly(gate.runGate(root));
    expect(d.some((p) => p.includes('\u3053\u3093\u306b\u3061\u306f'))).toBe(true);
    expect(d.some((p) => p.includes('\uc548\ub155\ud558\uc138\uc694'))).toBe(true);
    expect(d.some((p) => p.includes('\uff0c\u3002\uff08\uff09'))).toBe(true);
  });

  it('TS 源码里的全角标点不误报（join(\u3001) 这类分隔符）', () => {
    const root = fixture(GREEN_HTML, {
      ...OK_LOCALES,
      'ui/a.ts': 'export const s = ["a","b"].join("\u3001");\n',
    });
    const problems = gate.runGate(root).problems;
    // 只断言「不误报文案问题」—— fixture 的字典键没有消费方，会另出一条死键提示，与本题无关。
    expect(problems.filter((p) => p.includes('\u62a4\u680f')), '不得有护栏 A/D 误报').toEqual([]);
  });

  it('真实树：护栏 D 无问题，且 CSS 面确实被扫到', () => {
    const r = gate.runGate(WEB);
    expect(dOnly(r)).toEqual([]);
    expect(r.stats.cssFiles, 'CSS 面必须真的在扫').toBe(
      readdirSync(STYLES).filter((f) => f.endsWith('.css')).length,
    );
    expect(r.stats.cssFiles).toBeGreaterThanOrEqual(30);
  });
});

describe('W9203 · ③ .sl-grant 几何单一写者', () => {
  it('statusline.css 不再声明 .sl-grant 的 height / border-radius', () => {
    const stripped = cssText('statusline.css').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of stripped.matchAll(/\.sl-grant\s*\{([^}]*)\}/g)) {
      expect(m[1] ?? '', '.sl-grant 的几何归 grants.css 独占').not.toMatch(/height\s*:|border-radius\s*:/);
    }
  });

  it('grants.css 是 .sl-grant 几何的唯一写者（height 只一处）', () => {
    const stripped = cssText('grants.css').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    const blocks = [...stripped.matchAll(/\.sl-grant\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(blocks.length, 'grants.css 里 .sl-grant 主规则存在').toBeGreaterThan(0);
    const heights = blocks.filter((b) => /height\s*:/.test(b));
    expect(heights, 'height 只在一个规则里声明').toHaveLength(1);
    // 值本身也钉住：28px 是 W847 W12 点名的口径，也是唯一能让盾牌与
    // .sl-model/.sl-effort/.sl-mode（三者均 28px）垂直对齐的值。
    // 18px 时真机实测盾牌 top=10 而三个兄弟 top=5（行高 28 居中）⇒ 明显错位。
    expect(heights[0]).toMatch(/height\s*:\s*28px/);
    const radii = blocks.filter((b) => /border-radius\s*:/.test(b));
    expect(radii, '圆角同属几何，也只在一个规则里').toHaveLength(1);
    expect(radii[0]).toMatch(/border-radius\s*:\s*var\(--r-badge\)/);
  });
});

describe('W9203 · ④ --mi-* 跟随 data-theme', () => {
  const MI = ['deepseek', 'openai', 'glm', 'claude', 'gemini', 'qwen', 'meta', 'mistral', 'grok', 'kimi', 'cohere', 'ollama'];
  const css = (): string => cssText('statusline.css');

  it('12 个家族各 3 套取值：亮色 + dark 主题 + claude 暗色', () => {
    const text = css();
    for (const k of MI) {
      const hits = [...text.matchAll(new RegExp('--mi-' + k + '\\s*:', 'g'))];
      // 亮色在 :root；暗色在 [data-theme="dark"]；claude 的暗色在媒体查询内的
      // [data-theme="claude"]（跟 theme-claude.css 同一把钥匙）。少任何一套都会让
      // 某个主题组合拿错对比度的图标 —— 故这里钉住 3 处。
      expect(hits.length, '--mi-' + k + ' 应有 3 处（亮 / dark / claude 暗）').toBe(3);
    }
  });

  it('暗色表挂在 [data-theme="dark"]，不再挂在 :root 的 prefers-color-scheme 上', () => {
    const text = css();
    const i = text.indexOf('[data-theme="dark"] {');
    expect(i, '必须有 [data-theme="dark"] 规则').toBeGreaterThan(-1);
    const block = text.slice(i, text.indexOf('}', i));
    for (const k of MI) expect(block, 'dark 块应含 --mi-' + k).toContain('--mi-' + k);
    // 旧的错误形状：媒体查询里直接改 :root
    expect(text).not.toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{/);
  });

  it('claude 的暗色跟它自己的 prefers-color-scheme（theme-claude.css 的口径）', () => {
    const text = css();
    const i = text.indexOf('[data-theme="claude"] {');
    expect(i, 'claude 暗色表必须在媒体查询内').toBeGreaterThan(-1);
    const media = text.lastIndexOf('@media', i);
    expect(text.slice(media, i)).toContain('prefers-color-scheme: dark');
    const block = text.slice(i, text.indexOf('}', i));
    for (const k of MI) expect(block, 'claude dark 块应含 --mi-' + k).toContain('--mi-' + k);
  });
});
