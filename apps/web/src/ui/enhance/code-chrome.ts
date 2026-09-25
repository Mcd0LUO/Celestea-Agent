// ============================================================================
// ui/enhance/code-chrome.ts — 代码块「工具条」宿主（W1526 · 代码块优化）
// ----------------------------------------------------------------------------
// 为什么要有这个模块：W1526 之前，语言徽标 / 复制按钮 / 折叠按钮都是
// **绝对定位的浮层**（`top: 6px` / `bottom: 6px`，见 components.css），直接压在
// `pre` 的正文上 —— 短代码块的首行/末行被盖住（用户原话「挡文字」）。
//
// 修法是把三者从**浮层**改成**占位**：`.code-wrap` 里、`pre` **上面**多一行工具条，
// 装饰住在里面，正文完整地待在 `pre` 里不受遮挡。代价是每个代码块高约 27px，
// 换来的是「装饰与正文永不重叠」这条可以机械断言的硬不变量
// （浮层方案只能靠「留白够不够」的经验值去凑，且长行横向滚动时必然失效）。
//
// 三个装饰由**两个**增强遍注入（code-copy 出复制按钮，code-extras 出徽标与折叠），
// 而工具条只能有一条 ⇒ 宿主创建必须共用：谁先跑谁建，后跑的复用（幂等）。
// 这样也保持了两个组件各自可开关：关掉 code-extras 时工具条里只剩复制按钮。
// ============================================================================

/** 工具条 class（样式在 styles/codeblock.css）。 */
export const CODE_HEAD_CLASS = "code-head";

/**
 * 取 `.code-wrap` 里的工具条；没有就建一个并插到 `pre` **前面**（幂等）。
 *
 * 为什么工具条在 `pre` **外面**、而不是像 GitHub 那样放进代码块内部：
 * `pre` 自己 `overflow-x:auto`，放进去的东西会**随长行一起横向滚走** ——
 * 这正是 W895 当初把复制按钮放在 `.code-wrap`（pre 的兄弟）上的原因，
 * `code-copy.test.ts` 的「按钮是 pre 的兄弟，不是子节点」守的就是这条。
 * 本波沿用同一个归属，只把「绝对定位浮层」换成「正常流工具条」：控件永远在
 * 可视区内（不会被长行滚走），且工具条与 `pre` 是**上下相邻的两个块**，
 * 与正文几何上不可能相交。
 */
export function ensureHead(wrap: HTMLElement): HTMLElement {
  for (const child of Array.from(wrap.children)) {
    if (child.classList.contains(CODE_HEAD_CLASS)) return child as HTMLElement;
  }
  const head = document.createElement("div");
  head.className = CODE_HEAD_CLASS;
  wrap.insertBefore(head, wrap.querySelector("pre"));
  return head;
}
