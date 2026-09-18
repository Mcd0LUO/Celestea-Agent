// ============================================================================
// utils/markdown-heading-id.ts — 标题 id 生成（本地复刻 marked@4.3.0 Slugger）
//
// 背景：marked v4→v5 上游移除了 headerIds/Slugger，v18 的 Renderer.heading()
//   只产出 `<hN>…</hN>`（无 id）。本项目 retain 标题 id（sanitize.ts 的 id 白名单、
//   会话内定位都依赖它），因此这里逐字节复刻 v4 的算法，零新依赖——不引
//   marked-gfm-heading-id / github-slugger（slug 算法不同，会改变既有 id）。
//
// 复刻来源：marked@4.3.0 lib/marked.cjs
//   · Slugger.serialize / getNextSafeSlug；
//   · Renderer.heading：id = headerPrefix(默认空) + slugger.slug(raw)，其中
//     raw = unescape(parseInline(tokens, textRenderer))（v4 对 named entity 一律
//     丢弃、`&#...`/`&#x...` 还原——见 unescapeHtml）。
//
// 跨块语义：MarkdownStream 把「已固化前缀」与「尾部」分开渲染，但标题 id 计数器
//   必须连续。调用方传入同一份 seen（计数/占用表）：persist=true 时渲染结果回写
//   seen（固化块），false 时只在副本上算（尾部每 tick 重解析，回写会重复计数）。
// ============================================================================
import { marked, Parser, Renderer, type Tokens } from 'marked';

/** 标题 slug 计数表：key 为 id（含已占用者，值 0），值为同名递增计数。 */
export type SluggerSeen = Record<string, number>;

// v4 的 unescapeTest / unescape。
const UNESCAPE_TEST = /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/gi;
function unescapeHtml(html: string): string {
  return html.replace(UNESCAPE_TEST, (_, n: string) => {
    const name = n.toLowerCase();
    if (name === 'colon') return ':';
    if (name.charAt(0) === '#') {
      return name.charAt(1) === 'x'
        ? String.fromCharCode(parseInt(name.substring(2), 16))
        : String.fromCharCode(+name.substring(1));
    }
    return '';
  });
}

/** v4 Slugger.serialize：小写 + 去 HTML 标签 + 去标点 + 空白转连字符。 */
function serializeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[!\/a-z].*?>/gi, '')
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s/g, '-');
}

/**
 * v4 Slugger.getNextSafeSlug：同名递增 -1、-2…；把计数写回 seen（seen 一并充当
 * 「已用 id」表，值为 0 表示该 slug 已被占用）。
 */
function nextSafeSlug(seen: SluggerSeen, originalSlug: string): string {
  let slug = originalSlug;
  let occurrence = 0;
  if (Object.prototype.hasOwnProperty.call(seen, slug)) {
    occurrence = seen[originalSlug] ?? 0;
    do {
      occurrence++;
      slug = originalSlug + '-' + occurrence;
    } while (Object.prototype.hasOwnProperty.call(seen, slug));
  }
  seen[originalSlug] = occurrence;
  seen[slug] = 0;
  return slug;
}

/**
 * 带标题 id 的局部 Renderer：只覆写 heading()，其余沿用 v18 默认实现。
 * 用局部实例（而非 marked.use 全局注册），既避免污染全局，又能带入 per-stream 的 seen。
 */
class HeadingIdRenderer extends Renderer {
  constructor(private readonly seen: SluggerSeen) {
    super();
  }

  override heading({ tokens, depth }: Tokens.Heading): string {
    const text = this.parser.parseInline(tokens);
    const raw = unescapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer));
    const id = nextSafeSlug(this.seen, serializeSlug(raw));
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  }
}

/**
 * 用自带 seen 的 Parser 渲染（等价于 marked.parse，但标题 id 计数器可跨块连续）。
 * 复制默认选项（不污染 marked.defaults）：Parser 构造器会往 options 上写 renderer。
 */
export function parseWithHeadingIds(seen: SluggerSeen, text: string, persist: boolean): string {
  const opts = { ...marked.defaults, renderer: new HeadingIdRenderer(persist ? seen : { ...seen }) };
  const parser = new Parser(opts);
  return parser.parse(marked.lexer(text, opts));
}
