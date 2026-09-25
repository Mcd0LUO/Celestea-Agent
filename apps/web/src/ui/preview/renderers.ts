// ============================================================================
// ui/preview/renderers.ts — F2 文件侧边预览：**按类型分派渲染器**（code/markdown/
// image/diff/降级）。内容一律经 utils/sanitize 的 sanitizeNodes / renderMarkdownSafe
// 进 DOM，**绝不 innerHTML**；图片走 el('img')（objectURL/attachment URL 不走 sanitize
// 的 URL 白名单，沿用 ui/attachment-view.ts 的既有做法）。
// ============================================================================
import { el, esc } from '../../utils/dom';
import { renderMarkdownSafe, sanitizeNodes } from '../../utils/sanitize';
import { extOf, type PreviewKind } from './detect';
import { applyPreviewPolicy, HTML_FRAME_CLASS } from './sandbox';
import type { PreviewView } from './modes';
import { t } from '../../i18n';

// W1545：扩展名表搬到 ./lang（流式分段块与整篇预览必须用同一份，见其头注）。
import { LANG_BY_EXT } from './lang';

/** 预览内容渲染结果（degraded 非空 = 降级态，panel 据此加类）。 */
export interface PreviewContent {
  node: HTMLElement;
  degraded: string | null;
}

export interface PreviewInput {
  path: string;
  kind: PreviewKind;
  /** 会话内已出现的全文（工具结果 / 消息文本）；null = 不可得。 */
  text?: string | null;
  /** 图片预览地址（objectURL / attachment URL）。 */
  url?: string | null;
  /** 调用方已知的降级原因（如服务端 kind=binary / 读取失败）：直接渲染可读原因，不再猜。 */
  degraded?: string;
  /** 降级态的类型标记（面板据此加类；缺省用 degraded 本身）。 */
  badge?: string;
  /** 查看方式（只对 html 有意义：'preview' 渲染页面 / 'source' 高亮源码）。 */
  view?: PreviewView;
}

/**
 * 单文件预览的**硬上限**（字符）：不是「渲染预算」，而是防跑飞的绝对闸门。
 *
 * ★ W1545：此前是 256 KiB，超过就整篇降级成「文件过大」—— 用户报的「文件管理器里
 *   打开大文件看不到内容」正是它。现在巨文件走**分段流式追加**（见 panel.ts 的
 *   streamInto / workbench/files-open.ts 的分段 provider），这个常量退化为
 *   「一次会话里最多往 DOM 里放多少字符」的兜底：正常 5000 行 / 700 KiB 的文件
 *   根本碰不到它。撞到它是**显式告知**（面板脚注 + 可读降级），不是静默截断。
 */
export const PREVIEW_MAX_CHARS = 8 * 1024 * 1024;

function codeNode(text: string, path: string): HTMLElement {
  const pre = el('pre', 'preview-code');
  const code = el('code');
  code.textContent = text;
  const lang = LANG_BY_EXT[extOf(path)];
  // 只**声明**语言（hljs 读这个 class）；真正的高亮由调用方在插入后跑增强缝完成。
  // 未登记的语言不声明 class ⇒ 渲染为纯文本（避免 plaintext 告警）。
  if (lang) code.className = 'language-' + lang;
  pre.appendChild(code);
  return pre;
}

function markdownNode(text: string): HTMLElement {
  const box = el('div', 'preview-md');
  renderMarkdownSafe(box, text);
  return box;
}

/**
 * HTML 预览：把原文交给一个**沙箱 iframe** 渲染（W1534）。
 *
 * 三条都必须照做，缺一不可：
 *
 * ① **srcdoc 一律用 DOM property setter**（`frame.srcdoc = html`），
 *    不用 `setAttribute('srcdoc', …)`、更不字符串拼属性。
 *
 *    ★ 诚实登记（W1543 实测更正）：在 chrome-headless-shell 151 上，
 *      `f.srcdoc = html` 与 `f.setAttribute('srcdoc', html)` 对
 *      plain / 引号 / <script> / &amp; 四类样本**逐字节等价**（propEq 与 attrEq 全 true）。
 *      所以这条**不是**「不改就会坏」的运行时契约 —— 行为断言抓不到它
 *      （变异 5：改成 setAttribute ⇒ 13 条里只红新增的那条源码形状断言）。
 *      它守的是**心智路径**：property setter 表达「把这份字符串当文档」，
 *      setAttribute 表达「序列化一个属性值」，后者会诱使后来者去手工转义
 *      `&` / 引号 —— 那才会真的破坏用户 HTML。
 *      ⇒ 由 tests/w1534-html-sandbox.test.ts 的「srcdoc 必须用 DOM property setter」
 *        一条**源码形状**断言钉住（与 apps/web/tools/check-*.mjs 同一手法）。
 *    保真本身的断言（srcdoc === 原文，逐字节）在同文件另有一条，那是**行为**层。
 *
 * ② **sandbox 由 applySandbox() 统一设置**（见 sandbox.ts 的逐条论证）：
 *    不含 allow-same-origin ⇒ 预览文档活在不透明源里。
 *    直接后果：**frame.contentDocument === null**（父页面无权访问它的文档）。
 *    这是隔离生效的**正控**，不是缺陷 —— 也正因为如此，写入只能走 srcdoc，
 *    不能走 contentDocument.write。
 *
 * ③ CSP（默认不加载任何外部网络资源）走 iframe 的 **csp 属性**，由
 *    applyPreviewPolicy() 一次落位 —— **不是**往 HTML 里插 <meta>。
 *    W1534 原先插 meta，代价是 srcdoc ≠ 原文（实体保真这条验收直接红）；
 *    W1543 改为属性机制后 srcdoc 逐字节等于用户原文。详见 sandbox.ts 头注 ③。
 */
function htmlFrameNode(text: string): HTMLElement {
  const box = el('div', 'preview-html');
  const frame = el('iframe', HTML_FRAME_CLASS) as HTMLIFrameElement;
  // 屏幕阅读器按标题列出 frame：没有 title 的 iframe 是不可访问的。
  frame.title = t('chat.preview.htmlFrameTitle');
  // ★ 策略先就位（sandbox ② + csp ③）：属性由元素携带，在文档开始解析前生效。
  //   唯一设置点，测试对它们做变异负控制。
  applyPreviewPolicy(frame);
  // ★ property setter（见 ①），不是 setAttribute；且赋的是**原文**（逐字节保真）。
  frame.srcdoc = text;
  box.appendChild(frame);
  return box;
}

function imageNode(url: string, alt: string): HTMLElement {
  const box = el('div', 'preview-img');
  const img = el('img') as HTMLImageElement;
  img.src = url;
  img.alt = alt;
  box.appendChild(img);
  return box;
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return ' hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return ' add';
  if (line.startsWith('-') && !line.startsWith('---')) return ' del';
  return '';
}

function diffNode(text: string): HTMLElement {
  const html = text
    .split('\n')
    .map((l) => '<span class="preview-diff-line' + diffLineClass(l) + '">' + esc(l) + '</span>')
    .join('\n');
  const box = el('div', 'preview-diff');
  box.replaceChildren(...sanitizeNodes(html));
  return box;
}

function degradedNode(reason: string): HTMLElement {
  const box = el('div', 'preview-degrade');
  box.replaceChildren(...sanitizeNodes('<div class="preview-degrade-reason">' + esc(reason) + '</div>'));
  return box;
}

function hasBinary(text: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

/** 按类型分派；内容一律 sanitizeNodes/纯 DOM。 */
export function renderPreview(input: PreviewInput): PreviewContent {
  if (input.degraded !== undefined) return { node: degradedNode(input.degraded), degraded: input.badge ?? input.degraded };
  if (input.kind === 'image') {
    if (input.url) return { node: imageNode(input.url, input.path), degraded: null };
    return { node: degradedNode(t('chat.preview.degradeImage')), degraded: t('chat.preview.badgeImage') };
  }
  const text = input.text ?? null;
  if (text === null) {
    return { node: degradedNode(t('chat.preview.degradeNotInSession')), degraded: t('chat.preview.badgeNotInSession') };
  }
  if (hasBinary(text)) return { node: degradedNode(t('chat.preview.degradeBinary')), degraded: t('chat.preview.badgeBinary') };
  if (text.length > PREVIEW_MAX_CHARS) return { node: degradedNode(t('chat.preview.degradeTooLarge')), degraded: t('chat.preview.badgeTooLarge') };
  if (input.kind === 'markdown') return { node: markdownNode(text), degraded: null };
  if (input.kind === 'diff') return { node: diffNode(text), degraded: null };
  // HTML：默认**渲染预览**（「打开一个 HTML 想看到页面」是主流预期，与 GitHub /
  // VSCode 的 HTML 预览同一取舍）；切到「源码」时复用 code 分支（language-xml 高亮）。
  // 两个分支读的是**同一份 text**，所以来回切换不丢内容、不重新加载。
  if (input.kind === 'html') {
    if (input.view === 'source') return { node: codeNode(text, input.path), degraded: null };
    return { node: htmlFrameNode(text), degraded: null };
  }
  if (input.kind === 'code') return { node: codeNode(text, input.path), degraded: null };
  return { node: degradedNode(t('chat.preview.degradeUnsupported')), degraded: t('chat.preview.badgeUnsupported') };
}
