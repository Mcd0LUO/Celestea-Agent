// ============================================================================
// statusline/icons.ts — W758 从 src/statusline.ts 拆出（纯搬运，无行为变更）：
//   模型图标节点 + 数值小工具（纯 helper、零模块状态）。
//   W750：内置 SVG 源码 → 元素。源码是 utils/model-icon.ts 里的常量字面量
//   （无任何用户输入参与拼接），因此 innerHTML 在这里没有注入面；元素本身
//   只做上色/定位。
// ============================================================================
import { el } from '../utils/dom';
import { modelIconFor, type ModelIcon } from '../utils/model-icon';

/**
 * W750：内置 SVG 源码 → 元素。源码是 model-icon.ts 里的常量字面量（无任何用户
 * 输入参与拼接），因此 innerHTML 在这里没有注入面；元素本身只做上色/定位。
 */
export function iconNode(spec: ModelIcon): HTMLElement {
  const span = el('span', 'sl-micon sl-micon-' + spec.key);
  span.innerHTML = spec.svg;
  return span;
}

/** 模型 id → 图标元素；未识别返回 null（调用方跳过，不留空位）。 */
export function modelIconEl(modelId: string): HTMLElement | null {
  const spec = modelIconFor(modelId);
  return spec === null ? null : iconNode(spec);
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export function fixed1(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : '—';
}
