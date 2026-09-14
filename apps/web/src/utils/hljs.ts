// ============================================================================
// Code highlighting — highlight.js core + a lean registered language set
// (token colors come from theme CSS via .hljs-* classes)
//
// W301：增加内容键缓存（key = lang + '\0' + code 文本）+ 有界 LRU：
//   流式渲染每个节拍都会重建正文 innerHTML，`dataset.hlDone` 随之失效，
//   导致每个代码块每帧全量重高亮（128K 文本 ≈ 43 块 ≈ 70ms/帧）。
//   缓存命中时直接写回 HTML，未命中才调 hljs；超大单块（>32KB）跳过。
// ============================================================================
import hljs from 'highlight.js/lib/core';
import { renderHtmlSafe } from './sanitize';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// ---- 高亮结果缓存（有界 LRU） -------------------------------------------------

/** 缓存条目：高亮后的 innerHTML + 与 hljs.highlightElement 产出等价的 class。 */
interface HlEntry {
  html: string;
  cls: string;
  /** 估算占用（UTF-16 字符数 × 2 字节） */
  bytes: number;
}

const HL_MAX_ENTRIES = 128;                    // 条目上限
const HL_MAX_BYTES = 2 * 1024 * 1024;          // 总字节上限 2MB
const HL_MAX_BLOCK_CHARS = 32 * 1024;          // 单块源码 >32KB → 跳过高亮

const hlCache = new Map<string, HlEntry>();    // Map 迭代序 = LRU 序（旧 → 新）
let hlCacheBytes = 0;

/** 命中即视为最近使用（移到队尾）。 */
function cacheGet(key: string): HlEntry | undefined {
  const e = hlCache.get(key);
  if (e === undefined) return undefined;
  hlCache.delete(key);
  hlCache.set(key, e);
  return e;
}

/** 写入缓存并按 LRU 淘汰到上限内。 */
function cacheSet(key: string, html: string, cls: string): void {
  const bytes = (key.length + html.length + cls.length) * 2;
  if (bytes > HL_MAX_BYTES) return; // 单条已超总上限：不缓存（仍可用）
  const prev = hlCache.get(key);
  if (prev) hlCacheBytes -= prev.bytes;
  hlCache.set(key, { html, cls, bytes });
  hlCacheBytes += bytes;
  while (hlCache.size > HL_MAX_ENTRIES || hlCacheBytes > HL_MAX_BYTES) {
    const oldest = hlCache.keys().next();
    if (oldest.done === true) break;
    const e = hlCache.get(oldest.value);
    if (e) hlCacheBytes -= e.bytes;
    hlCache.delete(oldest.value);
  }
}

/** 从 class 里取 language-xxx 的语言名（无则空串）。 */
function langOf(block: HTMLElement): string {
  const m = /(?:^|\s)language-([\w-]+)/.exec(block.className);
  return m?.[1] ?? '';
}

/** Highlight every not-yet-processed <pre><code> inside a container. */
export function highlightCode(container: Element): void {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre code'));
  for (const block of blocks) {
    if (block.dataset.hlDone === '1') continue;
    const code = block.textContent ?? '';
    // 超大单块：跳过高亮（language-plaintext），避免单块拖垮主线程
    if (code.length > HL_MAX_BLOCK_CHARS) {
      if (block.className.indexOf('language-') === -1) block.className += ' language-plaintext';
      block.dataset.hlDone = '1';
      continue;
    }
    const key = langOf(block) + '\u0000' + code;
    const hit = cacheGet(key);
    if (hit) {
      // 命中：写回缓存 HTML + class（与 hljs.highlightElement 产出等价）
      // W739：写回同样过 utils/sanitize 白名单（缓存内容派生自不可信代码文本，
      //       且 hljs 的 class 名（hljs-* / language-*）在白名单内 → 不丢高亮）
      renderHtmlSafe(block, hit.html);
      block.className = hit.cls;
      block.dataset.hlDone = '1';
      continue;
    }
    if (block.className.indexOf('language-') === -1) block.className += ' language-plaintext';
    try {
      hljs.highlightElement(block);
      block.dataset.hlDone = '1';
      cacheSet(key, block.innerHTML, block.className);
    } catch {
      /* unknown language → plain text */
    }
  }
}
