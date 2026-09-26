// ============================================================================
// ui/enhance/builtin.ts — 内置增强遍（W895 · P0；W9108 变成**可开关的客户端插件**）
// ----------------------------------------------------------------------------
// 这两个遍**本来就在**，只是原先写死在 ui/messages/assistant.ts 的 renderTextView 里。
// 搬到缝上是为了让「渲染后要做什么」可注册，**行为逐字节不变**：
//   顺序仍是 先高亮、再升级数学（原调用顺序）。
//
// W9108（用户原话「插件页似乎少了数学增强等内置的插件开关」）：它们现在也进
// 客户端插件登记表（plugins/descriptor.ts），于是复用既有那套开关/持久化/回滚记账。
// 两个关键不变量随之被**改成声明式**，不再靠调用时机：
//   ① hljs 必须先于 code-extras 入链 —— 由 `order` 常量（registry.ts）保证，
//      于是「关掉再打开 = 重新注册」也不会把顺序搞反（这是 W9108 的必修项）；
//   ② 模块加载即装配（见文件末尾）—— 任何 import 到增强缝的地方（消息、预览面板、
//      测试）都立刻得到这两个遍，不依赖某个调用点记得先 init。
// ============================================================================
import { highlightCode } from "../../utils/hljs";
import { upgradeMath } from "../messages/math";
import { registerEnhancer, type Enhancer } from "./registry";

/** 代码高亮遍（hljs；幂等靠 dataset.hlDone）。 */
export const HLJS_ENHANCER_ID = "builtin.hljs";
/** 数学占位升级遍（渲染器就绪前登记，就绪后替换为 MathML）。 */
export const MATH_ENHANCER_ID = "builtin.math";

/**
 * 顺序键：内置两遍必须先跑。
 *   10 = 高亮（code-extras 的**前置**：它按行切分 hljs 产出的 span）；
 *   20 = 数学占位升级（与 code-extras 无依赖，只是保持原调用顺序）。
 */
export const ORDER_HLJS = 10;
export const ORDER_MATH = 20;

/** 代码高亮遍（工厂：幂等，可反复调用）。 */
export function hljsEnhancer(): Enhancer {
  return { id: HLJS_ENHANCER_ID, order: ORDER_HLJS, enhance: (container) => highlightCode(container) };
}

/** 数学占位升级遍（工厂：幂等，可反复调用）。 */
export function mathEnhancer(): Enhancer {
  return { id: MATH_ENHANCER_ID, order: ORDER_MATH, enhance: (container) => upgradeMath(container) };
}

let installed = false;

/** 装配内置增强遍（幂等：重复调用只装一次）。顺序由 order 声明，不靠注册时机。 */
export function registerBuiltinEnhancers(): void {
  if (installed) return;
  installed = true;
  registerEnhancer(hljsEnhancer());
  registerEnhancer(mathEnhancer());
}

// W9108：模块加载即装配仍然保留（W895 的既有依赖，见文件头 ②）。
// 内置两遍是**基础设施**：原先在 assistant.ts 里写死直调，不需要任何装配，
// 所以它们不能依赖某个调用点记得先 init。initEnhancers() 仍是显式装配点（幂等）。
registerBuiltinEnhancers();
