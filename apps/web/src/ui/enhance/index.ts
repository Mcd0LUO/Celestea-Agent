// ============================================================================
// ui/enhance/index.ts — 增强缝的对外面（W895 · P0）
// ----------------------------------------------------------------------------
//   initEnhancers();            // 装配（main.ts，一次；必须先于客户端插件装配）
//   runEnhancers(container);    // 渲染后（ui/messages/assistant.ts）
// ============================================================================
import { registerBuiltinEnhancers } from "./builtin";

export { registerEnhancer, runEnhancers, enhancerIds, type Enhancer } from "./registry";
export {
  registerBuiltinEnhancers,
  hljsEnhancer,
  mathEnhancer,
  HLJS_ENHANCER_ID,
  MATH_ENHANCER_ID,
  ORDER_HLJS,
  ORDER_MATH,
} from "./builtin";

/** 装配内置增强遍。必须在客户端插件装配之前调用：内置遍要先于可选组件入链。 */
export function initEnhancers(): void {
  registerBuiltinEnhancers();
}
