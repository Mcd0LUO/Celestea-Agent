// ============================================================================
// ui/preview/sandbox.ts — HTML 预览的**沙箱策略**（W1534 · 唯一真源）
// ----------------------------------------------------------------------------
// 渲染「模型/用户产出的 HTML」= 把不可信内容交给浏览器解析。本模块是这条路径上
// **唯一**决定「给多少权限」的地方，因此把策略写成常量 + 纯函数，便于机械断言与
// 变异负控制（改坏这里 ⇒ 断言必须红）。
//
// 三层防线，逐条论证：
//
//   ① sandbox **不含** allow-same-origin —— 硬红线。
//      带 allow-scripts + allow-same-origin 时，iframe 内的脚本可以读
//      parent.document / cookie / localStorage，等价于「把不可信 HTML 直接
//      innerHTML 进主文档」。本仓 localStorage 里有 celestea-locale 等真实状态。
//      ⇒ 预览文档因此活在**不透明源(opaque origin)**里，父页面**无权访问它的
//        contentDocument**（实测为 null）。这不是缺陷，正是隔离生效的**正控**。
//
//   ② sandbox **不含** allow-scripts —— 本波最关键的一条决定。
//      验收口径是「打开一个含 <script>alert(1)</script> 的 HTML，断言**脚本未执行**」
//      （CDP 监听 dialog）。既然要断言「未执行」，就**不能**给 allow-scripts：
//      给了它，alert 会真的弹出来，这条验收直接红。
//      这与「最小权限」同向，也是本仓的既有口径：预览是**看**页面，不是**运行**页面。
//      代价（明确记账）：JS 驱动的页面（SPA、图表库、document.write 生成正文）在预览里
//      是静态空壳 —— 刻意的取舍，不是缺陷。要看 JS 效果请用源码模式，或另存后用真浏览器打开。
//
//      行业对照（为什么这里与 CodePen/JSFiddle 不同）：
//        · CodePen/JSFiddle 跑的是**用户自己写的**代码、用户按了 Run，且在独立源上；
//        · 本仓预览的是**模型产出 / 会话里出现过的**文件，无人按 Run，用户只想「看一眼」；
//        · VSCode 内置预览走真实 webview（不同源）；GitHub 对 .html 只给源码。
//      三者里「不给脚本」这一档有明确先例，且只有它满足本任务的验收。
//
//   ③ CSP：**默认不加载任何外部网络资源**，且脚本再锁一道。
//      为什么 sandbox 之外还要 CSP：sandbox 管的是「同源/脚本/导航/表单」，管不了
//      「往哪个地址发请求」。没有 CSP 时，预览里的 <img src="http://attacker/?leak">
//      会真的发出去（**实测**：探针服务器收到了 beacon.png 的请求，命中数 1）。
//      CSP 关掉这条出网面。
//
//   ★★ ③ 的**落地方式**是本文件最要紧的一处（W1543 更正 W1534 的做法）：
//
//      W1534 原先把 CSP 以 <meta http-equiv> **插进 HTML 字符串**再赋给 srcdoc。
//      后果：srcdoc ≠ 用户原文（长度 830 vs 595），「实体保真」这条验收**直接红**。
//      更糟的是它把「保真」偷换成「把注入的 meta 摘掉后保真」—— 断言被削弱成
//      自我印证（把注入片段删掉当然还原），真实契约（**交给浏览器的就是原文**）没被守住。
//
//      正确做法：CSP 走 **iframe 的 csp 属性**（CSP Embedded Enforcement），
//      它由**元素**携带，不经过文档源文本 ⇒ srcdoc 可以逐字节等于用户原文。
//      实测（chrome-headless-shell 151，见 results/W1543-html-preview.md）：
//        · csp 属性 + sandbox ⇒ 外部 beacon 命中 **0**，alert **0** 次；
//        · 仅 sandbox（无 csp）⇒ 外部 beacon 命中 **1**（证明 csp 真的吃劲）；
//        · 裸 iframe（无 sandbox 无 csp）⇒ alert **真的弹**（证明负控制吃劲）；
//        · 像素比对：csp 属性与不加 csp 的渲染**逐像素同分布**
//          （红底 98.5% / 白字 0.77% 完全一致；空白对照为 100% 绿）
//          ⇒ csp 属性**不拦文档本体**，只拦它该拦的网络与脚本。
//
//      已知边界（诚实登记，不装作没有）：
//        · csp 属性是 Chromium 系（CSPEE）特性。Firefox/Safari 不认它 ⇒ 在那两个
//          浏览器上**这一层降级为不生效**，但 ① ② 两层仍然成立（脚本照样被 sandbox
//          拦住）。残余风险仅是「非 Chromium 浏览器上预览页会尝试请求外部资源」。
//          取舍理由：本仓前端由 DSH Web GUI 承载、验证口径就是 Chromium（真机 CDP），
//          而 meta 注入那条路的代价是**必然**破坏 HTML 保真 —— 一个确定的坏处换一个
//          有界的降级，且降级面不是 XSS 面（脚本仍被 sandbox 挡死）。
//        · 本模块不做 HTML 净化（sanitize）。净化是**替代**方案，不是叠加方案：
//          净化会吃掉 <script>/<style>/内联样式，预览出来的就不是用户写的那份 HTML。
//          这里选「沙箱 + CSP 属性」正是因为它保留**逐字节**的原始 HTML。
//        · 相对路径资源（<img src="foo.png">）在 srcdoc 文档里相对 about:srcdoc 解析，
//          本来就取不到；配合 CSP 一律不加载。预览是**合成文档**，不是「在文件目录里
//          打开一个站点」，所以这符合预期。
// ============================================================================

/** 预览 iframe 的 class（样式在 styles/preview.css）。 */
export const HTML_FRAME_CLASS = 'preview-html-frame';

/**
 * 预览 iframe 的 sandbox 令牌（**最小权限**，逐条论证见文件头注）。
 *
 * ★ 绝不含 allow-same-origin（与 allow-scripts 同用即突破沙箱）。
 * ★ 绝不含 allow-scripts（验收要求「脚本未执行」；给了它 alert 会真的弹）。
 *   本字符串由 tests/w1534-html-sandbox.test.ts 逐令牌断言（正控 + 反控）。
 */
export const PREVIEW_SANDBOX = 'allow-popups';

/**
 * 注入预览 iframe 的 CSP：默认**不加载任何外部网络资源**，且不允许脚本。
 *
 * script-src 'none'（而非任务书草稿里的 'unsafe-inline' 'unsafe-eval'）是**刻意更严**：
 * ② 已经关掉脚本，这条是第二道锁 —— 万一将来有人误加 allow-scripts，内联脚本仍被拦。
 * 与验收「<script>alert(1)</script> 必须无弹窗」同向，故取严不取宽。
 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * 把沙箱令牌落到 iframe 上（**唯一**设置点）。
 *
 * 只设置 sandbox 一个属性；srcdoc 由调用方用 **DOM property setter** 赋值
 * （不能用 setAttribute：见 renderers.ts 的 htmlFrameNode 注释）。
 */
export function applySandbox(frame: HTMLIFrameElement): void {
  frame.setAttribute('sandbox', PREVIEW_SANDBOX);
}

/**
 * 把 CSP 落到 iframe 的 **csp 属性**上（不是往 HTML 里插 meta）。
 *
 * 见文件头注 ③：属性由元素携带 ⇒ 文档源文本保持逐字节不变。
 */
export function applyCsp(frame: HTMLIFrameElement): void {
  frame.setAttribute('csp', PREVIEW_CSP);
}

/**
 * 一次把两层策略都落到 iframe 上（调用方只需要这一个入口）。
 *
 * ★ 顺序有意义：**先**设 sandbox/csp 属性，**再**赋 srcdoc —— 让策略在文档
 *   开始解析之前就已就位（先解析后设策略会有一段无策略窗口）。
 */
export function applyPreviewPolicy(frame: HTMLIFrameElement): void {
  applySandbox(frame);
  applyCsp(frame);
}
