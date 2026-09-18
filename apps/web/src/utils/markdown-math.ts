// ============================================================================
// utils/markdown-math.ts — W846 方案 A：行内/块级数学**识别**（零 DOM、零 KaTeX）
//
// marked 扩展只做「分词 -> 安全占位」：
//   行内 $...$   -> <span class="math-inline">TeX(转义文本)</span>
//   块级 $$...$$ -> <div  class="math-block">TeX(转义文本)</div>
// 真实渲染（KaTeX output:mathml）由 ui/messages/math.ts 在首次出现占位时懒加载
// 完成 —— 本模块与 utils/markdown.ts 都不引入 KaTeX，主包不因此增大。
//
// 识别边界（marked 分词天然保证，实测）：代码围栏内、行内代码内、反斜杠转义的 $
// 都不产生数学 token；行内还要求开 $ 后非空白、闭 $ 前非空白、闭 $ 后不接数字
// （挡 $5 and $6 这类货币写法）。
// ============================================================================
import { marked } from 'marked';

export const MATH_INLINE_CLASS = 'math-inline';
export const MATH_BLOCK_CLASS = 'math-block';

type Escape = (s: string) => string;
/** marked.use 的扩展类型（用 Parameters 取，免额外 import 类型名）。 */
type MarkedExtension = Parameters<typeof marked.use>[0];

const MATH_INLINE_RE = /^\$(?!\$)(?=[^\s$])((?:\\.|[^\\$])+?)(?<=\S)\$(?!\$)(?!\d)/;
const MATH_BLOCK_RE = /^\$\$([\s\S]+?)\$\$(?:\n|$)/;

interface MathToken {
  type: string;
  raw: string;
  text?: string;
  display?: boolean;
}

function mathPlaceholder(tex: string, display: boolean, escape: Escape): string {
  const tag = display ? 'div' : 'span';
  const cls = display ? MATH_BLOCK_CLASS : MATH_INLINE_CLASS;
  return '<' + tag + ' class="' + cls + '">' + escape(tex) + '</' + tag + '>';
}

/** 构造 marked 扩展（纯识别 + 占位；调用方在模块加载时注册）。 */
export function mathExtension(escape: Escape): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        start(src: string): number | undefined {
          const i = src.indexOf('$$');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string): MathToken | undefined {
          const m = MATH_BLOCK_RE.exec(src);
          if (m === null) return undefined;
          return { type: 'mathBlock', raw: m[0], text: m[1] ?? '', display: true };
        },
        renderer(token: MathToken): string {
          return mathPlaceholder(token.text ?? '', token.display === true, escape);
        },
      },
      {
        name: 'mathInline',
        level: 'inline',
        start(src: string): number | undefined {
          const i = src.indexOf('$');
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string): MathToken | undefined {
          const m = MATH_INLINE_RE.exec(src);
          if (m === null) return undefined;
          return { type: 'mathInline', raw: m[0], text: m[1] ?? '', display: false };
        },
        renderer(token: MathToken): string {
          return mathPlaceholder(token.text ?? '', token.display === true, escape);
        },
      },
    ],
  };
}
