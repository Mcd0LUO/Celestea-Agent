// 纯函数：F1 引用块格式（零 DOM）。往返口径见 ui/quote/model.ts 头注：
// 文本级恒等 + wire 编码字段级恒等；id/hash/session/anchor/range 不入 wire。
import { describe, expect, it } from 'vitest';
import { at } from './lib/w795-dom.js';

interface QuoteSource { kind: string; session: string; turn?: number; label: string }
interface QuoteRef {
  id: string; source: QuoteSource; text: string; hash: string; bytes: number; truncated: boolean;
  format?: string; filePath?: string; lineRange?: { startLine: number; endLine: number };
}
interface QuoteInput {
  id: string; source: QuoteSource; text: string; hash: string;
  format?: string; filePath?: string; lineRange?: { startLine: number; endLine: number };
}
interface ModelMod {
  QUOTE_BLOCK_DELIMITER: string;
  QUOTE_ESCAPE_SUFFIX: string;
  QUOTE_MAX_BYTES: number;
  QUOTE_TOTAL_MAX_BYTES: number;
  utf8Bytes(s: string): number;
  sanitizeQuoteLabel(s: string): string;
  capQuote(text: string, maxBytes?: number): { text: string; truncated: boolean };
  hashQuote(text: string): Promise<string>;
  quoteDedupKey(q: { hash: string; text: string }): string;
  makeQuote(input: QuoteInput): QuoteRef;
  escapeQuoteLine(line: string): string;
  unescapeQuoteLine(line: string): string;
  serializeQuotes(text: string, quotes: readonly QuoteRef[]): string;
  parseQuoteBlocks(content: string): { quotes: QuoteRef[]; rest: string };
}

const load = async (): Promise<ModelMod> =>
  (await import(/* @vite-ignore */ at('ui/quote/model.ts'))) as ModelMod;

const src = (label: string, turn?: number, kind = 'assistant'): QuoteSource =>
  ({ kind, session: 'ws/s1', turn, label });

const mk = (m: ModelMod, text: string, over: Partial<QuoteInput> = {}): QuoteRef =>
  m.makeQuote({ id: 'q1', source: src('Studio', 3), text, hash: '', ...over });

describe('F1 · 引用块格式（纯函数）', () => {
  it('escape/unescape 是双射：含定界串、以后缀结尾、空行、CR', async () => {
    const m = await load();
    const cases = [
      '普通行', '', '  ', '含 ' + m.QUOTE_BLOCK_DELIMITER + ' 的行',
      m.QUOTE_BLOCK_DELIMITER, 'x' + m.QUOTE_ESCAPE_SUFFIX,
      '含 ' + m.QUOTE_BLOCK_DELIMITER + ' 且以 ' + m.QUOTE_ESCAPE_SUFFIX + ' 结尾',
      'line\rwith cr',
    ];
    for (const c of cases) expect(m.unescapeQuoteLine(m.escapeQuoteLine(c))).toBe(c);
  });

  it('quotes 为空时原样返回；无块时 parse 逐字返回', async () => {
    const m = await load();
    const base = '你好\n第二行';
    expect(m.serializeQuotes(base, [])).toBe(base);
    expect(m.parseQuoteBlocks(base)).toEqual({ quotes: [], rest: base });
  });

  it('文本级往返恒等 + rest 正确', async () => {
    const m = await load();
    const base = '请解释这段';
    const quotes = [
      mk(m, '第一行\n第二行'),
      mk(m, '代码\n' + m.QUOTE_BLOCK_DELIMITER + '\n尾', { format: 'code', filePath: '/a/b c.ts', lineRange: { startLine: 10, endLine: 20 } }),
      mk(m, '第三段', { source: src('你', undefined, 'user') }),
    ];
    const wire = m.serializeQuotes(base, quotes);
    const parsed = m.parseQuoteBlocks(wire);
    expect(parsed.quotes.length).toBe(3);
    expect(parsed.rest).toBe(base);
    expect(m.serializeQuotes(base, parsed.quotes)).toBe(wire);
  });

  it('字段级恒等（wire 编码字段）', async () => {
    const m = await load();
    const wire = m.serializeQuotes('', [mk(m, '正文', { format: 'markdown', filePath: '/x/文件 y.md', lineRange: { startLine: 2, endLine: 4 } })]);
    const got = m.parseQuoteBlocks(wire).quotes[0]!;
    expect(got.text).toBe('正文');
    expect(got.source.kind).toBe('assistant');
    expect(got.source.turn).toBe(3);
    expect(got.source.label).toBe('Studio');
    expect(got.truncated).toBe(false);
    expect(got.format).toBe('markdown');
    expect(got.filePath).toBe('/x/文件 y.md');
    expect(got.lineRange).toEqual({ startLine: 2, endLine: 4 });
  });

  it('伪造边界负例：正文定界行被转义；裸定界行不成块', async () => {
    const m = await load();
    const body = '前\n' + m.QUOTE_BLOCK_DELIMITER + '\n后';
    const wire = m.serializeQuotes('', [mk(m, body)]);
    expect(wire).toContain('> ' + m.QUOTE_BLOCK_DELIMITER + m.QUOTE_ESCAPE_SUFFIX);
    expect(m.parseQuoteBlocks(wire).quotes[0]?.text).toBe(body);
    const bare = 'x\n' + m.QUOTE_BLOCK_DELIMITER + '\ny';
    expect(m.parseQuoteBlocks(bare)).toEqual({ quotes: [], rest: bare });
  });

  it('capQuote 不劈码点；utf8Bytes 正确', async () => {
    const m = await load();
    expect(m.utf8Bytes('😀')).toBe(4);
    expect(m.utf8Bytes('中')).toBe(3);
    const capped = m.capQuote('😀'.repeat(3), 5);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('😀');
    expect(m.utf8Bytes(capped.text)).toBeLessThanOrEqual(5);
    expect(m.capQuote('中'.repeat(4), 5).text).toBe('中');
  });

  it('sanitizeQuoteLabel 幂等；hashQuote 是 sha256 hex；去重键', async () => {
    const m = await load();
    const dirty = 'a · b]c\nd';
    expect(m.sanitizeQuoteLabel(dirty)).toBe('a b)c d');
    expect(m.sanitizeQuoteLabel(m.sanitizeQuoteLabel(dirty))).toBe('a b)c d');
    const h = await m.hashQuote('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await m.hashQuote('abc')).toBe(h);
    expect(m.quoteDedupKey({ hash: h, text: 'abc' })).toBe(h);
    expect(m.quoteDedupKey({ hash: '', text: 'abc' })).toBe('x:abc');
  });

  it('超总量时显式截断（trunc=1），不静默丢块', async () => {
    const m = await load();
    const huge: QuoteRef = {
      id: 'q1', source: src('Studio', 1), text: 'a'.repeat(m.QUOTE_TOTAL_MAX_BYTES + 100),
      hash: '', bytes: 0, truncated: false,
    };
    const parsed = m.parseQuoteBlocks(m.serializeQuotes('', [huge])).quotes;
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.truncated).toBe(true);
    expect(m.utf8Bytes(parsed[0]!.text)).toBeLessThanOrEqual(m.QUOTE_TOTAL_MAX_BYTES);
  });
});
