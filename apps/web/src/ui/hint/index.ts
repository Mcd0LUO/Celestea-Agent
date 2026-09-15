// ============================================================================
// ui/hint/index.ts — 提示注册缝的**对外入口**（W790 · item 4）
//   用法：
//     initHints();                          // 装配（main.ts，一次）
//     setHint(node, '文案');                 // 任意调用点登记提示（只改属性）
//     registerHintPlugin(myProvider);       // 换/加实现（返回注销器）
//   两套并存的历史（原生 title + rail 自制卡）到此收口：content 归提供者，
//   延迟/宿主/落位/撤卡归引擎，调用点只写一行 setHint。
// ============================================================================
import { mountHints } from './card';
import { textCardPlugin } from './builtin';
import { registerHintPlugin } from './registry';

/** 装配内置插件（幂等；重复调用 = 重新挂载同 id 提供者，不叠加）。 */
export function initHints(): void {
  mountHints();
  registerHintPlugin(textCardPlugin());
}

export { setHint, hoverHint, hideHint, hintCardEl, hintsMounted, HINT_ATTR, HINT_DELAY_MS } from './card';
export { registerHintPlugin, hintPlugins, resolveHint } from './registry';
export { TEXT_HINT_ID, textCardPlugin } from './builtin';
export type { HintHandle, HintPlugin } from './registry';
