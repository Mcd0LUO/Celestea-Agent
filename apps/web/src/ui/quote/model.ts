// ============================================================================
// ui/quote/model.ts — F1 选段提及：引用块的**格式**与纯函数（零 DOM、零网络）。
// ----------------------------------------------------------------------------
// 引用 = **内容快照**（不是指针）。发送时序列化进用户消息文本，与 W869 文本附件同构。
// 格式（定界行 ASCII、全仓唯一、不含引号/反引号）：
//   ===== CELESTEA QUOTE =====
//   [引用 1 · assistant · 第 3 轮 · Studio · 128B · trunc=0 · fmt=markdown]
//   > 第一行
//   > 第二行
//   ===== CELESTEA QUOTE =====
// 正文行含定界串 ⇒ 追加 QUOTE_ESCAPE_SUFFIX；escape/unescape 是**行集合上的双射**。
//
// 往返口径（架构侧裁决，2026-09-19）：**文本级恒等 + wire 编码字段级恒等**。
//   · 文本级：serializeQuotes(base, parse(serializeQuotes(base, qs)).quotes) === serializeQuotes(base, qs)
//   · 字段级：text/source.kind/source.turn/source.label/bytes/truncated/format/filePath/lineRange 精确恢复
//   · 明确**不入 wire**：id（解析按序重编 q1…）、hash、source.session、source.anchor、range
//     —— 绝不为了「QuoteRef 深度相等」把 64 位 hex 塞进模型上下文。
// 上限（F 文档 §1）：单条 8 KiB、单条消息引用总量 32 KiB、最多 8 条；超限显式截断并标注。
// ============================================================================

export type QuoteKind = 'user' | 'assistant' | 'tool' | 'inbox';
export type QuoteFormat = 'text' | 'markdown' | 'code';

/** 引用来源（展示用标签 + 客户端定位信息）。 */
export interface QuoteSource {
  kind: QuoteKind;
  /** 来源会话 id（客户端存；**不入 wire**）。 */
  session: string;
  /** 轮次（1 起；取不到则 undefined，wire 写「轮次未知」）。 */
  turn?: number;
  /** 人读标签（已 sanitize：不含 " · "、"]"、CR/LF）。 */
  label: string;
  /** 可选稳定锚点（客户端存；**不入 wire**）。 */
  anchor?: string;
}

/** 源文本内的字符偏移（客户端存；**不入 wire**）。 */
export interface QuoteRange { start: number; end: number }
/** 代码引用的行范围（入 wire）。 */
export interface QuoteLineRange { startLine: number; endLine: number }

/** 一条引用（快照 + 来源 + 客户端去重/过期依据）。 */
export interface QuoteRef {
  id: string;
  source: QuoteSource;
  /** 快照正文（已 cap）。 */
  text: string;
  /** sha256 hex（小写）；仅客户端去重用，**不入 wire**。 */
  hash: string;
  /** utf8Bytes(text)。 */
  bytes: number;
  truncated: boolean;
  range?: QuoteRange;
  format?: QuoteFormat;
  filePath?: string;
  lineRange?: QuoteLineRange;
}

/** 定界行：ASCII、全仓唯一、不含引号/反引号（实现时已全仓 grep 确认）。 */
export const QUOTE_BLOCK_DELIMITER = '===== CELESTEA QUOTE =====';
/** 转义后缀：正文行含定界串时追加，解析时反向剥离。 */
export const QUOTE_ESCAPE_SUFFIX = ' [CELESTEA-QUOTE-ESCAPED]';
/** 单条引用上限（UTF-8 字节）。 */
export const QUOTE_MAX_BYTES = 8 * 1024;
/** 单条消息引用总量上限（UTF-8 字节）。 */
export const QUOTE_TOTAL_MAX_BYTES = 32 * 1024;
/** 单条消息最多引用条数。 */
export const QUOTE_MAX_PER_TURN = 8;

const KINDS: readonly QuoteKind[] = ['user', 'assistant', 'tool', 'inbox'];
const FORMATS: readonly QuoteFormat[] = ['text', 'markdown', 'code'];

/** UTF-8 字节数（零依赖）。 */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 来源标签 sanitize：保证 header 用 " · " 分隔可解析（幂等）。 */
export function sanitizeQuoteLabel(s: string): string {
  return s.replace(/\s*·\s*/g, ' ').replace(/\]/g, ')').replace(/[\r\n]+/g, ' ').trim();
}

/** 按 **码点** 截断到 maxBytes（绝不劈开代理对）；不追加省略号，截断由 truncated 表达。 */
export function capQuote(text: string, maxBytes: number = QUOTE_MAX_BYTES): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  const enc = new TextEncoder();
  let out = '';
  let used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return { text: out, truncated: true };
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

/** sha256 hex（小写）；无 WebCrypto 时返回 ''（去重退化为文本键）。 */
export async function hashQuote(text: string): Promise<string> {
  const subtle = globalThis.crypto ? globalThis.crypto.subtle : undefined;
  if (!subtle) return '';
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/** 去重键：内容 hash；无 hash（如历史解析出的引用）时退化为文本键。 */
export function quoteDedupKey(q: Pick<QuoteRef, 'hash' | 'text'>): string {
  return q.hash !== '' ? q.hash : 'x:' + q.text;
}

/** 造一条引用：sanitize 标签、cap 正文、算 bytes。 */
export function makeQuote(input: {
  id: string;
  source: QuoteSource;
  text: string;
  hash: string;
  range?: QuoteRange;
  format?: QuoteFormat;
  filePath?: string;
  lineRange?: QuoteLineRange;
  maxBytes?: number;
}): QuoteRef {
  const capped = capQuote(input.text, input.maxBytes ?? QUOTE_MAX_BYTES);
  return {
    id: input.id,
    source: { ...input.source, label: sanitizeQuoteLabel(input.source.label) },
    text: capped.text,
    hash: input.hash,
    bytes: utf8Bytes(capped.text),
    truncated: capped.truncated,
    ...(input.range ? { range: input.range } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.filePath !== undefined && input.filePath !== '' ? { filePath: input.filePath } : {}),
    ...(input.lineRange ? { lineRange: input.lineRange } : {}),
  };
}

/** 单行转义（双射）：含定界串 ⇒ 追加后缀。 */
export function escapeQuoteLine(line: string): string {
  return line.includes(QUOTE_BLOCK_DELIMITER) ? line + QUOTE_ESCAPE_SUFFIX : line;
}

/** 单行反剥离：以后缀结尾**且**去掉后缀后仍含定界串 ⇒ 去一次后缀。 */
export function unescapeQuoteLine(line: string): string {
  if (!line.endsWith(QUOTE_ESCAPE_SUFFIX)) return line;
  const cut = line.slice(0, line.length - QUOTE_ESCAPE_SUFFIX.length);
  return cut.includes(QUOTE_BLOCK_DELIMITER) ? cut : line;
}

function headerOf(q: QuoteRef, index: number, body: string, truncated: boolean): string {
  const parts: string[] = [
    '引用 ' + String(index + 1),
    q.source.kind,
    q.source.turn === undefined ? '轮次未知' : '第 ' + String(q.source.turn) + ' 轮',
    sanitizeQuoteLabel(q.source.label),
    String(utf8Bytes(body)) + 'B',
    'trunc=' + (truncated ? '1' : '0'),
  ];
  if (q.format) parts.push('fmt=' + q.format);
  if (q.filePath !== undefined && q.filePath !== '') parts.push('file=' + encodeURIComponent(q.filePath));
  if (q.lineRange) parts.push('lines=' + String(q.lineRange.startLine) + '-' + String(q.lineRange.endLine));
  return '[' + parts.join(' · ') + ']';
}

function buildBlock(q: QuoteRef, body: string, truncated: boolean, index: number): string {
  const lines = [QUOTE_BLOCK_DELIMITER, headerOf(q, index, body, truncated)];
  for (const raw of body.split('\n')) lines.push('> ' + escapeQuoteLine(raw));
  lines.push(QUOTE_BLOCK_DELIMITER);
  return lines.join('\n');
}

/**
 * 序列化并追加到 text 尾部；quotes 为空 ⇒ **原样返回 text**（零回归）。
 * 总量超限时对最后一条按剩余预算再 cap 并置 trunc=1（显式截断，绝不静默丢块）。
 */
export function serializeQuotes(text: string, quotes: readonly QuoteRef[]): string {
  if (quotes.length === 0) return text;
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < quotes.length; i++) {
    const q = quotes[i]!;
    const remaining = QUOTE_TOTAL_MAX_BYTES - used;
    if (remaining <= 0) break; // 防御性上限；正常路径由 tray 的预算守卫保证不触发
    const capped = capQuote(q.text, remaining);
    const truncated = q.truncated || capped.truncated;
    blocks.push(buildBlock(q, capped.text, truncated, i));
    used += utf8Bytes(capped.text);
    if (used >= QUOTE_TOTAL_MAX_BYTES) break;
  }
  return (text.trim() === '' ? '' : text + '\n\n') + blocks.join('\n\n');
}

function quoteFromHeader(header: string, text: string, index: number): QuoteRef {
  const parts = header.slice(1, -1).split(' · ');
  const fields = new Map<string, string>();
  for (let k = 1; k < parts.length; k++) {
    const p = parts[k]!;
    const eq = p.indexOf('=');
    if (eq > 0) fields.set(p.slice(0, eq), p.slice(eq + 1));
  }
  const kindRaw = parts[1] ?? '';
  const kind: QuoteKind = (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as QuoteKind) : 'user';
  const turnMatch = /^第 (\d+) 轮$/.exec(parts[2] ?? '');
  const label = parts[3] ?? '';
  const fmtRaw = fields.get('fmt');
  const format = fmtRaw !== undefined && (FORMATS as readonly string[]).includes(fmtRaw) ? (fmtRaw as QuoteFormat) : undefined;
  const file = fields.get('file');
  const lineMatch = /^(\d+)-(\d+)$/.exec(fields.get('lines') ?? '');
  return {
    id: 'q' + String(index + 1),
    source: { kind, session: '', turn: turnMatch ? Number(turnMatch[1]) : undefined, label },
    text,
    hash: '',
    bytes: utf8Bytes(text),
    truncated: fields.get('trunc') === '1',
    ...(format ? { format } : {}),
    ...(file !== undefined ? { filePath: decodeURIComponent(file) } : {}),
    ...(lineMatch ? { lineRange: { startLine: Number(lineMatch[1]), endLine: Number(lineMatch[2]) } } : {}),
  };
}

/**
 * 解析引用块：返回 quotes + rest（第一个合法块之前的正文，右去尾空白）。
 * 仅当「定界行 + [引用 …] header + 以 "> " 开头的正文 + 闭合定界行」齐全时才算块；
 * 无合法块时 rest === content（逐字不变）。
 */
export function parseQuoteBlocks(content: string): { quotes: QuoteRef[]; rest: string } {
  const lines = content.split('\n');
  const quotes: QuoteRef[] = [];
  let firstBlockAt = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== QUOTE_BLOCK_DELIMITER) {
      i += 1;
      continue;
    }
    const header = lines[i + 1];
    if (header === undefined || !/^\[引用 .*\]$/.test(header)) {
      i += 1;
      continue;
    }
    let j = i + 2;
    const body: string[] = [];
    let closed = false;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l === QUOTE_BLOCK_DELIMITER) {
        closed = true;
        break;
      }
      if (!l.startsWith('> ')) break;
      body.push(unescapeQuoteLine(l.slice(2)));
      j += 1;
    }
    if (!closed) {
      i += 1;
      continue;
    }
    if (firstBlockAt < 0) firstBlockAt = i;
    quotes.push(quoteFromHeader(header, body.join('\n'), quotes.length));
    i = j + 1;
  }
  if (firstBlockAt < 0) return { quotes: [], rest: content };
  return { quotes, rest: lines.slice(0, firstBlockAt).join('\n').replace(/\s+$/, '') };
}
