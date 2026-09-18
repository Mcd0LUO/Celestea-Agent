// @vitest-environment jsdom
/**
 * W865 · 反面对照：mhchem 扩展**未加载**时 \ce 长什么样（红→绿的反面证据）
 *
 * 为什么单独一个文件：扩展是全局宏注册（contrib/mhchem.mjs 对 katex 实例调用
 * __defineMacro），同一模块实例内一旦加载就撤不掉。本文件不 import
 * ui/messages/math.ts、也不 import contrib/mhchem（直到下面显式加载那一刻），
 * 于是「加载前 / 加载后」在同一 katex 实例上前后对照 —— 差异只可能来自扩展本身。
 *
 * 实测（katex 0.18.7，output:mathml + throwOnError:false，与 ui/messages/math.ts 同参）：
 *   · 加载前：\ce 是未定义命令 —— KaTeX 产出
 *       <mstyle mathcolor="#cc0000"><mtext>\ce</mtext></mstyle>
 *     再把 {…} 里的内容当**普通数学**排版（2H2+O2−>2H2O）。
 *     注意：这**不是**「把整条 TeX 原样吐回」；用户看到的「红 \ce」就是这个未定义命令标记。
 *   · 加载后：同一段 TeX 变成真正的化学式（→ 反应箭头 + 下标），红标消失。
 * 用户报的「mhchem 化学式不支持」= 这个红 \ce 标记；W865 在 math.ts 首次渲染前
 * 加载扩展后消失（正向断言见 tests/w846-latex-mathml.test.ts 的 W865 组）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const at = (rel: string): string => pathToFileURL(join(WEB, 'src', rel)).href;

const sanMod = (await import(at('utils/sanitize.ts'))) as { sanitizeHtml(html: string): string };

interface KatexLike {
  renderToString(tex: string, options: Record<string, unknown>): string;
}
const req = createRequire(join(WEB, 'package.json'));
/** katex 包根（真实路径）。contrib 没有类型声明，测试按产物路径直接 import。 */
const KATEX_DIR = dirname(req.resolve('katex/package.json'));
const dist = (rel: string): string => pathToFileURL(join(KATEX_DIR, 'dist', rel)).href;

const katexMod = (await import(/* @vite-ignore */ dist('katex.mjs'))) as
  ({ default?: KatexLike } & Partial<KatexLike>);
const katex: KatexLike =
  typeof katexMod.renderToString === 'function' ? (katexMod as KatexLike) : (katexMod.default as KatexLike);

/** 与 ui/messages/math.ts 完全相同的渲染参数（output:mathml / throwOnError:false）。 */
const render = (tex: string): string =>
  katex.renderToString(tex, { output: 'mathml', displayMode: false, throwOnError: false });

const CE = '\\ce{2H2 + O2 -> 2H2O}';

describe('W865 · 反面对照：mhchem 未加载 vs 已加载（同一 katex 实例）', () => {
  it('锁 specifier：katex 的 ./contrib/mhchem 的 ESM 出口就是 dist/contrib/mhchem.mjs', () => {
    const pkg = JSON.parse(readFileSync(join(KATEX_DIR, 'package.json'), 'utf8')) as {
      exports?: Record<string, { import?: string }>;
    };
    expect(pkg.exports?.['./contrib/mhchem']?.import).toBe('./dist/contrib/mhchem.mjs');
  });

  it('加载前：\\ce 是未定义命令（红标 + 参数当普通数学），sanitize 后红标仍在', () => {
    const raw = render(CE);
    expect(raw).toContain('#cc0000');
    expect(raw).toContain('<mtext>\\ce</mtext>');
    expect(raw).not.toContain('→');
    const san = sanMod.sanitizeHtml(raw);
    expect(san).toContain('#cc0000');
    expect(san).toContain('\\ce');
  });

  it('同一实例加载 contrib/mhchem 后：同一段 TeX 变化学式（箭头 + 下标），红标消失', async () => {
    await import(/* @vite-ignore */ dist('contrib/mhchem.mjs'));
    const raw = render(CE);
    expect(raw).not.toContain('#cc0000');
    expect(raw).toContain('→');
    expect(raw).toContain('<msub>');
    const san = sanMod.sanitizeHtml(raw);
    expect(san).not.toContain('#cc0000');
    expect(san).toContain('→');
  });
});
