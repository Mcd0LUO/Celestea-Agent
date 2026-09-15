// ============================================================================
// ui/hint/registry.ts — 悬浮提示的**注册缝**（W790 · item 4）
// ----------------------------------------------------------------------------
// 为什么是「缝」而不是一套插件系统：DSH 的客户端插件是真包（package.json 的
// `dsh.client` 清单 + tsdown 产物 lib/client.js + 宿主 /plugins 分发 + cordis
// fiber + HMR 换纤，见 W790 报告的「DSH 调研」一节），本仓是**单 Vite 产物、
// 无 cordis、无 React、门禁只有体积棘轮**，装不下那条管线。这里只抄它的**形状**：
//   · 具名提供者（id 即身份，同名覆盖 = 重新挂载）；
//   · register(...) → dispose（对齐 DSH `ctx.<registry>.register()` 的注销器）；
//   · 单一挂载点 + 「谁认领谁渲染」的优先级裁决。
// 代价：两个小模块 + 一个注册点，零构建/HMR/门禁改动（这正是取舍依据）。
// ============================================================================

/** 一个提示目标被认领后，提供者交给引擎的句柄（引擎只管挂载与落位）。 */
export interface HintHandle {
  /** 卡片内容；返回 null = 只登记提示文本、不弹卡（如纯原生 title 场景）。 */
  build(): HTMLElement | null;
  /** 自定义落位（缺省 = 锚点右下 12px，贴边回退）。 */
  position?(card: HTMLElement, anchor: HTMLElement): void;
}

/** 一个提示提供者（= 内置插件）。 */
export interface HintPlugin {
  /** 提供者身份：诊断与测试读它，重复注册视为重新挂载（后者胜）。 */
  id: string;
  /** 认领优先级，大者优先（内置纯文本卡 = 0，rail 富卡片 = 10）。 */
  priority?: number;
  /** 认领一个提示目标；不认领返回 null（交给下一个提供者）。 */
  claim(target: HTMLElement, text: string): HintHandle | null;
}

const plugins: HintPlugin[] = [];

/**
 * 注册一个提示提供者，返回注销器（对齐 DSH `register(...) → dispose`）。
 * 幂等：同 id 重复注册 = 用新实现替换旧的（HMR/重挂载语义）。
 */
export function registerHintPlugin(plugin: HintPlugin): () => void {
  const i = plugins.findIndex((p) => p.id === plugin.id);
  if (i >= 0) plugins[i] = plugin;
  else plugins.push(plugin);
  plugins.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return () => {
    const j = plugins.indexOf(plugin);
    if (j >= 0) plugins.splice(j, 1);
  };
}

/** 当前注册的提供者（按优先级降序；诊断/测试用只读快照）。 */
export function hintPlugins(): readonly HintPlugin[] {
  return plugins.slice();
}

/** 首个认领该目标的提供者（null = 无人认领 → 调用方退回原生 title）。 */
export function resolveHint(target: HTMLElement, text: string): HintHandle | null {
  for (const p of plugins) {
    const h = p.claim(target, text);
    if (h) return h;
  }
  return null;
}
