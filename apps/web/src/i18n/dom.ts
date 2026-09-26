// ============================================================================
// i18n/dom.ts — 静态 DOM（index.html）的 i18n 填充。
//   · `data-i18n`            → textContent
//   · `data-i18n-title`      → title 属性
//   · `data-i18n-aria-label` → aria-label 属性
//   · `data-i18n-placeholder`→ placeholder 属性（W9109）
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

/**
 * 伪元素（`::after`）的 `content` 读不到 i18n 字典 —— 把这类文案写进 CSS 变量，
 * 由 styles 侧取值（当前唯一消费者：views.css 的
 * `.msg.user.steering/.queued .who::after`）。
 *
 * 为什么值要过 `JSON.stringify`：`content: var(--x)` 只接受**字符串 token**。
 * 实测（Chrome headless）：变量值写成裸文本 ` · 下一步送达` ⇒ 计算值 `content: none`
 * （后缀根本不生成）；写成带引号的 `" · 下一步送达"` ⇒ 计算值 `" · 下一步送达"`。
 * JSON.stringify 产出的正是带双引号、转义正确的 CSS 字符串字面量。
 *
 * 为什么写在 documentElement：自定义属性沿 DOM 继承，一处写入即全页可见；
 * 语言切换是整页重载（见 i18n/settings.ts 的方案 A），启动那一帧写一次就够。
 */
const CSS_COPY_VARS: ReadonlyArray<readonly [string, Key]> = [
  ['--i18n-lane-steer', 'chat.lane.nextStep'],
  ['--i18n-lane-queued', 'chat.lane.nextTurn'],
];

/** 把「只能由 CSS 消费」的文案写进 documentElement 的自定义属性。 */
function applyCssCopyVars(root: ParentNode): void {
  const asDoc = root as Partial<Document>;
  const html = asDoc.documentElement ?? (root as Partial<Element>).ownerDocument?.documentElement;
  if (!html) return;
  for (const [name, key] of CSS_COPY_VARS) {
    html.style.setProperty(name, JSON.stringify(' · ' + t(key)));
  }
}

/** 把 root 内所有带 data-i18n* 属性的元素设为对应 key 的当前语言文案。 */
export function applyI18n(root: ParentNode): void {
  applyCssCopyVars(root);
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
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.getAttribute('data-i18n-placeholder');
    if (key) node.setAttribute('placeholder', t(key as Key));
  }
}

/*
 * W9109：为什么 `data-i18n-placeholder` 走 applyI18n 就够了 ——
 *   `#input` 的 placeholder 随后由 ui/inputbar.ts 按「输入模式 × 提交车道」重写
 *   （renderSubmitUi / setInputMode 里都调了按语言的取值函数）。applyI18n 只在
 *   启动那一帧写一次**空闲态**值，正是 initInputBar 之前的正确显示；之后每次模式或
 *   车道变化都由 inputbar 自己按当前语言写。两个写者不会互相覆盖，因为 applyI18n
 *   不在模式变化时被调用（语言切换是整页重载，见 i18n/settings.ts 的方案 A）。
 */
