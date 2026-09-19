// ============================================================================
// ui/preview/renderers.ts — F2 文件侧边预览：**按类型分派渲染器**（code/markdown/
// image/diff/降级）。内容一律经 utils/sanitize 的 sanitizeNodes / renderMarkdownSafe
// 进 DOM，**绝不 innerHTML**；图片走 el('img')（objectURL/attachment URL 不走 sanitize
// 的 URL 白名单，沿用 ui/attachment-view.ts 的既有做法）。
// ============================================================================
import { el, esc } from '../../utils/dom';
import { renderMarkdownSafe, sanitizeNodes } from '../../utils/sanitize';
import { highlightCode } from '../../utils/hljs';
import { extOf, type PreviewKind } from './detect';

/** 扩展名 → highlight.js 已注册语言（未登记的语言不调 hljs，渲染为纯文本）。 */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', java: 'java', c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'css', less: 'css', yaml: 'yaml', yml: 'yaml',
};

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
}

/** 单文件预览上限（字符）：超过只给可读原因，不硬塞进 DOM。 */
export const PREVIEW_MAX_CHARS = 256 * 1024;

function codeNode(text: string, path: string): HTMLElement {
  const pre = el('pre', 'preview-code');
  const code = el('code');
  code.textContent = text;
  const lang = LANG_BY_EXT[extOf(path)];
  if (lang) code.className = 'language-' + lang; // 有映射才调 hljs（避免 plaintext 告警）
  pre.appendChild(code);
  if (lang) highlightCode(pre);
  return pre;
}

function markdownNode(text: string): HTMLElement {
  const box = el('div', 'preview-md');
  renderMarkdownSafe(box, text);
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
  if (input.kind === 'image') {
    if (input.url) return { node: imageNode(input.url, input.path), degraded: null };
    return { node: degradedNode('这张图片的字节不在本次会话里，无法放大查看'), degraded: '图片不可预览' };
  }
  const text = input.text ?? null;
  if (text === null) {
    return { node: degradedNode('这个文件的内容不在本次会话里（只预览会话内已经出现过的内容）'), degraded: '内容不在会话里' };
  }
  if (hasBinary(text)) return { node: degradedNode('这是二进制内容，无法按文本预览'), degraded: '二进制内容' };
  if (text.length > PREVIEW_MAX_CHARS) return { node: degradedNode('文件过大，无法在这里完整预览'), degraded: '文件过大' };
  if (input.kind === 'markdown') return { node: markdownNode(text), degraded: null };
  if (input.kind === 'diff') return { node: diffNode(text), degraded: null };
  if (input.kind === 'code') return { node: codeNode(text, input.path), degraded: null };
  return { node: degradedNode('这个类型暂时不能预览，可复制路径后在文件管理器里打开'), degraded: '类型不支持' };
}
