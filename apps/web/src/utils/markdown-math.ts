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
// W895-F：块级 `$$...$$` 的三个约束 ——
//   ① **必须**是「整行开头」（前面只能是行首，或同一行的空白）。这是关键：
//      否则讲到语法的字面例子（反引号里的 `$$...$$`）会被当成块公式起点，
//      惰性收尾一路找到**后面真正的** `$$`，把中间整段正文（含标题、行内公式）
//      全吞进一个 math-block —— 用户截图里的「公式糊成一团」就是这个。
//   ② 内容里不允许出现未转义的 `$`（避免把后续行内的 `$` 当作收尾）。
//   ③ `[^$]` 仍允许换行，所以**多行**公式照常工作（那才是块级的用途）。
const MATH_BLOCK_RE = /^[ \t]*\$\$((?:[^$]|\\.)+?)\$\$(?:[ \t]*(?:\n|$))/;

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
          // W895-F：跳过「行内上下文」里的 `$$`（反引号内 / 前一字符是反引号或反斜杠）。
          // marked 先按块切分、再运行行内 tokenizer，所以块规则必须自己避开这些位置，
          // 否则讲语法的字面例子会抢走真正的块公式起点。
          let i = src.indexOf('$$');
          while (i >= 0) {
            const prev = i > 0 ? src[i - 1] : "";
            const lineStart = src.lastIndexOf("\n", i - 1) + 1;
            const beforeOnLine = src.slice(lineStart, i);
            const atLineStart = beforeOnLine.trim() === "";
            if (atLineStart && prev !== "`" && prev !== "\\") return i;
            i = src.indexOf('$$', i + 2);
          }
          return undefined;
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
