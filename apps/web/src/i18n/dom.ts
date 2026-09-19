// ============================================================================
// i18n/dom.ts — 静态 DOM 的 i18n 填充：带 data-i18n 属性的元素取字典文案。
//   语言切换后由 installI18nSettings 统一重画，不需要各组件各写一套。
// ============================================================================
import { t, type Key } from './index';

/** 把 root 内所有 [data-i18n] 元素的文本设为对应 key 的当前语言文案。 */
export function applyI18n(root: ParentNode): void {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key as Key);
  }
}
