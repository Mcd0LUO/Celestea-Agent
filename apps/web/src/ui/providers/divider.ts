// ============================================================================
// ui/providers/divider.ts — 同一提供商内相邻模型块之间的淡分隔线（W9107）
// ----------------------------------------------------------------------------
// 用户需求：单提供商内部不同模型块「分界不明显，容易看混」——相邻模型块之间
// 需要一条**淡**分隔线（有设计感：中间粗、两边细），最后一个模型块之后不画。
//
// 手法（样式在 styles/provider-edit.css，共享 CSS 不改）：1px 渐变（两端渐隐、
// 中段实）+ 中段 2px 短中线 ⇒ 「中间粗、两边细」。**禁止**非实线线型。
//
// 为什么由 JS 插节点而不是 CSS 画：模型行可增（「+ 添加模型」/「获取模型」选择窗）
// 可删（行尾「移除」），纯 CSS 无法只画「相邻行之间」且不给最后一行收尾线。
// 因此每次增删后调用 syncModelDividers 重排（幂等：先清后插）。
// ============================================================================

/** 分隔线节点类名（样式见 styles/provider-edit.css）。 */
export const MODEL_DIVIDER_CLASS = 'prov-model-div';
/** 模型块类名（与 settings.css 的 .prov-model-row 同源）。 */
export const MODEL_ROW_CLASS = 'prov-model-row';

/**
 * 重排模型块之间的分隔线：每行之前插一条（首行之前不插），
 * 等价于「相邻行之间有线、最后一行之后无线」。幂等。
 */
export function syncModelDividers(modelsBox: HTMLElement): void {
  for (const old of Array.from(modelsBox.querySelectorAll('.' + MODEL_DIVIDER_CLASS))) old.remove();
  const rows = Array.from(modelsBox.querySelectorAll('.' + MODEL_ROW_CLASS));
  for (let i = 1; i < rows.length; i++) {
    const line = document.createElement('div');
    line.className = MODEL_DIVIDER_CLASS;
    // 纯装饰：读屏软件不应把它念成内容。
    line.setAttribute('aria-hidden', 'true');
    modelsBox.insertBefore(line, rows[i]!);
  }
}
