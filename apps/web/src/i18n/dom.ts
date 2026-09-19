// ============================================================================
// i18n/dom.ts — 静态 DOM（index.html）的 i18n 填充。
//   · `data-i18n`            → textContent
//   · `data-i18n-title`      → title 属性
//   · `data-i18n-aria-label` → aria-label 属性
//   语言切换后由 installI18nSettings 统一重画；index.html 里不放中文，只放 key。
// ============================================================================
import { getLocale, t, type Key } from './index';

/**
 * `<html lang>`：屏幕阅读器与浏览器翻译器据此判断页面语言。
 *   index.html 里写死 zh-CN；切到英文后若不更新，**英文界面会被当成中文**
 *   （读屏按中文音读、浏览器翻译器不会提供翻译）。必须跟着语言切换走。
 */
export function applyDocumentLang(doc: Document): void {
  doc.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';
}

/** 把 root 内所有带 data-i18n* 属性的元素设为对应 key 的当前语言文案。 */
export function applyI18n(root: ParentNode): void {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n');
    if (key) node.textContent = t(key as Key);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    const key = node.getAttribute('data-i18n-title');
    if (key) node.setAttribute('title', t(key as Key));
  }
  for (const node of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = node.getAttribute('data-i18n-aria-label');
    if (key) node.setAttribute('aria-label', t(key as Key));
  }
}
