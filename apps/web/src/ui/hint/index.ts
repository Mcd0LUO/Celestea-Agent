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
import { startClientPlugins } from '../../plugins/apply';

/** 装配内置插件（幂等；重复调用 = 重新挂载同 id 提供者，不叠加）。 */
export function initHints(): void {
  mountHints();
  // W859：内置提供者（文字卡片 / 预览卡片）经 plugins 模块注册 —— 注销器被保存，
  // 设置页「插件」的开关才能真正注销/重挂；此处不再丢弃 registerHintPlugin 的返回值。
  startClientPlugins();
}

export { setHint, hoverHint, hideHint, hintCardEl, hintsMounted, HINT_ATTR, HINT_DELAY_MS } from './card';
export { hintPlugins, resolveHint } from './registry';
// W859：对外注册口收口到 plugins 的记账版（保存注销器、尊重插件开关）；
// registry 的原语仍可由本缝内部直接 import './registry'，但装配请走这里。
export { registerHintPlugin } from '../../plugins/register';
export { TEXT_HINT_ID, textCardPlugin } from './builtin';
export type { HintHandle, HintPlugin } from './registry';
