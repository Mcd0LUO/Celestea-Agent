// ============================================================================
// utils/sanitize.ts — 不可信 HTML 的白名单消毒（W739 · P1 安全）
//
// 威胁模型：**所有**进入 markdown 渲染管线的文本都属于不可信输入 ——
//   模型输出正文（含裸 HTML）、工具参数与结果、会话历史、worker 回执等。
//   marked v4 已移除 sanitize 选项，默认把原文里的裸 HTML 原样透传，
//   因此「marked.parse → innerHTML」等价于任意 HTML 注入：
//     <img src=x onerror=...> · <script> · <iframe srcdoc> · <a href="javascript:">
//     · <svg onload> · style/on* 属性 · data:/vbscript: URL … ⇒ DOM 注入 / XSS。
//
// 方案：**唯一出口 + 白名单消毒**（不引入新依赖，纯 DOM 实现）
//   1) 解析在**惰性文档**里完成：template.innerHTML 的内容属于独立的 inert
//      document fragment —— 脚本不执行、图片/样式/媒体不加载，因此这一步
//      没有任何副作用；清洗完成后才把节点交给真实 DOM。
//   2) 逐节点白名单清洗：
//        · 元素：未列入白名单者 → 解包（保留文字，丢标签）；危险容器
//          （script/style/iframe/svg/math/form/…）→ 连内容一起丢弃；
//        · 属性：只保留该标签允许的属性；on* / style / srcdoc / srcset /
//          formaction / is / ping 等一律剔除（属性白名单 + on* 兜底）；
//        · URL：href/src 只允许 http(s) / mailto / tel 与相对路径，
//          javascript: / data: / vbscript: / blob: / file: 一律剔除
//          （先剥掉控制字符与空白再判 scheme，防 java\tscript: 绕过）；
//        · class/id：只保留安全字符集（hljs 的 hljs-*、language-*、
//          marked 的 task-list-item 等均不受影响）；
//        · 注释 / CDATA / PI / doctype：一律丢弃。
//   3) 统一出口（**所有** HTML → DOM 的写入点必须走其中之一）：
//        sanitizeNodes(html) → Node[]      字符串 → 已消毒节点（唯一低层通道）
//        renderHtmlSafe(el, html)          el 内容整体替换为已消毒节点
//        renderMarkdownSafe(el, markdown)  markdown → 已消毒节点 → el
//        sanitizeHtml(html) → string       需要字符串出口时的消毒版
//
// 注意：本模块依赖 DOM，**不要**被 utils/markdown.ts 引用 —— markdown.ts 保持
//   零 DOM 依赖（bench/markdown-render-bench.mjs 在 Node 里直接跑它）。
//
// 已知限制（详见 W739 报告）：
//   · 不保留表单控件除「任务清单复选框」以外的交互（input 只允许
//     type=checkbox 且强制 disabled）；
//   · 不保留内联 style / <style> / data: 图片（安全优先）；
//   · 不做 URL 域名白名单（内网 UI，链接可点即视为可接受风险）。
// ============================================================================
import { renderMarkdown } from './markdown';

/** 允许保留的元素（其余元素：解包或整体丢弃）。 */
const ALLOWED_TAGS = new Set<string>([
  // 结构 / 块级
  'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'details', 'summary',
  'figure', 'figcaption',
  // 行内
  'a', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark',
  'small', 'sub', 'sup', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn',
  'code', 'time', 'bdi', 'bdo', 'wbr', 'ruby', 'rt', 'rp',
  // GFM 任务清单复选框（属性被限制为 type=checkbox + disabled）
  'input',
]);

/**
 * 危险容器：元素**连同内容**一起丢弃（内容可能被下游当作标记重新解析，
 * 或触发资源加载 / 脚本执行）。未列入白名单的其它元素一律解包保留文字。
 */
const DROP_WITH_CONTENT = new Set<string>([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'noframes',
  'object', 'embed', 'applet', 'param', 'link', 'meta', 'base', 'basefont',
  'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'picture',
  'plaintext', 'xmp', 'listing', 'marquee', 'portal', 'slot', 'dialog',
  'form', 'fieldset', 'legend', 'select', 'option', 'optgroup', 'textarea', 'button',
  'title', 'head', 'html', 'body',
]);

/** 所有标签都可保留的属性。 */
const GLOBAL_ATTRS = new Set<string>(['class', 'id', 'title', 'dir', 'lang']);

/** 按标签追加允许的属性。 */
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'align', 'scope'],
  th: ['colspan', 'rowspan', 'align', 'scope'],
  col: ['span', 'width'],
  colgroup: ['span'],
  time: ['datetime'],
  details: ['open'],
  input: ['type', 'checked', 'disabled'],
};

/** URL 属性只允许的 scheme（其余显式 scheme 一律拒绝；相对路径放行）。 */
const SAFE_SCHEMES = new Set<string>(['http', 'https', 'mailto', 'tel']);

/** class 令牌：hljs（hljs-title / function_）、marked（language-js）都在此字符集内。 */
const CLASS_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// id：允许 Unicode 字母/数字（marked 的中文标题 slug 形如「标题-a」，限定 ASCII
//     会让中文标题/锚点链接丢 id）
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,63}$/u;
const NUM_ATTR_RE = /^-?\d{1,6}$/;
const SIZE_ATTR_RE = /^\d{1,4}$/;
const MAX_ATTR_VALUE = 2048;
const ALIGN_VALUES = ['left', 'center', 'right', 'justify'];
const DIR_VALUES = ['ltr', 'rtl', 'auto'];
const OL_TYPE_VALUES = ['1', 'a', 'A', 'i', 'I'];

/**
 * 属性值 → 安全 URL；不安全返回 null（调用方删除该属性）。
 * 先剥离所有 C0/C1 控制字符与空白，再判 scheme —— 阻断 java\tscript: /
 * java&#x0a;script:（实体已在解析阶段解码）等绕过写法。
 */
function safeUrl(raw: string): string | null {
  const squeezed = raw.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  if (squeezed === '') return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(squeezed);
  if (m !== null) {
    const scheme = (m[1] ?? '').toLowerCase();
    if (!SAFE_SCHEMES.has(scheme)) return null;
  }
  return raw;
}

/** class 属性值 → 只保留安全令牌（全部被滤掉则返回 null）。 */
function safeClassValue(raw: string): string | null {
  const kept = raw
    .split(/[\s\u0000-\u001f]+/)
    .filter((t) => CLASS_TOKEN_RE.test(t))
    .slice(0, 32);
  return kept.length === 0 ? null : kept.join(' ');
}

/** 按标签清理属性；命中黑名单 / 非法值一律 removeAttribute。 */
function scrubAttrs(el: Element, tag: string): void {
  const extra = TAG_ATTRS[tag];
  // 倒序遍历活属性表：删除当前项不影响未访问的下标，且免去 Array.from 的分配
  // （流式渲染每节拍都会走这条路径，热路径上不分配数组）
  for (let i = el.attributes.length - 1; i >= 0; i -= 1) {
    const attr = el.attributes[i];
    if (attr === undefined) continue;
    const name = attr.name.toLowerCase();
    const listed = GLOBAL_ATTRS.has(name) || (extra !== undefined && extra.indexOf(name) !== -1);
    // on*（事件处理器）与一切非白名单属性（style/srcdoc/srcset/formaction/is/…）剔除
    if (!listed || name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    const value = attr.value;
    if (value.length > MAX_ATTR_VALUE) {
      el.removeAttribute(attr.name);
      continue;
    }
    switch (name) {
      case 'class': {
        const v = safeClassValue(value);
        if (v === null) el.removeAttribute(attr.name);
        else el.setAttribute('class', v);
        break;
      }
      case 'id': {
        if (!ID_RE.test(value)) el.removeAttribute(attr.name);
        break;
      }
      case 'href':
      case 'src': {
        const v = safeUrl(value);
        if (v === null) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, v);
        break;
      }
      case 'width':
      case 'height': {
        if (!SIZE_ATTR_RE.test(value)) el.removeAttribute(attr.name);
        break;
      }
      case 'colspan':
      case 'rowspan':
      case 'span':
      case 'start':
      case 'value': {
        if (!NUM_ATTR_RE.test(value)) el.removeAttribute(attr.name);
        break;
      }
      case 'align': {
        if (ALIGN_VALUES.indexOf(value.toLowerCase()) === -1) el.removeAttribute(attr.name);
        break;
      }
      case 'dir': {
        if (DIR_VALUES.indexOf(value.toLowerCase()) === -1) el.removeAttribute(attr.name);
        break;
      }
      case 'type': {
        // <ol type> / <input type=checkbox>；其余 type（含 submit/button）拒绝
        const ok =
          tag === 'ol'
            ? OL_TYPE_VALUES.indexOf(value) !== -1
            : tag === 'input' && value.toLowerCase() === 'checkbox';
        if (!ok) el.removeAttribute(attr.name);
        break;
      }
      default:
        break;
    }
  }
  if (tag === 'input') {
    // 任务清单复选框：只读、不可提交 —— 不保留任何可交互 / 可提交语义
    if ((el.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') {
      el.remove();
      return;
    }
    el.setAttribute('type', 'checkbox');
    el.setAttribute('disabled', '');
  }
}

/** 解包元素：子节点顶替它的位置，元素本身移除（子节点须已消毒）。 */
function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (parent === null) return;
  while (el.firstChild !== null) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/** 递归白名单清洗（原地）。 */
function clean(parent: ParentNode): void {
  // 手工遍历（先取 next 再处理）：处理过程中当前节点可能被删除或解包 ——
  // 解包时子节点已消毒，跳过它们正是我们要的语义。热路径上不分配节点数组。
  let node: Node | null = parent.firstChild;
  while (node !== null) {
    const next: Node | null = node.nextSibling;
    switch (node.nodeType) {
      case 3: // TEXT_NODE：文本不会被重新解析，天然安全
        break;
      case 1: {
        // ELEMENT_NODE
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (ALLOWED_TAGS.has(tag)) {
          scrubAttrs(el, tag);
          clean(el);
          break;
        }
        if (DROP_WITH_CONTENT.has(tag)) {
          parent.removeChild(el);
          break;
        }
        // 其它未列入白名单的容器 / 自定义元素：先消毒子树，再解包保留文字
        clean(el);
        unwrap(el);
        break;
      }
      default:
        // 注释 / CDATA / PI / doctype：一律丢弃
        parent.removeChild(node);
        break;
    }
    node = next;
  }
}

/** 在惰性文档里解析一段 HTML（不执行脚本、不加载资源）。 */
function parseInert(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

/**
 * 不可信 HTML → 已消毒节点数组（**唯一**的 HTML → DOM 低层通道）。
 * 返回值可直接交给 replaceChildren / appendChild 插入真实 DOM。
 */
export function sanitizeNodes(html: string): Node[] {
  if (html === '') return [];
  const frag = parseInert(html);
  clean(frag);
  return Array.from(frag.childNodes);
}

/** 不可信 HTML → 已消毒 HTML 字符串（需要字符串出口时使用）。 */
export function sanitizeHtml(html: string): string {
  if (html === '') return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  clean(tpl.content);
  return tpl.innerHTML;
}

/** 把 HTML 安全写入元素（整体替换为已消毒节点；单次替换，无空白帧）。 */
export function renderHtmlSafe(el: Element, html: string): void {
  el.replaceChildren(...sanitizeNodes(html));
}

/** 统一出口：不可信 markdown → 消毒 → 写入元素。 */
export function renderMarkdownSafe(el: Element, markdown: string): void {
  renderHtmlSafe(el, renderMarkdown(markdown));
}
