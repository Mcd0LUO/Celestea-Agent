// @vitest-environment jsdom
/**
 * W846 · LaTeX（方案 A：只渲染 MathML）
 *
 * 覆盖：
 *   1) utils/markdown.ts 的数学识别（行内 $...$ / 块级 $$...$$；代码块/行内代码/转义/货币不识别）；
 *   2) utils/sanitize.ts 的 MathML 白名单（正向保留 + 反向 XSS 反例全部剥离）；
 *   3) ui/messages/math.ts 的懒加载升级（占位 -> KaTeX output:mathml -> 过 sanitize）；
 *   4) MarkdownStream 流式：未闭合 $ 不得半固化。
 *
 * 范式：jsdom + pathToFileURL 动态 import 真实模块（不是复刻）。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');
const at = (rel: string): string => pathToFileURL(join(WEB, 'src', rel)).href;
const BT = String.fromCharCode(96);
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

const mdMod = (await import(at('utils/markdown.ts'))) as {
  renderMarkdown(text: string): string;
  MarkdownStream: new () => { update(text: string): string; reset(): void };
};
const sanMod = (await import(at('utils/sanitize.ts'))) as { sanitizeHtml(html: string): string };
const msgMd = (await import(at('ui/messages/markdown.ts'))) as { md(text: string): string };
const mathMod = (await import(at('ui/messages/math.ts'))) as { upgradeMath(root: ParentNode): void };

function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) { resolve(true); return; }
      if (Date.now() - t0 > ms) { resolve(pred()); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

const countOf = (h: string, needle: string): number => h.split(needle).length - 1;

describe('W846 · 数学识别（utils/markdown.ts，零 DOM）', () => {
  it('行内 $x^2$ / 块级 $$x^2$$ 产出安全占位（此时还没有 MathML）', () => {
    const inline = mdMod.renderMarkdown('a $x^2$ b');
    expect(inline).toContain('class="math-inline"');
    expect(inline).toContain('x^2');
    expect(inline).not.toContain('<math');
    const block = mdMod.renderMarkdown('$$x^2$$');
    expect(block).toContain('class="math-block"');
    expect(block).not.toContain('<math');
  });

  it('代码围栏 / 行内代码里的 $ 不识别为数学', () => {
    const fence = BT + BT + BT + NL + '$x^2$' + NL + BT + BT + BT;
    const fenced = mdMod.renderMarkdown(fence);
    expect(fenced).toContain('<code>');
    expect(fenced).not.toContain('math-inline');
    const inlineCode = mdMod.renderMarkdown('code ' + BT + '$not$' + BT + ' end');
    expect(inlineCode).not.toContain('math-inline');
  });

  it('转义 $ 与货币写法 $5 ... $6 不识别为数学', () => {
    expect(mdMod.renderMarkdown('escape ' + BS + '$x' + BS + '$ here')).not.toContain('math-inline');
    expect(mdMod.renderMarkdown('cost is $5 and $6 here')).not.toContain('math-inline');
  });

  it('流式：未闭合 $ 不得半固化（闭合后恰好一个数学占位）', () => {
    const s = new mdMod.MarkdownStream();
    const partial = s.update('a $x');
    expect(partial).not.toContain('math-inline');
    const full = s.update('a $x^2$');
    expect(countOf(full, 'math-inline')).toBe(1);
    expect(full).toContain('x^2');
  });
});

describe('W846 · sanitize：MathML 白名单（正向保留）', () => {
  it('保留 math/semantics/annotation 与实测属性', () => {
    const out = sanMod.sanitizeHtml(
      '<math display="block" xmlns="http://www.w3.org/1998/Math/MathML">' +
        '<semantics><mrow><mi mathvariant="script">L</mi><mo stretchy="false" fence="true">(</mo>' +
        '<mfrac linethickness="0px"><mn>1</mn><mn>2</mn></mfrac></mrow>' +
        '<annotation encoding="application/x-tex">L(1/2)</annotation></semantics></math>',
    );
    expect(out).toContain('<math');
    expect(out).toContain('display="block"');
    expect(out).toContain('xmlns="http://www.w3.org/1998/Math/MathML"');
    expect(out).toContain('mathvariant="script"');
    expect(out).toContain('stretchy="false"');
    expect(out).toContain('linethickness="0px"');
    expect(out).toContain('<annotation');
    expect(out).toContain('application/x-tex');
  });

  it('mstyle 的 displaystyle/scriptlevel/mathcolor 合法值保留', () => {
    const out = sanMod.sanitizeHtml(
      '<math><mstyle displaystyle="false" scriptlevel="1" mathcolor="#cc0000"><mi>x</mi></mstyle></math>',
    );
    expect(out).toContain('displaystyle="false"');
    expect(out).toContain('scriptlevel="1"');
    expect(out).toContain('mathcolor="#cc0000"');
  });
});

describe('W846 · sanitize：MathML XSS 反例（逐条剥离）', () => {
  it('math href（javascript:/data:）一律删除', () => {
    const a = sanMod.sanitizeHtml('<math href="javascript:alert(1)"><mi>x</mi></math>');
    expect(a).not.toContain('href');
    expect(a).not.toContain('javascript');
    expect(a).toContain('<mi>');
    const b = sanMod.sanitizeHtml('<math href="data:text/html,<script>alert(1)</script>"><mi>x</mi></math>');
    expect(b).not.toContain('href');
    expect(b).not.toContain('data:');
  });

  it('mi/mo 等元素上的 href 同样删除', () => {
    const out = sanMod.sanitizeHtml('<math><mi href="javascript:alert(1)">x</mi><mo href="data:x">(</mo></math>');
    expect(out).not.toContain('href');
    expect(out).not.toContain('javascript');
  });

  it('on* 事件属性一律删除', () => {
    const out = sanMod.sanitizeHtml('<math onload="alert(1)"><mi>x</mi></math>');
    expect(out).not.toContain('onload');
    expect(out).not.toContain('alert');
    expect(out).toContain('<mi>');
  });

  it('style 属性一律删除（不管标签）', () => {
    const out = sanMod.sanitizeHtml('<math style="background:url(javascript:alert(1))"><mi>x</mi></math>');
    expect(out).not.toContain('style');
    expect(out).not.toContain('url(');
  });

  it('嵌套危险容器连内容丢弃：script/style/iframe/svg', () => {
    const s = sanMod.sanitizeHtml('<math><mtext><script>alert(1)</script></mtext></math>');
    expect(s).not.toContain('script');
    expect(s).not.toContain('alert(1)');
    expect(s).toContain('<math>');
    const st = sanMod.sanitizeHtml('<math><mtext><style>x</style></mtext></math>');
    expect(st).not.toContain('<style');
    const ifr = sanMod.sanitizeHtml('<math><mtext><iframe srcdoc="<script>alert(1)</script>"></iframe></mtext></math>');
    expect(ifr).not.toContain('iframe');
    const svg = sanMod.sanitizeHtml('<math><mtext><svg onload="alert(1)"></svg></mtext></math>');
    expect(svg).not.toContain('<svg');
    expect(svg).not.toContain('onload');
  });

  it('annotation-xml / foreignObject 作为危险容器连内容丢弃', () => {
    const ax = sanMod.sanitizeHtml('<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>');
    expect(ax.toLowerCase()).not.toContain('annotation-xml');
    expect(ax).not.toContain('script');
    expect(ax).not.toContain('alert(1)');
    const fo = sanMod.sanitizeHtml('<math><foreignObject><script>alert(1)</script></foreignObject></math>');
    expect(fo.toLowerCase()).not.toContain('foreignobject');
    expect(fo).not.toContain('script');
  });

  it('annotation 里的脚本也会被剥掉（annotation 本身只留文本）', () => {
    const out = sanMod.sanitizeHtml('<math><annotation encoding="application/x-tex"><script>alert(1)</script></annotation></math>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert(1)');
  });

  it('非法属性值被拒：mathcolor=url(...) / mathvariant=evil / display=evil', () => {
    const c = sanMod.sanitizeHtml('<math><mstyle mathcolor="url(javascript:alert(1))"><mi>x</mi></mstyle></math>');
    expect(c).not.toContain('mathcolor');
    const v = sanMod.sanitizeHtml('<math><mi mathvariant="evil">x</mi></math>');
    expect(v).not.toContain('mathvariant');
    const d = sanMod.sanitizeHtml('<math display="evil"><mi>x</mi></math>');
    expect(d).not.toContain('display=');
  });

  it('既有规则未被放宽：script/img onerror/a javascript:/svg 行为不变', () => {
    expect(sanMod.sanitizeHtml('<script>alert(1)</script>')).not.toContain('alert');
    const img = sanMod.sanitizeHtml('<img src=x onerror="alert(1)">');
    expect(img).not.toContain('onerror');
    const a = sanMod.sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(a).not.toContain('href');
    expect(a).not.toContain('javascript');
    expect(sanMod.sanitizeHtml('<svg onload="alert(1)"></svg>')).not.toContain('<svg');
  });
});

describe('W846 · 懒加载升级（占位 -> MathML，过 sanitize）', () => {
  it('行内 $x^2$：升级前无 math，升级后出现 MathML 且 sanitize 后仍保留', async () => {
    const html = msgMd.md('a $x^2$ b');
    expect(html).toContain('class="math-inline"');
    expect(html).not.toContain('<math');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('math')).toBeNull();
    mathMod.upgradeMath(host);
    expect(await waitFor(() => host.querySelector('math') !== null)).toBe(true);
    const math = host.querySelector('math');
    expect(math).not.toBeNull();
    expect(math?.querySelector('msup') ?? math?.querySelector('mi')).not.toBeNull();
    const done = host.querySelector('.math-done');
    expect(done).not.toBeNull();
  });

  it('块级分式升级出 mfrac，且 display=block 占位保留', async () => {
    const frac = BS + 'frac{a}{b}';
    const host = document.createElement('div');
    host.innerHTML = msgMd.md('$$' + frac + '$$');
    expect(host.querySelector('math')).toBeNull();
    mathMod.upgradeMath(host);
    expect(await waitFor(() => host.querySelector('math') !== null)).toBe(true);
    expect(host.querySelector('mfrac')).not.toBeNull();
    expect(host.querySelector('.math-block')).not.toBeNull();
  });

  it('升级产物里的 href/style/on* 仍被 sanitize 剥掉（KaTeX 不可信输出）', () => {
    const out = sanMod.sanitizeHtml('<span class="katex"><math><mrow><mi href="javascript:alert(1)">x</mi></mrow></math></span>');
    expect(out).not.toContain('href');
    expect(out).not.toContain('javascript');
  });
});
