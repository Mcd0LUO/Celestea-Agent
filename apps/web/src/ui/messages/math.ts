// ============================================================================
// ui/messages/math.ts — W846 方案 A：数学占位 -> MathML（懒加载 KaTeX）
//
// utils/markdown-math.ts 只产出安全占位 <span|div class="math-inline|math-block">TeX</span>。
// 本模块是**唯一**把占位升级为真实数学的地方：
//   · 首次发现占位时才 import('katex')（动态 chunk，不进主包）；
//   · KaTeX 用 output:mathml（不产 HTML spans / 不依赖内联 style）；
//   · 产物仍过 utils/sanitize 白名单（唯一 HTML->DOM 通道），href/style/on* 一律剔除；
//   · 降级：import 失败或渲染异常都保留原始 TeX 文本（fail-soft，不吞内容）。
// utils/markdown.ts 保持零 DOM；本模块不进 bench 路径。
// ============================================================================
import { sanitizeNodes } from '../../utils/sanitize';
import { MATH_BLOCK_CLASS, MATH_INLINE_CLASS } from '../../utils/markdown-math';

/** KaTeX renderToString 的最小结构（避免静态 import 类型从而影响打包）。 */
interface KatexLike {
  renderToString(tex: string, options: Record<string, unknown>): string;
}
type MathRenderer = (tex: string, display: boolean) => string;

const SELECTOR = '.' + MATH_INLINE_CLASS + ',.' + MATH_BLOCK_CLASS;
const DONE_CLASS = 'math-done';

let renderer: MathRenderer | null = null;
let loading: Promise<void> | null = null;
/** 首个 import 解析前已出现的占位（解析后一次性升级）。 */
const pending = new Set<Element>();

/** 取 katex 模块的 renderToString（ESM default 或命名空间两种形态）。 */
function katexOf(mod: unknown): KatexLike | null {
  const m = mod as { default?: KatexLike } & Partial<KatexLike>;
  if (typeof m.renderToString === 'function') return m as KatexLike;
  return m.default !== undefined && typeof m.default.renderToString === 'function' ? m.default : null;
}

function load(): Promise<void> {
  if (renderer !== null) return Promise.resolve();
  if (loading === null) {
    loading = import('katex')
      .then((mod) => {
        const katex = katexOf(mod);
        if (katex === null) return;
        renderer = (tex, display) =>
          katex.renderToString(tex, { output: 'mathml', displayMode: display, throwOnError: false });
      })
      .catch(() => {
        loading = null; // 允许后续重试；占位继续显示 TeX 文本
      });
  }
  return loading;
}

function renderOne(el: Element): void {
  if (renderer === null || el.classList.contains(DONE_CLASS)) return;
  const tex = el.textContent ?? '';
  let html = '';
  try {
    html = renderer(tex, el.classList.contains(MATH_BLOCK_CLASS));
  } catch {
    return; // 渲染异常：保留 TeX 文本
  }
  el.replaceChildren(...sanitizeNodes(html));
  el.classList.add(DONE_CLASS);
}

/**
 * 升级 root 子树内的数学占位。渲染器未就绪时登记，懒加载完成后统一升级
 * （同一帧内同步替换，无空白帧）；找不到占位时零开销返回。
 */
export function upgradeMath(root: ParentNode): void {
  const els = root.querySelectorAll(SELECTOR);
  if (els.length === 0) return;
  if (renderer === null) {
    for (const el of Array.from(els)) pending.add(el);
    void load().then(() => {
      const list = Array.from(pending);
      pending.clear();
      for (const el of list) renderOne(el);
    });
    return;
  }
  for (const el of Array.from(els)) renderOne(el);
}
