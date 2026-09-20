// ============================================================================
// ui/enhance/builtin.ts — 内置增强遍（W895 · P0）
// ----------------------------------------------------------------------------
// 这两个遍**本来就在**，只是原先写死在 ui/messages/assistant.ts 的 renderTextView 里。
// 搬到缝上是为了让「渲染后要做什么」可注册，**行为逐字节不变**：
//   顺序仍是 先高亮、再升级数学（原调用顺序）。
// 它们是内置、**不可关闭**的（设置页不登记它们）—— 关掉高亮不是「可选显示组件」的语义。
// ============================================================================
import { highlightCode } from "../../utils/hljs";
import { upgradeMath } from "../messages/math";
import { registerEnhancer } from "./registry";

/** 代码高亮遍（hljs；幂等靠 dataset.hlDone）。 */
export const HLJS_ENHANCER_ID = "builtin.hljs";
/** 数学占位升级遍（渲染器就绪前登记，就绪后替换为 MathML）。 */
export const MATH_ENHANCER_ID = "builtin.math";

let installed = false;

/** 装配内置增强遍（幂等：重复调用只装一次）。顺序即执行顺序。 */
export function registerBuiltinEnhancers(): void {
  if (installed) return;
  installed = true;
  registerEnhancer({ id: HLJS_ENHANCER_ID, enhance: (container) => highlightCode(container) });
  registerEnhancer({ id: MATH_ENHANCER_ID, enhance: (container) => upgradeMath(container) });
}
