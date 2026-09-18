// @vitest-environment jsdom
/**
 * W847 A1/A1b · katex 0.16.47→0.18.7：MathML 白名单按真实产物锁定
 *
 * sanitize.ts 的 MathML 白名单必须恰好覆盖 KaTeX output:'mathml' 的真实产物：
 *   · 覆盖（标签级）：真实 katex 0.18.7 在下方语料上产出的每个标签，过 sanitize 后仍在；
 *   · 覆盖（属性级）：语料产出的每个属性过 sanitize 后仍在 —— **唯一例外 style**（错误 span /
 *     \fcolorbox 的 mpadded），这是有意剔除的安全取舍，不是遗漏，见 sanitize.ts 注释；
 *   · 不多放：KaTeX 不会产出的 MathML 标签，过 sanitize 后必须消失 —— 多放一个就红。
 *
 * 语料类别：分数/根号/上下标/矩阵（hline+vline）/left-right/middle/箭头/重音/上下划线/
 * \text(\textbf\textit)/\operatorname/颜色(\colorbox\fcolorbox)/实体/多行/token 间距/取消线/
 * \tag/\mathclap\mathllap\mathrlap。display 两种模式都跑。
 */
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
const katex = (async (): Promise<KatexLike> => {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(req.resolve('katex')).href)) as
    ({ default?: KatexLike } & Partial<KatexLike>);
  const k = typeof mod.renderToString === 'function' ? (mod as KatexLike) : mod.default;
  if (k === undefined) throw new Error('无法解析 katex 模块');
  return k;
})();

const CORPUS: Record<string, string> = {
  frac: '\\frac{a}{b}',
  sqrt: '\\sqrt[3]{x}',
  supsub: 'x_i^{y^{z}}',
  matrix: '\\begin{matrix} a & b \\\\ \\hline c & d \\end{matrix}',
  array_vline: '\\begin{array}{c|c} a & b \\\\ c & d \\end{array}',
  aligned: '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}',
  cases: '\\begin{cases} x & x>0 \\\\ -x & x\\le 0 \\end{cases}',
  tag: 'a = b \\tag{1}',
  leftright: '\\left( \\frac{a}{b} \\right)',
  middle: '\\left\\{ x \\middle| y \\right\\}',
  arrows: '\\xrightarrow{f} \\xleftarrow{g} \\overrightarrow{AB}',
  accents: '\\hat{x} \\bar{x} \\vec{x} \\dot{x} \\ddot{x} \\tilde{x} \\widehat{abc}',
  lines: '\\underline{x} \\overline{x} \\overbrace{x} \\underbrace{x}',
  text: '\\text{hello} \\text{\\textbf{bold} \\textit{ital}} \\operatorname{sin} \\operatorname*{argmax}',
  variants: '\\mathrm{a} \\mathbf{b} \\mathit{c} \\mathbb{R} \\mathcal{F} \\mathfrak{g} \\mathsf{x} \\mathtt{y} \\boldsymbol{\\alpha}',
  color: '\\color{red}{x} \\textcolor{blue}{y} \\colorbox{yellow}{z} \\fcolorbox{red}{yellow}{z}',
  entities: '\\& \\# \\% \\_ \\{ \\} \\alpha \\infty',
  operators: '\\sum_{i=1}^{n} i \\int_0^1 x \\, dx \\prod_{i=1}^{n} a_i \\lim_{x \\to 0} f(x)',
  spacing: 'a\\,b\\;c\\quad d\\qquad e\\!f',
  enclosures: '\\cancel{x} \\bcancel{x} \\xcancel{x} \\boxed{x} \\binom{n}{k}',
  laps: '\\mathclap{abc} \\mathllap{abc} \\mathrlap{abc}',
  phantom_pad: '\\phantom{x} \\smash{x} \\rule{1em}{1em} \\kern1em \\mspace{18mu}',
};

function tagsOf(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)/g)) {
    const t = m[1];
    if (t !== undefined) out.add(t.toLowerCase());
  }
  return out;
}

/** tag -> 该标签上出现的属性名集合（HTML 属性均为 name="value" 形态）。 */
function attrsOf(html: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of html.matchAll(/<([a-zA-Z][\w:-]*)([^>]*?)\/?>/g)) {
    const tag = (m[1] ?? '').toLowerCase();
    let set = out.get(tag);
    if (set === undefined) {
      set = new Set<string>();
      out.set(tag, set);
    }
    for (const a of (m[2] ?? '').matchAll(/([a-zA-Z][\w:.-]*)\s*=/g)) {
      const name = a[1];
      if (name !== undefined) set.add(name.toLowerCase());
    }
  }
  return out;
}

/** 标签级差分：raw 有而 sanitize 后没有的标签。 */
function missingTags(raw: string, sanitized: string): string[] {
  const kept = tagsOf(sanitized);
  return [...tagsOf(raw)].filter((tag) => !kept.has(tag));
}

/** 属性级差分：raw 有而 sanitize 后没有的属性（style 有意剔除，跳过）。 */
function missingAttrs(raw: string, sanitized: string): string[] {
  const kept = attrsOf(sanitized);
  const missing: string[] = [];
  for (const [tag, attrs] of attrsOf(raw)) {
    for (const attr of attrs) {
      if (attr === 'style') continue;
      if (!(kept.get(tag)?.has(attr) ?? false)) missing.push(tag + '@' + attr);
    }
  }
  return missing;
}

describe('W847 A1/A1b · MathML 白名单覆盖真实 katex 产物', () => {
  it('标签级：katex 0.18.7 语料产出的每个标签，过 sanitize 后仍在（不被解包）', async () => {
    const k = await katex;
    expect(typeof k.renderToString).toBe('function');
    const missed: string[] = [];
    for (const [name, tex] of Object.entries(CORPUS)) {
      for (const display of [false, true]) {
        const raw = k.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false });
        for (const m of missingTags(raw, sanMod.sanitizeHtml(raw))) missed.push(name + '/' + String(display) + '/' + m);
      }
    }
    expect(missed).toEqual([]);
  });

  it('属性级：语料产出的每个属性过 sanitize 后仍在（唯一例外 style = 有意剔除）', async () => {
    const k = await katex;
    const missed: string[] = [];
    for (const [name, tex] of Object.entries(CORPUS)) {
      for (const display of [false, true]) {
        const raw = k.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false });
        for (const m of missingAttrs(raw, sanMod.sanitizeHtml(raw))) missed.push(name + '/' + String(display) + '/' + m);
      }
    }
    expect(missed).toEqual([]);
  });

  it('A1 新增：mpadded / munder / mspace 实测属性保留（含 +6pt 正号长度）', () => {
    const out = sanMod.sanitizeHtml(
      '<math><mpadded width="+6pt" height="0px" depth="0px" lspace="3pt" voffset="0em" mathbackground="yellow" style="border:0"><mi>x</mi></mpadded>' +
        '<munder accentunder="true"><mi>y</mi><mo>_</mo></munder>' +
        '<mspace width="1em" height="1em" mathbackground="black"></mspace></math>',
    );
    expect(out).toContain('<mpadded');
    expect(out).toContain('width="+6pt"');
    expect(out).toContain('height="0px"');
    expect(out).toContain('depth="0px"');
    expect(out).toContain('lspace="3pt"');
    expect(out).toContain('voffset="0em"');
    expect(out).toContain('mathbackground="yellow"');
    expect(out).not.toContain('style');
    expect(out).toContain('accentunder="true"');
    expect(out).toContain('<mspace');
    expect(out).toContain('mathbackground="black"');
  });

  it('A1b 新增：mo lspace/rspace/minsize、mtext mathvariant、mtable/mtd width、mpadded width 伪单位', () => {
    const out = sanMod.sanitizeHtml(
      '<math><mo fence="true" lspace="0.05em" rspace="0.05em" minsize="3.0em" stretchy="true">|</mo>' +
        '<mtext mathvariant="bold">b</mtext>' +
        '<mtable width="100%"><mtr><mtd width="50%"><mi>x</mi></mtd></mtr></mtable>' +
        '<mpadded lspace="-0.5width" width="0px"><mi>y</mi></mpadded></math>',
    );
    expect(out).toContain('lspace="0.05em"');
    expect(out).toContain('rspace="0.05em"');
    expect(out).toContain('minsize="3.0em"');
    expect(out).toContain('mathvariant="bold"');
    expect(out).toContain('width="100%"');
    expect(out).toContain('width="50%"');
    expect(out).toContain('lspace="-0.5width"');
  });

  it('新增属性的非法值仍被拒（不因补齐实测而放宽）', () => {
    const bad = sanMod.sanitizeHtml(
      '<math><mpadded width="url(javascript:alert(1))" lspace="javascript:x" voffset="red"><mi>x</mi></mpadded>' +
        '<munder accentunder="evil"><mi>y</mi><mo>_</mo></munder>' +
        '<mo lspace="javascript:x" rspace="url(javascript:alert(1))" minsize="evil">|</mo>' +
        '<mtext mathvariant="evil">b</mtext>' +
        '<mtable width="javascript:1"><mtr><mtd width="url(x)"><mi>x</mi></mtd></mtr></mtable></math>',
    );
    expect(bad).not.toContain('url(');
    expect(bad).not.toContain('javascript');
    expect(bad).not.toContain('accentunder');
    expect(bad).not.toContain('mathvariant');
    expect(bad).not.toContain('minsize');
  });
});

/** KaTeX 0.18.7 实测**不产出**的 MathML 标签（标准元素表减去实测集）+ 内容 MathML。 */
const NOT_EMITTED = [
  'maction', 'maligngroup', 'malignmark', 'merror', 'mfenced', 'mglyph',
  'mlabeledtr', 'mlongdiv', 'mmultiscripts', 'mprescripts', 'ms',
  'mscarries', 'mscarry', 'msgroup', 'msline', 'msrow', 'mstack', 'none',
  'annotation-xml', 'foreignobject',
  'apply', 'ci', 'cn', 'csymbol', 'piecewise', 'vector', 'matrix',
];

describe('W847 A1 · MathML 白名单不多放 KaTeX 不产出的标签', () => {
  for (const tag of NOT_EMITTED) {
    it('未产出标签被解包/丢弃：<' + tag + '>', () => {
      const out = sanMod.sanitizeHtml('<' + tag + '>x</' + tag + '>');
      expect(out.toLowerCase()).not.toContain('<' + tag);
    });
  }
});
